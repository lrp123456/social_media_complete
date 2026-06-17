// @ts-api-gateway/services/unifiedQueue.ts - 统一执行队列
// 将监控(monitor)、发布(publish)、回复(reply)任务合并到同一 BullMQ 队列
// 确保同一浏览器窗口的任务串行执行（通过 WindowMutex 互斥）

import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis';
import { WindowMutex, abortPromise, type MutexHandle } from '../lib/redlock';
import { createLogger } from '../lib/logger';
import { getTraceId } from '../middleware/trace';
import type { PlatformName } from '@social-media/shared-config';
import type { PublishTask } from '../platforms/types';

const logger = createLogger('unified-queue');

// ============================================================
// 统一任务类型（discriminated union）
// ============================================================

export interface MonitorTaskData {
  taskType: 'monitor';
  taskId: string;
  userId: number;
  platform: PlatformName;
  windowId: string;
  fingerprintWindowId: string;
}

export interface PublishTaskData {
  taskType: 'publish';
  taskId: string;
  platform: PlatformName;
  windowId: string;
  // PublishTask 的完整字段
  publishPayload: PublishTask;
}

export interface ReplyTaskData {
  taskType: 'reply';
  taskId: string;
  userId: number;
  platform: PlatformName;
  windowId: string;
  fingerprintWindowId: string;
  replyData: { videoId: string; commentCid: string; text: string };
}

export type PlatformTask = MonitorTaskData | PublishTaskData | ReplyTaskData;

// ============================================================
// BullMQ 统一队列
// ============================================================

const QUEUE_NAME = 'platform';

