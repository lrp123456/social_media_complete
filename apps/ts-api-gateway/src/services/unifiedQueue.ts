// @ts-api-gateway/services/unifiedQueue.ts - 统一执行队列
// 每窗口独立队列 + 独立 Worker，保证窗口间完全独立、窗口内串行

import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis';
import { WindowMutex, type MutexHandle } from '../lib/redlock';
import { createLogger } from '../lib/logger';
import { getTraceId } from '../middleware/trace';
import type { PlatformName } from '@social-media/shared-config';
import type { PublishTask } from '../platforms/types';
import { startExecution, updatePhase, finishExecution } from '../lib/taskExecutionRecorder';

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
// Per-Window 队列管理
// ============================================================

const queues = new Map<string, Queue<PlatformTask>>();
const workers = new Map<string, Worker<PlatformTask>>();
const pendingQueues = new Map<string, Promise<Queue<PlatformTask>>>();

const defaultJobOptions = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 300_000 },
  removeOnComplete: 100,
  removeOnFail: 200,
};

export async function getWindowQueue(windowId: string): Promise<Queue<PlatformTask>> {
  if (queues.has(windowId)) return queues.get(windowId)!;
  if (!pendingQueues.has(windowId)) {
    pendingQueues.set(windowId, (async () => {
      const name = `platform-${windowId}`;
      const q = new Queue<PlatformTask>(name, {
        connection: getRedis() as any,
        defaultJobOptions,
      });
      queues.set(windowId, q);
      createWindowWorker(windowId, q);
      pendingQueues.delete(windowId);
      return q;
    })());
  }
  return pendingQueues.get(windowId)!;
}

export async function destroyWindowQueue(windowId: string): Promise<void> {
  const worker = workers.get(windowId);
  if (worker) {
    await worker.close();
    workers.delete(windowId);
  }
  const q = queues.get(windowId);
  if (q) {
    await q.close();
    queues.delete(windowId);
  }
}

export function getAllWindowQueues(): Map<string, Queue<PlatformTask>> {
  return queues;
}

export async function findJobByTaskId(taskId: string): Promise<Job | null> {
  for (const q of queues.values()) {
    const job = await q.getJob(taskId).catch(() => null);
    if (job) return job;
  }
  return null;
}

// ============================================================
// 取消任务支持
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

const MONITOR_TIMEOUT_MS = 10 * 60 * 1000;
const PUBLISH_TIMEOUT_MS = 15 * 60 * 1000;
const REPLY_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
// Worker handler（统一处理所有任务类型）
// ============================================================

