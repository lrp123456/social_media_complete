// materialUpdateScheduler.ts — cron 调度器（cron-parser + setTimeout，参照 monitorService 模式）
// PR2: + _pending 孤儿文件每日清理（04:00）
import fs from 'fs';
import path from 'path';
import cronParser from 'cron-parser';
import { logger } from '../lib/logger';
import { getMaterialUpdateConfig } from './materialUpdateConfig';
import { runMaterialUpdate, isRunning } from './materialUpdateService';
import { prisma } from '../lib/prisma';

const timers: ReturnType<typeof setTimeout>[] = [];
const allCooldownRetryTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
const cleanupTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };

/**
 * 计算多个 cron 表达式中最近的下一次执行时间。
 */
function getNextRunTime(cronExpressions: string[]): Date | null {
  let earliest: Date | null = null;
  for (const expr of cronExpressions) {
    try {
      const interval = cronParser.parse(expr);
      const next = interval.next().toDate();
      if (!earliest || next < earliest) {
        earliest = next;
      }
    } catch (err) {
      logger.error(`[materialScheduler] 无效 cron 表达式: ${expr} - ${err}`);
    }
  }
  return earliest;
}

/**
 * 注册下一次执行。
 */
function scheduleNext(): void {
  const config = getMaterialUpdateConfig();
  if (!config.schedule.enabled) {
    logger.info('[materialScheduler] 调度未启用，不注册下次执行');
    return;
  }

  const nextRun = getNextRunTime(config.schedule.cron);
  if (!nextRun) {
    logger.warn('[materialScheduler] 无有效 cron 表达式，不注册下次执行');
    return;
  }

  const delay = nextRun.getTime() - Date.now();
  if (delay < 0) {
    // 已过期，立即执行
    logger.info('[materialScheduler] cron 时间已过期，立即执行');
    triggerRun();
    return;
  }

  const timer = setTimeout(() => {
    triggerRun();
  }, delay);

  timers.push(timer);
  logger.info(`[materialScheduler] 下次执行: ${nextRun.toISOString()} (${Math.round(delay / 1000)}s 后)`);
}

/**
 * 触发一次执行，执行完后注册下一次。
 */
async function triggerRun(): Promise<void> {
  if (isRunning()) {
    logger.warn('[materialScheduler] 上次执行仍在运行，跳过');
    scheduleNext();
    return;
  }

  try {
    await runMaterialUpdate();

    // 检查是否所有平台 key 全冷却，如果是则安排自动重试
    const config = getMaterialUpdateConfig();
    const now = Date.now();
    const allCooledDown = config.platforms
      .filter((p) => p.enabled)
      .every((p) => {
        const state = config.keyCooldownState[p.id] || {};
        return p.keyPool.keys.every((k) => {
          const expiry = state[k];
          return expiry && expiry > now;
        });
      });

    if (allCooledDown && config.platforms.some((p) => p.enabled)) {
      logger.info(`[materialScheduler] 所有平台 key 全冷却，${config.allCooldownRetryAfterMs}ms 后自动重试`);
      if (allCooldownRetryTimer.current) clearTimeout(allCooldownRetryTimer.current);
      allCooldownRetryTimer.current = setTimeout(() => {
        allCooldownRetryTimer.current = null;
        triggerRun();
      }, config.allCooldownRetryAfterMs);
    }
  } catch (err) {
    logger.error(`[materialScheduler] 执行失败: ${err}`);
  }

  scheduleNext();
}

// ============================================================
// PR2: _pending 孤儿文件清理（每天 04:00 执行一次）
// ============================================================

/**
 * 扫描 _pending 目录，清理超过 7 天的孤儿文件。
 */
