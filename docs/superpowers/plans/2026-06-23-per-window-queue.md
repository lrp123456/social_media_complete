# Per-Window Queue 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 BullMQ 从单共享队列改为每窗口独立队列+独立 Worker，彻底消除窗口间任务饿死问题

**架构：** 每个 `windowId` 创建一个独立的 `Queue('platform:{windowId}')` + `Worker('platform:{windowId}')`，Worker `concurrency: 1` 保证窗口内串行，窗口间完全独立。WindowMutex 从必需品变为安全网（`tryAcquireOnce` 非阻塞）。

**技术栈：** BullMQ, ioredis, Redlock, Prisma, Express

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | **核心** — 队列管理、入队函数、Worker 创建、启动清理 |
| `apps/ts-api-gateway/src/lib/redlock.ts` | 新增 `tryAcquireOnce` 方法 |
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | Worker handler 改用 `tryAcquireOnce` |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 调度器去重改为查窗口队列，删 monitorQueue re-export |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | 3 处 platformQueue.add → enqueueMonitor() |
| `apps/ts-api-gateway/src/services/publishService.ts` | 删 publishQueue re-export |
| `apps/ts-api-gateway/src/routes/matrix.ts` | 所有队列 API 改为遍历窗口队列 |

---

### 任务 1：unifiedQueue.ts 核心重写

**文件：**
- 修改：`apps/ts-api-gateway/src/services/unifiedQueue.ts`

- [ ] **步骤 1：读取当前文件全文**

运行：`cat apps/ts-api-gateway/src/services/unifiedQueue.ts | wc -l`
确认文件 536 行，了解完整结构。

- [ ] **步骤 2：替换队列为 Map + getWindowQueue / destroyWindowQueue / getAllWindowQueues / findJobByTaskId**

将文件开头到 line 65（`platformQueue` 创建）替换为：

```typescript
// @ts-api-gateway/services/unifiedQueue.ts - 统一执行队列
// 每窗口独立队列 + 独立 Worker，保证窗口间完全独立、窗口内串行

import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis';
import { WindowMutex, abortPromise, type MutexHandle } from '../lib/redlock';
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
      const name = `platform:${windowId}`;
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
```

- [ ] **步骤 3：保留 cancelledJobIds 区域不变（原 line 66-83）**

确认 `cancelledJobIds`、`markJobCancelled`、`isJobCancelled`、`cleanupCancelledJob` 保持原样。

- [ ] **步骤 4：删除废弃别名**

删除文件末尾的：
```typescript
/** @deprecated 使用 platformQueue 代替 */
export const monitorQueue = platformQueue;

/** @deprecated 使用 platformQueue 代替 */
export const publishQueue = platformQueue;
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "refactor: unifiedQueue 核心 — per-window 队列 Map + getWindowQueue/destroyWindowQueue/findJobByTaskId"
```

---

### 任务 2：redlock.ts — 新增 tryAcquireOnce

**文件：**
- 修改：`apps/ts-api-gateway/src/lib/redlock.ts:262`（`acquireWithBackoff` 方法之后）

- [ ] **步骤 1：读取当前文件**

确认 `acquireWithBackoff` 方法结束于 line 262，`inspect` 方法开始于 line 268。

- [ ] **步骤 2：在 acquireWithBackoff 和 inspect 之间插入 tryAcquireOnce**

在 line 262 之后（`acquireWithBackoff` 的闭合 `}` 之后）插入：

```typescript
  // ------------------------------------------------------------
  // 公开：tryAcquireOnce（非阻塞，用于 per-window 队列安全网）
  // ------------------------------------------------------------

  static async tryAcquireOnce(windowId: string, owner: LockOwner): Promise<MutexHandle | null> {
    try {
      const lock = await WindowMutex.tryAcquire(windowId);
      try {
        await WindowMutex.writeOwnerHash(windowId, owner);
      } catch (writeErr) {
        await lock.release().catch(() => {});
        throw writeErr;
      }

      let released = false;
      const handle: MutexHandle = {
        windowId,
        owner,
        signal: AbortSignal.abort(), // 无心跳，signal 不会触发，仅满足接口
        acquiredAt: Date.now(),
        async release() {
          if (released) return;
          released = true;
          await WindowMutex.delOwnerHash(windowId).catch(() => {});
          try {
            await lock.release();
            console.log(`[Redlock] 🔓 窗口锁已释放: ${windowId}`);
          } catch (err) {
            console.warn(`[Redlock] ⚠️ 窗口锁释放异常: ${windowId}`, (err as Error).message);
          }
        },
      };

      return handle;
    } catch {
      return null;
    }
  }
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/lib/redlock.ts
git commit -m "feat: redlock tryAcquireOnce — 非阻塞获取锁，用于 per-window 队列安全网"
```