export const platformQueue = new Queue<PlatformTask>(QUEUE_NAME, {
  connection: getRedis() as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 300_000 }, // 默认 5min 重试
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

// ============================================================
// 取消任务支持（从 monitorService 迁移）
// ============================================================

export const cancelledJobIds = new Set<string>();

export function markJobCancelled(bullJobId: string): void {
  cancelledJobIds.add(bullJobId);
  logger.info({ bullJobId }, '任务已标记为取消');
}

export function isJobCancelled(bullJobId: string): boolean {
  return cancelledJobIds.has(bullJobId);
}

export function cleanupCancelledJob(bullJobId: string): void {
  cancelledJobIds.delete(bullJobId);
}

// ============================================================
// 超时配置
// ============================================================

const MONITOR_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
const PUBLISH_TIMEOUT_MS = 15 * 60 * 1000;  // 15 分钟
const REPLY_TIMEOUT_MS = 5 * 60 * 1000;     // 5 分钟（回复任务最长 5 分钟）

// ============================================================
// BullMQ Worker（统一处理所有任务类型）
// ============================================================

export const platformWorker = new Worker<PlatformTask>(
  QUEUE_NAME,
  async (job: Job<PlatformTask>) => {
    const task = job.data;
    const bullJobId = job.id || `unknown_${Date.now()}`;

    // ── 回复任务 ──
    if (task.taskType === 'reply') {
      const { executeReplyAction } = await import('./monitorService');
      logger.info(`💬 回复任务开始: ${task.taskId} → ${task.platform}:${task.userId}`);

      let handle: MutexHandle | null = null;
      try {
        // ★ 锁获取不超时，只会排队等待（无限重试直到拿到锁）
        // 业务的等待时长由 BullMQ 的任务级 TTL 控制
        handle = await WindowMutex.acquireWithBackoff(task.windowId, {
          taskId: task.taskId,
          taskType: 'reply',
          traceId: getTraceId(),
        });

        // ★ 业务超时机制：5 分钟内必须完成，超时后业务被丢弃，但 finally 会主动释放锁
        // 这样即使业务卡住，也不会因为锁的 TTL 提前过期而导致并发操作
        await Promise.race([
          executeReplyAction(task, task.replyData),
          abortPromise(handle.signal),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`回复超时: 超过 ${REPLY_TIMEOUT_MS / 1000}s`)), REPLY_TIMEOUT_MS),
          ),
        ]);
        logger.info(`✅ 回复完成: ${task.taskId}`);
      } catch (err: any) {
        logger.error(`❌ 回复失败: ${task.taskId} - ${err.message}`);
        throw err;
      } finally {
        // ★ 业务完成（成功/失败/超时）后立刻主动释放锁
        if (handle) await handle.release().catch(() => {});
      }
      return;
    }

    // ── 发布任务 ──
    if (task.taskType === 'publish') {
      // 检查取消
      if (isJobCancelled(bullJobId)) {
        cleanupCancelledJob(bullJobId);
        return;
      }

      logger.info(`📤 发布任务开始: ${task.taskId} → ${task.platform}`);

      let handle: MutexHandle | null = null;
      try {
        handle = await WindowMutex.acquireWithBackoff(task.windowId, {
          taskId: task.taskId,
          taskType: 'publish',
          traceId: getTraceId(),
        });

        const { getPublisher } = await import('../platforms');
        const { prisma } = await import('../lib/prisma');

        const publisher = getPublisher(task.platform);
        const result = await Promise.race([
          publisher.publish(task.publishPayload, true), // skipLock=true: unifiedQueue 已持有锁
          abortPromise(handle.signal),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`发布超时: 超过 ${PUBLISH_TIMEOUT_MS / 1000}s`)), PUBLISH_TIMEOUT_MS),
          ),
        ]);

        // 记录到数据库
        await prisma.operationLog.create({
          data: {
            action: 'publish',
            details: JSON.stringify(result),
            userId: task.publishPayload.accountId,
            userName: task.publishPayload.credentials.username,
            result: result.success ? 'success' : 'failure',
            level: result.success ? 'info' : 'error',
          },
        });

        if (!result.success) {
          throw new Error(result.error || '发布失败');
        }

        logger.info(`✅ 发布完成: ${task.taskId} → ${task.platform} (${result.duration}ms)`);
        return result;
      } catch (err: any) {
        logger.error(`❌ 发布失败: ${task.taskId} - ${err.message}`);
        throw err;
      } finally {
        if (handle) await handle.release().catch(() => {});
      }
    }

    // ── 监控任务 ──
    if (task.taskType === 'monitor') {
      // 检查取消
      if (isJobCancelled(bullJobId)) {
        logger.info({ taskId: task.taskId, bullJobId }, '任务已被取消，跳过执行');
        cleanupCancelledJob(bullJobId);
        return;
      }

      logger.info(`🔍 监控任务开始: ${task.taskId} → ${task.platform}:${task.userId}`);

      const checkCancelled = () => {
        if (isJobCancelled(bullJobId)) {
          logger.info({ taskId: task.taskId, bullJobId }, '任务执行中被取消');
          cleanupCancelledJob(bullJobId);
          throw new Error('TASK_CANCELLED');
        }
      };

      let handle: MutexHandle | null = null;
      try {
        checkCancelled();
        await job.updateProgress({ phase: '等待', step: '正在获取窗口锁', percent: 5 });
        handle = await WindowMutex.acquireWithBackoff(task.windowId, {
          taskId: task.taskId,
          taskType: 'monitor',
          traceId: getTraceId(),
        });

        checkCancelled();
        const { executeMonitorCheck, reportMonitorComplete, sendMonitorNotification, generateSuggestionsForNewComments } = await import('./monitorService');
        const { prisma } = await import('../lib/prisma');
        const db = await import('./monitorDatabaseService');

        const onProgress = (p: { phase: string; step: string; percent: number; detail?: string }) => {
          checkCancelled();
          job.updateProgress(p).catch(() => {});
        };

        const result = await Promise.race([
          executeMonitorCheck(task, onProgress, checkCancelled),
          abortPromise(handle.signal),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`任务超时: 超过 ${MONITOR_TIMEOUT_MS / 1000}s`)), MONITOR_TIMEOUT_MS),
          ),
        ]);

        // 记录结果
        await prisma.operationLog.create({
          data: {
            action: 'monitor_check',
            details: JSON.stringify({
              hasUpdate: result.hasUpdate,
              newComments: result.newComments,
              updatedVideos: result.updatedVideos,
              phase: result.phase,
            }),
            userId: String(task.userId),
            userName: task.platform,
            result: result.riskDetected ? 'failure' : 'success',
            level: result.riskDetected ? 'error' : 'info',
          },
        });

        // 更新 MonitorStatus
        try {
          const videoCount = await prisma.video.count({ where: { userId: task.userId } });
          const totalComments = await prisma.video.aggregate({
            where: { userId: task.userId },
            _sum: { commentCount: true },
          });
          await db.updateMonitorStatus(
            task.userId,
            task.platform,
            videoCount,
            totalComments._sum.commentCount ?? 0,
            result.riskDetected ? 'failure' : 'success',
          );
        } catch (statusErr: any) {
          logger.warn({ err: statusErr.message }, '更新 MonitorStatus 失败（不影响主流程）');
        }

        if (result.hasUpdate) {
          logger.info(`✅ 监控: ${task.taskId} (${task.platform}) - ${result.newComments} 新评论, ${result.updatedVideos.length} 视频更新`);

          if (result.newComments > 0) {
            const phase3Result = (result as any)._phase3Result;
            const queue = (result as any)._queue || [];

            const user = await prisma.user.findUnique({ where: { id: task.userId } });
            const platformAuthorId = user?.platformAuthorId;

            const commentGroups = phase3Result?.results
              ?.filter((r: any) => r.success && r.commentGroups)
              ?.flatMap((r: any) =>
                r.commentGroups
                  .map((g: any) => {
                    const newSubReplies = g.newInGroup
                      .filter((n: any) => n.level === 2 && n.userUid !== platformAuthorId)
                      .map((n: any) => ({
                        cid: n.cid,
                        text: n.text,
                        userNickname: n.userNickname,
                        replyToName: n.replyToName,
                        createTime: n.createTime,
                      }));
                    const allSubReplies = [
                      ...g.subReplies.filter((s: any) => s.userUid !== platformAuthorId),
                      ...newSubReplies,
                    ];
                    const seenCids = new Set<string>();
                    const dedupedSubReplies = allSubReplies.filter((s: any) => {
                      if (seenCids.has(s.cid)) return false;
                      seenCids.add(s.cid);
                      return true;
                    });

                    return {
                      awemeId: r.awemeId,
                      description: queue.find((q: any) => q.awemeId === r.awemeId)?.description || '',
                      rootComment: g.rootComment,
                      subReplies: dedupedSubReplies,
                      newCids: new Set(
                        g.newInGroup
                          .filter((n: any) => n.userUid !== platformAuthorId)
                          .map((n: any) => n.cid)
                      ),
                    };
                  })
                  .filter((g: any) => g.newCids.size > 0)
              ) || [];

            if (commentGroups.length > 0) {
              await sendMonitorNotification(task.userId, task.platform, 'new_comments', {
                newComments: result.newComments,
                commentGroups,
              });
            } else {
              await sendMonitorNotification(task.userId, task.platform, 'new_comments', {
                newComments: result.newComments,
                commentGroups: [],
              });
            }

            generateSuggestionsForNewComments(task.userId, task.platform).catch((err) => {
              logger.warn({ err: err.message, userId: task.userId }, 'LLM 建议生成失败（非关键）');
            });
          }
        } else {
          logger.info(`✅ 监控: ${task.taskId} (${task.platform}) - 无更新`);
        }

        reportMonitorComplete(task.windowId, task.platform, result.hasUpdate);
      } catch (err: any) {
        logger.error(`❌ 监控失败: ${task.taskId} - ${err.message}`);
        const { reportMonitorComplete, sendMonitorNotification } = await import('./monitorService');
        const { prisma } = await import('../lib/prisma');

        await prisma.operationLog.create({
          data: {
            action: 'monitor_check',
            details: JSON.stringify({ error: err.message }),
            userId: String(task.userId),
            result: 'failure',
            level: 'error',
          },
        }).catch(() => {});

        reportMonitorComplete(task.windowId, task.platform, false);

        if (err.message?.includes('风控') || err.message?.includes('captcha') || err.message?.includes('验证码')) {
          await sendMonitorNotification(task.userId, task.platform, 'risk_detected').catch(() => {});
        }
      } finally {
        if (handle) {
          await handle.release().catch((releaseErr: any) => {
            logger.warn({ taskId: task.taskId, windowId: task.windowId, error: releaseErr.message }, '锁释放异常');
          });
        }
      }
    }
  },
  {
    connection: getRedis() as any,
    concurrency: 3,
    limiter: { max: 10, duration: 60_000 },
    // BullMQ 任务锁（与窗口锁 WindowMutex 不同）
    // 控制 Worker 多久没续约就把任务判定为 stalled 重新入队
    // 浏览器自动化操作（滚动、展开评论等）可能持续数分钟不调用 updateProgress
    // 设置 30 分钟匹配最长任务（兜底）
    lockDuration: 30 * 60 * 1000,
    stalledInterval: 120_000,
  },
);