async function handleJob(job: Job<PlatformTask>): Promise<any> {
  const task = job.data;
  const bullJobId = job.id || `unknown_${Date.now()}`;

  // ── 回复任务 ──
  if (task.taskType === 'reply') {
    const { executeReplyAction } = await import('./monitorService');
    logger.info(`💬 回复任务开始: ${task.taskId} → ${task.platform}:${task.userId}`);

    let handle: MutexHandle | null = null;
    let executionId: string | undefined;
    try {
      executionId = await startExecution(task, job);
      handle = await WindowMutex.tryAcquireOnce(task.windowId, {
        taskId: task.taskId,
        taskType: 'reply',
        traceId: getTraceId(),
      });

      await Promise.race([
        executeReplyAction(task, task.replyData, executionId!),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`回复超时: 超过 ${REPLY_TIMEOUT_MS / 1000}s`)), REPLY_TIMEOUT_MS),
        ),
      ]);
      if (executionId) await finishExecution(executionId, 'completed');
      logger.info(`✅ 回复完成: ${task.taskId}`);
    } catch (err: any) {
      if (executionId) await finishExecution(executionId, 'failed', err.message).catch(() => {});
      logger.error(`❌ 回复失败: ${task.taskId} - ${err.message}`);
      throw err;
    } finally {
      if (handle) await handle.release().catch(() => {});
    }
    return;
  }

  // ── 发布任务 ──
  if (task.taskType === 'publish') {
    if (isJobCancelled(bullJobId)) {
      cleanupCancelledJob(bullJobId);
      return;
    }

    logger.info(`📤 发布任务开始: ${task.taskId} → ${task.platform}`);

    let handle: MutexHandle | null = null;
    let executionId: string | undefined;
    try {
      executionId = await startExecution(task, job);
      if (executionId) await updatePhase(executionId, 1, '登录', 10);
      handle = await WindowMutex.tryAcquireOnce(task.windowId, {
        taskId: task.taskId,
        taskType: 'publish',
        traceId: getTraceId(),
      });

      const { getPublisher } = await import('../platforms');
      const { prisma } = await import('../lib/prisma');

      const publisher = getPublisher(task.platform);
      if (executionId) await updatePhase(executionId, 2, '上传', 40);
      const result = await Promise.race([
        publisher.publish(task.publishPayload, true),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`发布超时: 超过 ${PUBLISH_TIMEOUT_MS / 1000}s`)), PUBLISH_TIMEOUT_MS),
        ),
      ]);

      if (executionId) await updatePhase(executionId, 3, '填写信息', 70);

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

      if (executionId) await updatePhase(executionId, 4, '发布确认', 95);

      if (!result.success) {
        throw new Error(result.error || '发布失败');
      }

      if (executionId) await finishExecution(executionId, 'completed');
      logger.info(`✅ 发布完成: ${task.taskId} → ${task.platform} (${result.duration}ms)`);
      return result;
    } catch (err: any) {
      if (executionId) await finishExecution(executionId, 'failed', err.message).catch(() => {});
      logger.error(`❌ 发布失败: ${task.taskId} - ${err.message}`);
      throw err;
    } finally {
      if (handle) await handle.release().catch(() => {});
    }
  }

  // ── 监控任务 ──
  if (task.taskType === 'monitor') {
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
    let executionId: string | undefined;
    try {
      executionId = await startExecution(task, job);
      checkCancelled();
      await job.updateProgress({ phase: '等待', step: '正在获取窗口锁', percent: 5 });
      handle = await WindowMutex.tryAcquireOnce(task.windowId, {
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
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`任务超时: 超过 ${MONITOR_TIMEOUT_MS / 1000}s`)), MONITOR_TIMEOUT_MS),
        ),
      ]);

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
          Number(totalComments._sum.commentCount ?? 0),
          result.riskDetected ? 'failure' : 'success',
        );
      } catch (statusErr: any) {
        logger.warn({ err: statusErr.message }, '更新 MonitorStatus 失败（不影响主流程）');
      }

      if (result.hasUpdate) {
        logger.info(`✅ 监控: ${task.taskId} (${task.platform}) - ${result.newComments} 新评论, ${result.updatedVideos.length} 视频更新`);

        const phase3Result = (result as any)._phase3Result;
        const queue = (result as any)._queue || [];
        const hasFirstCrawlGroups = phase3Result?.results?.some((r: any) =>
          r.success && r.commentGroups && r.commentGroups.length > 0
        ) ?? false;

        const queueItemId = (q: any): string | undefined => q.awemeId ?? q.exportId;

        if (result.newComments > 0 || hasFirstCrawlGroups) {
          const commentGroups = phase3Result?.results
            ?.filter((r: any) => r.success && r.commentGroups)
            ?.flatMap((r: any) =>
              r.commentGroups
                .map((g: any) => {
                  const newSubReplies = g.newInGroup
                    .filter((n: any) => n.level === 2 && !n.isAuthor)
                    .map((n: any) => ({
                      cid: n.cid,
                      text: n.text,
                      userNickname: n.userNickname,
                      replyToName: n.replyToName,
                      createTime: n.createTime,
                    }));
                  const allSubReplies = [
                    ...g.subReplies.filter((s: any) => !s.isAuthor),
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
                    description: queue.find((q: any) => queueItemId(q) === r.awemeId)?.description || '',
                    rootComment: g.rootComment,
                    subReplies: dedupedSubReplies,
                    newCids: new Set(
                      g.newInGroup
                        .filter((n: any) => !n.isAuthor)
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

          generateSuggestionsForNewComments(task.userId, task.platform).catch((err: any) => {
            logger.warn({ err: err.message, userId: task.userId }, 'LLM 建议生成失败（非关键）');
          });
        }
      } else {
        logger.info(`✅ 监控: ${task.taskId} (${task.platform}) - 无更新`);
      }

      reportMonitorComplete(task.windowId, task.platform, result.hasUpdate);
      if (executionId) await finishExecution(executionId, 'completed');
    } catch (err: any) {
      if (executionId) await finishExecution(executionId, 'failed', err.message).catch(() => {});
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
}

// ============================================================
// Per-Window Worker 创建
// ============================================================

function createWindowWorker(windowId: string, queue: Queue<PlatformTask>): Worker<PlatformTask> {
  const worker = new Worker<PlatformTask>(queue.name, handleJob, {
    connection: getRedis() as any,
    concurrency: 1,
    lockDuration: 30 * 60 * 1000,
    stalledInterval: 120_000,
  });

  worker.on('completed', (job) => {
    logger.debug(`任务完成: ${job.id} (${job.data.taskType}) [窗口: ${windowId}]`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`任务失败: ${job?.id} (${job?.data?.taskType}) [窗口: ${windowId}] - ${err.message}`);
  });

  worker.on('stalled', (jobId) => {
    logger.warn(`任务停滞: ${jobId} [窗口: ${windowId}]`);
  });

  // 启动清理：移除上一轮遗留的 active jobs
  worker.on('ready', async () => {
    try {
      const redis = getRedis();
      const queueName = `platform-${windowId}`;
      const activeKey = `bull:${queueName}:active`;
      const stalledKey = `bull:${queueName}:stalled`;

      const staleJobIds = await redis.lrange(activeKey, 0, -1);
      if (staleJobIds.length === 0) {
        logger.info({ windowId }, '[启动清理] active list 为空，无需清理');
        return;
      }

      logger.info({ windowId, count: staleJobIds.length, jobIds: staleJobIds }, '[启动清理] 发现遗留 active jobs');

      for (const jobId of staleJobIds) {
        try {
          await redis.lrem(activeKey, 1, jobId);
          const jobKey = `bull:${queueName}:${jobId}`;
          const jobData = await redis.hgetall(jobKey);
          if (jobData && Object.keys(jobData).length > 0) {
            await redis.hset(jobKey, 'failedReason', JSON.stringify({
              error: 'Worker restarted — job was stale in active list',
              cleanedAt: Date.now(),
            }));
          }
          logger.info({ windowId, jobId }, '[启动清理] 已从 active list 移除');
        } catch (cleanErr: any) {
          logger.warn({ windowId, jobId, err: cleanErr.message }, '[启动清理] 清理单个 job 失败');
        }
      }

      for (const jobId of staleJobIds) {
        await redis.srem(stalledKey, jobId).catch(() => {});
      }

      logger.info({ windowId, cleaned: staleJobIds.length }, '[启动清理] 完成');
    } catch (err: any) {
      logger.error({ windowId, err: err.message }, '[启动清理] 失败');
    }
  });

  workers.set(windowId, worker);
  logger.info({ windowId, queueName: queue.name }, 'Worker 已创建');
  return worker;
}

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
  const q = await getWindowQueue(task.windowId);
  return q.add('monitor', {
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
  const q = await getWindowQueue(publishTask.windowId);
  return q.add('publish', {
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
  const q = await getWindowQueue(task.windowId);
  return q.add('reply', {
    taskType: 'reply',
    ...task,
  }, {
    jobId: task.taskId,
    attempts: 1,
  });
}

// ============================================================
// 聚合查询（用于 API 展示）
// ============================================================

/** 跨所有窗口队列聚合查询 jobs */
export async function getAllJobs(states: ('active' | 'waiting' | 'delayed')[]): Promise<Job<PlatformTask>[]> {
  const allJobs: Job<PlatformTask>[] = [];
  for (const q of queues.values()) {
    try {
      const jobs = await q.getJobs(states);
      allJobs.push(...jobs);
    } catch (err) {
      logger.warn({ err }, '聚合 job 查询跳过失败队列');
    }
  }
  return allJobs;
}
