// materialUpdateScheduler.ts — cron 调度器（cron-parser + setTimeout，参照 monitorService 模式）
import cronParser from 'cron-parser';
import { logger } from '../lib/logger';
import { getMaterialUpdateConfig } from './materialUpdateConfig';
import { runMaterialUpdate, isRunning } from './materialUpdateService';

const timers: ReturnType<typeof setTimeout>[] = [];
const allCooldownRetryTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };

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