---

### 任务 3：unifiedQueue.ts — Worker handler 改造

**文件：**
- 修改：`apps/ts-api-gateway/src/services/unifiedQueue.ts`（Worker handler 部分）

- [ ] **步骤 1：创建 createWindowWorker 函数**

在 `findJobByTaskId` 之后、`cancelledJobIds` 之前插入：

```typescript
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
                    description: queue.find((q: any) => q.awemeId === r.awemeId)?.description || '',
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
      const queueName = `platform:${windowId}`;
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
```

- [ ] **步骤 4：保留入队函数（enqueueMonitor / enqueuePublish / enqueueReply）**

将原来的入队函数中的 `platformQueue.add` 改为 `getWindowQueue(task.windowId).then(q => q.add(...))`。
由于 `getWindowQueue` 现在是 async，入队函数也需要是 async（已经是）。

替换三个入队函数：

```typescript
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
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "refactor: Worker handler 改用 tryAcquireOnce + createWindowWorker + BigInt 修复"
```

---

### 任务 4：monitorService.ts 调度器去重

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：更新 import**

将 line 12-18 的 import 从：
```typescript
import {
  monitorQueue,
  enqueueMonitor,
  cancelledJobIds,
  markJobCancelled,
  isJobCancelled,
  cleanupCancelledJob,
} from './unifiedQueue';
```

改为：
```typescript
import {
  getWindowQueue,
  enqueueMonitor,
  cancelledJobIds,
  markJobCancelled,
  isJobCancelled,
  cleanupCancelledJob,
} from './unifiedQueue';
```

- [ ] **步骤 2：更新 runOneSchedule 去重逻辑**

将 line 1726-1749 的去重代码从：
```typescript
const [activeJobs, waitingJobs] = await Promise.all([
  monitorQueue.getJobs(['active']),
  monitorQueue.getJobs(['waiting']),
]);
const redis = getRedis();
const activeUserIds = new Set<number>();
for (const j of [...activeJobs, ...waitingJobs]) {
  const data = j.data as any;
  if (!data?.userId) continue;
  if (!await j.isActive()) {
    activeUserIds.add(data.userId);
    continue;
  }
  const lockKey = `bull:platform:${j.id}:lock`;
  const hasLock = await redis.exists(lockKey);
  if (hasLock) {
    activeUserIds.add(data.userId);
  } else {
    logger.debug({ jobId: j.id, userId: data.userId }, '[调度] 跳过无锁 active job（疑似 stale）');
  }
}
```

改为：
```typescript
const q = await getWindowQueue(windowId);
const [activeJobs, waitingJobs] = await Promise.all([
  q.getJobs(['active']),
  q.getJobs(['waiting']),
]);
const activeUserIds = new Set<number>();
for (const j of [...activeJobs, ...waitingJobs]) {
  const data = j.data as any;
  if (!data?.userId) continue;
  if (await j.isActive() || await j.isWaiting()) {
    activeUserIds.add(data.userId);
  }
}
```

- [ ] **步骤 3：删除 monitorQueue re-export**

删除 line 883：
```typescript
export { cancelledJobIds, markJobCancelled, isJobCancelled, cleanupCancelledJob, monitorQueue };
```

改为：
```typescript
export { cancelledJobIds, markJobCancelled, isJobCancelled, cleanupCancelledJob };
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor: monitorService 调度器去重改为查窗口队列 + 删 monitorQueue re-export"
```

---

### 任务 5：wechatBotService.ts + publishService.ts 收敛

**文件：**
- 修改：`apps/ts-api-gateway/src/services/wechatBotService.ts`
- 修改：`apps/ts-api-gateway/src/services/publishService.ts`

- [ ] **步骤 1：wechatBotService.ts — 位置 1 (line 692)**

将：
```typescript
const { platformQueue } = await import('./unifiedQueue');
await platformQueue.add('monitor', {
  taskType: 'monitor', taskId: `retry_${Date.now()}_${targetUserId}`,
  userId: targetUserId, platform: targetPlatform as any,
  windowId, fingerprintWindowId: user.fingerprintWindowId,
});
```

