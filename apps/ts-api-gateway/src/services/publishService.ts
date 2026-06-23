// @ts-api-gateway/services/publishService.ts - 发布服务

import { getPublisher } from '../platforms';
import { createLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { enqueuePublish } from './unifiedQueue';
import type { PublishTask, PublishResult } from '../platforms/types';

const logger = createLogger('publish-service');

// ============================================================
// 监控回调定时器（Webhook 超时补兜）
// ============================================================

const PENDING_TIMEOUT = 600_000; // 10 分钟未回调视为超时

/**
 * 定期检查超时未完成的 Python 任务
 * 通过 trace_id 全链路追溯
 */
export function startTimeoutMonitor(intervalMs = 600_000): void {
  setInterval(async () => {
    try {
      const threshold = new Date(Date.now() - PENDING_TIMEOUT);
      const staleTasks = await prisma.taskRecord.findMany({
        where: {
          status: 'pending',
          createdAt: { lt: threshold },
        },
      });

      for (const task of staleTasks) {
        logger.warn(`⏰ 任务超时: ${task.taskId} (${task.taskType})`);
        await prisma.taskRecord.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            error: `Timeout: ${PENDING_TIMEOUT}ms exceeded`,
          },
        });
      }
    } catch (err) {
      logger.error('超时监控检查失败:', (err as Error).message);
    }
  }, intervalMs);

  logger.info(`超时监控已启动 (间隔: ${intervalMs}ms)`);
}

// ============================================================
// API: 提交发布任务
// ============================================================

export async function submitPublishTask(task: PublishTask): Promise<{ jobId: string }> {
  const job = await enqueuePublish(task);

  logger.info(`发布任务已入队: ${job.id} → ${task.platform}`);
  return { jobId: job.id! };
}