// Worker 事件
platformWorker.on('completed', (job) => {
  logger.debug(`任务完成: ${job.id} (${job.data.taskType})`);
});

platformWorker.on('failed', (job, err) => {
  logger.error(`任务失败: ${job?.id} (${job?.data?.taskType}) - ${err.message}`);
});

platformWorker.on('stalled', (jobId) => {
  logger.warn(`任务停滞: ${jobId}`);
});

// ============================================================
// 入队辅助函数
// ============================================================

/** 入队监控任务 */
export async function enqueueMonitor(task: {
  taskId: string;
  userId: number;
  platform: PlatformName;
  windowId: string;
  fingerprintWindowId: string;
}, options?: { jobId?: string }): Promise<Job> {
  return platformQueue.add('monitor', {
    taskType: 'monitor',
    ...task,
  }, {
    jobId: options?.jobId || task.taskId,
    attempts: 2,
    backoff: { type: 'fixed', delay: 300_000 },
  });
}

/** 入队发布任务 */
export async function enqueuePublish(publishTask: PublishTask): Promise<Job> {
  return platformQueue.add('publish', {
    taskType: 'publish',
    taskId: publishTask.taskId,
    platform: publishTask.platform,
    windowId: publishTask.windowId,
    publishPayload: publishTask,
  }, {
    jobId: publishTask.taskId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
  });
}

/** 入队回复任务 */
export async function enqueueReply(task: {
  taskId: string;
  userId: number;
  platform: PlatformName;
  windowId: string;
  fingerprintWindowId: string;
  replyData: { videoId: string; commentCid: string; text: string };
}): Promise<Job> {
  return platformQueue.add('reply', {
    taskType: 'reply',
    ...task,
  }, {
    jobId: task.taskId,
    attempts: 1, // 回复不重试
  });
}

// ============================================================
// 向后兼容别名
// ============================================================

/** @deprecated 使用 platformQueue 代替 */
export const monitorQueue = platformQueue;

/** @deprecated 使用 platformQueue 代替 */
export const publishQueue = platformQueue;