改为：
```typescript
const { enqueueMonitor } = await import('./unifiedQueue');
await enqueueMonitor({
  taskId: `retry_${Date.now()}_${targetUserId}`,
  userId: targetUserId,
  platform: targetPlatform as any,
  windowId,
  fingerprintWindowId: user.fingerprintWindowId,
});
```

- [ ] **步骤 2：wechatBotService.ts — 位置 2 (line 717)**

将：
```typescript
const { platformQueue } = await import('./unifiedQueue');
await platformQueue.add('monitor', { taskType: 'monitor', taskId: `manual_${Date.now()}_${targetUserId}`, userId: targetUserId, platform: targetPlatform as any, windowId, fingerprintWindowId: user.fingerprintWindowId });
```

改为：
```typescript
const { enqueueMonitor } = await import('./unifiedQueue');
await enqueueMonitor({
  taskId: `manual_${Date.now()}_${targetUserId}`,
  userId: targetUserId,
  platform: targetPlatform as any,
  windowId,
  fingerprintWindowId: user.fingerprintWindowId,
});
```

- [ ] **步骤 3：wechatBotService.ts — 位置 3 (line 863)**

将：
```typescript
const { platformQueue } = await import('./unifiedQueue');
await platformQueue.add('monitor', { taskType: 'monitor', taskId: `manual_${Date.now()}_${pending.userId}`, userId: pending.userId, platform: pending.platform as any, windowId: pending.windowId, fingerprintWindowId: pending.windowId });
```

改为：
```typescript
const { enqueueMonitor } = await import('./unifiedQueue');
await enqueueMonitor({
  taskId: `manual_${Date.now()}_${pending.userId}`,
  userId: pending.userId,
  platform: pending.platform as any,
  windowId: pending.windowId,
  fingerprintWindowId: pending.windowId,
});
```

- [ ] **步骤 4：publishService.ts — 删 publishQueue re-export**

将 line 6 和 15：
```typescript
import { enqueuePublish, publishQueue } from './unifiedQueue';
// ...
export { publishQueue };
```

改为：
```typescript
import { enqueuePublish } from './unifiedQueue';
// 删除 export { publishQueue }; 行
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/wechatBotService.ts apps/ts-api-gateway/src/services/publishService.ts
git commit -m "refactor: wechatBotService 3处收敛到 enqueueMonitor + publishService 删 publishQueue"
```

---

### 任务 6：matrix.ts 前端 API 全量改造

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：更新 import**

将 line 11-12：
```typescript
import { monitorQueue, getAllSchedulerStatuses, resetSchedulerTimer, restartMonitorScheduler, markJobCancelled, cancelledJobIds } from '../services/monitorService';
import { enqueueReply, platformQueue } from '../services/unifiedQueue';
```

改为：
```typescript
import { getAllSchedulerStatuses, resetSchedulerTimer, restartMonitorScheduler, markJobCancelled, cancelledJobIds } from '../services/monitorService';
import { enqueueReply, getWindowQueue, getAllWindowQueues, findJobByTaskId } from '../services/unifiedQueue';
```

- [ ] **步骤 2：GET /queue/active — 遍历所有窗口队列**

将 line 1676-1680 的：
```typescript
const [active, waiting, delayed] = await Promise.all([
  platformQueue.getJobs(['active']),
  platformQueue.getJobs(['waiting']),
  platformQueue.getJobs(['delayed']),
]);
```

改为：
```typescript
const allJobs: any[] = [];
for (const q of getAllWindowQueues().values()) {
  const [active, waiting, delayed] = await Promise.all([
    q.getJobs(['active']),
    q.getJobs(['waiting']),
    q.getJobs(['delayed']),
  ]);
  allJobs.push(...active, ...waiting, ...delayed);
}
```

同时将后续的 `const allJobs = [...active, ...waiting, ...delayed];` 删除。

- [ ] **步骤 3：POST /monitor/tasks/:taskId/cancel — 遍历窗口队列查找 job**

将 line 476-558 的 cancel 逻辑重写。关键改动：
- 用 `findJobByTaskId(taskId)` 替代手动查找
- 用 `job.remove()` 替代手动 Redis key 操作