async function cleanupPendingFiles(): Promise<void> {
  const config = getMaterialUpdateConfig();
  if (!config.storage.enabled || !config.storage.rootPath) {
    logger.info('[materialScheduler] 存储未启用，跳过 _pending 清理');
    return;
  }

  const rootPath = config.storage.rootPath;
  const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  logger.info('[materialScheduler] 开始 _pending 清理（7天阈值）');

  // 遍历 rootPath 下各平台的 _pending 目录
  for (const platform of config.platforms) {
    const pendingDir = path.join(rootPath, platform.id, '_pending');
    let dateDirs: string[];
    try {
      dateDirs = await fs.promises.readdir(pendingDir, { withFileTypes: true }).then(
        (entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name),
      );
    } catch {
      // 目录不存在则跳过
      continue;
    }

    for (const dateStr of dateDirs) {
      const dateDir = path.join(pendingDir, dateStr);
      let files: string[];
      try {
        files = await fs.promises.readdir(dateDir);
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(dateDir, file);
        const relativePath = path.join(platform.id, '_pending', dateStr, file);

        // 检查文件 mtime 是否超过 7 天
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtime > cutoffDate) continue; // 未过期，跳过
        } catch {
          continue; // 无法读取 stat，跳过
        }

        // 查询 DB 对应记录
        const videoId = file.replace(/\.mp4$/i, '');
        try {
          const candidate = await prisma.hotVideoCandidate.findUnique({
            where: { uq_hot_video_platform_video: { platform: platform.id, videoId } },
          });

          if (candidate && candidate.storageStatus === 'pending_downloaded') {
            const fetchedAt = candidate.fetchedAt;
            if (fetchedAt > cutoffDate) continue; // 未过期

            // 过期清理：删除文件 + 更新 DB
            await fs.promises.unlink(filePath);
            await prisma.hotVideoCandidate.update({
              where: { id: candidate.id },
              data: {
                storageStatus: 'none',
                storagePath: null,
                failReason: 'pending_cleanup_expired',
              },
            });
            logger.info(`[materialScheduler] _pending 清理: ${relativePath} (DB 记录过期)`);
          } else {
            // DB 中无对应记录或状态已变更，直接删除文件
            await fs.promises.unlink(filePath);
            logger.info(`[materialScheduler] _pending 清理: ${relativePath} (孤儿文件)`);
          }
        } catch (err: any) {
          // DB 查询出错，仍尝试删除文件
          if (err.code !== 'ENOENT') {
            try {
              await fs.promises.unlink(filePath);
              logger.info(`[materialScheduler] _pending 清理: ${relativePath} (DB 查询失败，强制删除)`);
            } catch {
              logger.warn(`[materialScheduler] _pending 清理: ${relativePath} 删除失败`);
            }
          }
        }
      }

      // 尝试删除空目录
      try {
        const remaining = await fs.promises.readdir(dateDir);
        if (remaining.length === 0) {
          await fs.promises.rmdir(dateDir);
        }
      } catch {
        // 忽略
      }
    }
  }

  logger.info('[materialScheduler] _pending 清理完成');
}

/**
 * 注册清理定时器（每天 04:00）。
 */
function scheduleCleanup(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const delay = next.getTime() - now.getTime();
  cleanupTimer.current = setTimeout(async () => {
    try {
      await cleanupPendingFiles();
    } catch (err) {
      logger.error(`[materialScheduler] _pending 清理失败: ${err}`);
    }
    // 注册下一次
    cleanupTimer.current = null;
    scheduleCleanup();
  }, delay);

  logger.info(`[materialScheduler] 下次 _pending 清理: ${next.toISOString()} (${Math.round(delay / 1000)}s 后)`);
}

/**
 * 清除所有定时器。
 */
function clearAllTimers(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.length = 0;
  if (allCooldownRetryTimer.current) {
    clearTimeout(allCooldownRetryTimer.current);
    allCooldownRetryTimer.current = null;
  }
  if (cleanupTimer.current) {
    clearTimeout(cleanupTimer.current);
    cleanupTimer.current = null;
  }
}

/**
 * 启动调度器（应用启动时调用）。
 */
export function startMaterialUpdateScheduler(): void {
  const config = getMaterialUpdateConfig();
  if (!config.schedule.enabled) {
    logger.info('[materialScheduler] 调度未启用，跳过启动');
    return;
  }
  logger.info('[materialScheduler] 启动调度器');
  scheduleNext();
  scheduleCleanup();
}

/**
 * 重载调度器（配置变更后调用，参照 restartMonitorScheduler 模式）。
 */
export function reloadMaterialUpdateScheduler(): void {
  clearAllTimers();
  startMaterialUpdateScheduler();
}

/**
 * 停止调度器（graceful shutdown 时调用）。
 */
export function stopMaterialUpdateScheduler(): void {
  clearAllTimers();
  logger.info('[materialScheduler] 调度器已停止');
}
