// cleanupService.ts - 每日自动清理过期的 TaskExecution 记录和调试快照
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import fs from 'fs';
import path from 'path';

const logger = createLogger('cleanup');
const DEBUG_DIR = path.resolve(process.cwd(), 'data', 'reply_debug');
const RETENTION_DAYS = 10;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每天一次

async function cleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // 清理 DB 记录（TaskExecutionStep 通过 onDelete: Cascade 自动删除）
  const deleted = await prisma.taskExecution.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  logger.info({ deletedCount: deleted.count, cutoff }, '清理过期 TaskExecution 记录');

  // 清理快照目录
  try {
    if (fs.existsSync(DEBUG_DIR)) {
      const dirs = fs.readdirSync(DEBUG_DIR);
      let removedDirs = 0;
      for (const dir of dirs) {
        const dirPath = path.join(DEBUG_DIR, dir);
        try {
          const stat = fs.statSync(dirPath);
          if (stat.isDirectory() && stat.mtime < cutoff) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            removedDirs++;
          }
        } catch {}
      }
      logger.info({ removedDirs, cutoff }, '清理过期快照目录');
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, '清理快照目录失败');
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startCleanupScheduler(): void {
  logger.info('启动每日清理定时器');
  // 启动后先执行一次
  cleanup().catch(err => logger.error({ err: err.message }, '初始清理失败'));
  intervalHandle = setInterval(() => {
    cleanup().catch(err => logger.error({ err: err.message }, '定时清理失败'));
  }, CLEANUP_INTERVAL_MS);
}

export function stopCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