```typescript
router.post('/monitor/tasks/:taskId/cancel', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ taskId: z.string().min(1) });
    const { taskId } = paramsSchema.parse(req.params);

    const job = await findJobByTaskId(taskId);
    if (!job) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }

    const bullJobId = job.id;
    const isActive = await job.isActive();

    logger.info({ taskId, bullJobId, isActive }, '开始强制取消任务');

    markJobCancelled(bullJobId!);
    await job.discard().catch(() => {});
    await job.remove().catch(() => {});

    res.json({
      success: true,
      message: `任务已强制取消${isActive ? '（运行中任务已中断）' : ''}`,
    });
  } catch (err) {
    handleError(res, logger, err, '强制取消任务失败');
  }
});
```

- [ ] **步骤 4：POST /monitor/active-tasks/cancel-all — 遍历窗口队列**

将 line 562-628 的 cancel-all 逻辑重写：

```typescript
router.post('/monitor/active-tasks/cancel-all', async (_req: Request, res: Response) => {
  try {
    let cancelled = 0;
    for (const q of getAllWindowQueues().values()) {
      const jobs = await q.getJobs(['active', 'waiting', 'delayed']);
      for (const job of jobs) {
        markJobCancelled(job.id!);
        await job.discard().catch(() => {});
        await job.remove().catch(() => {});
        cancelled++;
      }
    }

    logger.info({ cancelled }, '已强制取消所有任务');
    res.json({ success: true, message: `已强制取消 ${cancelled} 个任务` });
  } catch (err) {
    handleError(res, logger, err, '强制取消所有任务失败');
  }
});
```

- [ ] **步骤 5：POST /monitor/videos/clear — 遍历窗口队列取消**

将 line 1294-1318 的取消逻辑从手动 Redis 操作改为：

```typescript
let cancelled = 0;
for (const q of getAllWindowQueues().values()) {
  const jobs = await q.getJobs(['active', 'waiting', 'delayed']);
  for (const job of jobs) {
    markJobCancelled(job.id!);
    await job.discard().catch(() => {});
    await job.remove().catch(() => {});
    cancelled++;
  }
}
logger.info({ cancelled }, '清空数据时已取消所有队列任务');
```

- [ ] **步骤 6：GET /monitor/tasks/batch-status — 改用 findJobByTaskId**

找到使用 `monitorQueue.getJob(taskId)` 的地方，改为 `findJobByTaskId(taskId)`。

- [ ] **步骤 7：POST /monitor/accounts/:userId/trigger — 改用 enqueueMonitor**

找到使用 `monitorQueue.add(...)` 的地方，改为 `enqueueMonitor(...)`。

- [ ] **步骤 8：POST /monitor/trigger-all — 改用 enqueueMonitor**

找到使用 `monitorQueue.add(...)` 的地方，改为 `enqueueMonitor(...)`。

- [ ] **步骤 9：BigInt 修复 — matrix.ts new-comments API**

找到 Prisma aggregate 返回 BigInt 的地方（约 line 1479），用 `Number()` 包裹。

- [ ] **步骤 10：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "refactor: matrix.ts 全量改造 — 遍历窗口队列 + findJobByTaskId + BigInt 修复"
```

---

### 任务 7：Docker 重建验证

- [ ] **步骤 1：TypeScript 编译检查**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | head -50
```

预期：无新错误（已有的 LSP 错误是预先存在的）

- [ ] **步骤 2：Docker 重建**

```bash
cd /home/lrp/social_media_complete && docker build --no-cache -f apps/ts-api-gateway/Dockerfile -t sm-ts-api . && docker compose up -d sm-ts-api
```

- [ ] **步骤 3：验证启动日志**

```bash
docker logs sm-ts-api --tail 50 2>&1 | grep -i "worker\|队列\|启动清理"
```

预期：看到多个窗口的 Worker 创建日志和启动清理日志。

- [ ] **步骤 4：触发任务验证并行执行**

通过前端或 API 触发多个窗口的监控任务，确认：
- 不同窗口的任务并行执行（日志中看到多个窗口同时有 Phase1/2/3）
- 同一窗口的任务串行执行（不会同时有两个任务在跑）

- [ ] **步骤 5：验证队列 API**

```bash
curl -s http://localhost:3000/api/v1/matrix/queue/active | jq '.data.total'
```

预期：返回活跃任务数，包含多个窗口的任务。

- [ ] **步骤 6：Commit 最终版本**

```bash
git add -A && git commit -m "feat: per-window BullMQ 队列 — 彻底消除窗口间任务饿死问题"
```
