// @ts-api-gateway/services/publishService.ts - 发布服务

import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis';
import { getPublisher } from '../platforms';
import { getTraceIdForJob } from '../middleware/trace';
import { createLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { PublishTask, PublishResult } from '../platforms/types';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('publish-service');

// ============================================================
// BullMQ 队列
// ============================================================

export const publishQueue = new Queue<PublishTask>('publish', {
  connection: getRedis(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 }, // 1min → 2min → 4min
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

// ============================================================
// BullMQ Worker
// ============================================================

export const publishWorker = new Worker<PublishTask>(
  'publish',
  async (job: Job<PublishTask>) => {
    const task = job.data;

    logger.info(`📤 发布任务开始: ${task.taskId} → ${task.platform}`);

    const publisher = getPublisher(task.platform);
    const result = await publisher.publish(task);

    // 记录到数据库
    await prisma.operationLog.create({
      data: {
        action: 'publish',
        details: JSON.stringify({ taskId: task.taskId, platform: task.platform, ...result }),
        userId: task.accountId,
        userName: task.credentials.username,
        result: result.success ? 'success' : 'failure',
        level: result.success ? 'info' : 'error',
      },
    });

    if (!result.success) {
      throw new Error(result.error || '发布失败');
    }

    logger.info(`✅ 发布任务完成: ${task.taskId} → ${task.platform} (${result.duration}ms)`);
    return result;
  },
  {
    connection: getRedis(),
    concurrency: 5, // 最多5个并发发布任务
    limiter: { max: 5, duration: 60_000 }, // 每分钟最多5个
  },
);

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
  const job = await publishQueue.add(task.platform, task, {
    jobId: task.taskId,
  });

  logger.info(`发布任务已入队: ${job.id} → ${task.platform}`);
  return { jobId: job.id! };
}
