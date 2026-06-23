# Per-Window Queue 设计规格

日期: 2026-06-23
状态: 已批准
关联文件:
  - apps/ts-api-gateway/src/services/unifiedQueue.ts (PRIMARY)
  - apps/ts-api-gateway/src/lib/redlock.ts
  - apps/ts-api-gateway/src/routes/matrix.ts
  - apps/ts-api-gateway/src/services/monitorService.ts
  - apps/ts-api-gateway/src/services/wechatBotService.ts
  - apps/ts-api-gateway/src/services/publishService.ts
  - apps/ts-api-gateway/src/lib/taskExecutionRecorder.ts

---

## 1. 背景与问题

### 当前架构

单个 BullMQ 队列 `Queue('platform')` + 单个 `Worker('platform')`，`concurrency: 12`。
所有窗口的所有任务（monitor/publish/reply）共享这 12 个 worker slot。

### 根因

Worker handler 内部对每个任务调用 `WindowMutex.acquireWithBackoff(windowId)`，
这是一个无限重试循环（每 5 秒重试一次）。当窗口A的任务正在等待锁时，
该任务占用一个 worker slot 但实际不做任何工作，窗口B/C/D的任务被饿死。

### 复现条件

- 窗口A有多个任务排队（如同一用户的 monitor + reply）
- 第一个任务拿到锁执行，第二个任务在 `acquireWithBackoff` 中等待
- 窗口B的任务入队，但 12 个 worker slot 中有部分被"等待锁"的任务占用
- 窗口B的任务在队列中等待，表现为"queued"状态长时间不变

### 日志证据

- 窗口 `6f1a157ce2abf6aee454208057b0ad02`（何姐）锁等待 300-500+ 秒
- 窗口 `ed20fec04dc6930f32999d664c169961`（王总）锁可用但任务不被 worker 拾取
- BullMQ 队列状态：3 running（全何姐）+ 5 queued（2 王总 + 3 何姐等待锁）

---

## 2. 设计决策

### 选定方案：每个窗口独立队列 + 独立 Worker

每个 `(windowId)` 创建一个独立的 `Queue('platform:{windowId}')` + `Worker('platform:{windowId}')`，
Worker 的 `concurrency: 1`。

### 为什么不选其他方案

**方案 A（固定桶队列）**：N 个队列用哈希取模映射窗口。
无法保证同一窗口串行（多个窗口可能映射到同一个桶），负载不均衡。

**方案 C（单一队列 + 动态 Worker）**：Worker 需要自己判断"这个 job 是不是我负责的窗口"，
不符合 BullMQ 设计哲学。不想要的 job 会被 Worker 拉走再放回，浪费 round-trip。

### 为什么方案 B 是最优解

1. 彻底消除锁等待饿死问题 — 窗口之间完全独立
2. 同一窗口内天然串行 — `concurrency: 1` 保证
3. WindowMutex 变成安全网 — BullMQ 已保证串行，Redlock 只在极端情况下兜底
4. 取消/清空更精准 — 按窗口粒度操作，不需要扫全量队列
5. 自然扩展 — 100 个窗口 = 100 个队列，无预设上限

### 资源开销

每个 BullMQ Worker 在 idle 状态下只是一个 Redis BRPOPLPUSH 连接，
内存开销约 10KB。100 个窗口 = 1MB 内存 + 100 个 Redis 连接。

---

## 3. 核心数据结构

### 文件: unifiedQueue.ts

#### 当前结构

```
const QUEUE_NAME = 'platform';
export const platformQueue = new Queue<PlatformTask>(QUEUE_NAME, ...);
export const platformWorker = new Worker<PlatformTask>(QUEUE_NAME, handler, { concurrency: 12 });
```

#### 新结构

```
const queues = new Map<string, Queue<PlatformTask>>();   // windowId → Queue
const workers = new Map<string, Worker<PlatformTask>>();  // windowId → Worker

export function getWindowQueue(windowId: string): Queue<PlatformTask> {
  if (!queues.has(windowId)) {
    const name = `platform:${windowId}`;
    const q = new Queue<PlatformTask>(name, { connection, defaultJobOptions });
    queues.set(windowId, q);
    createWindowWorker(windowId, q);  // 懒创建 Worker
  }
  return queues.get(windowId)!;
}

export function getAllWindowQueues(): Map<string, Queue<PlatformTask>> {
  return new Map(queues);  // 返回副本
}
```

#### 队列名格式

`platform:{windowId}`

Redis key 示例：
- `bull:platform:6f1a157ce2abf6aee454208057b0ad02:active`
- `bull:platform:6f1a157ce2abf6aee454208057b0ad02:1:lock`

#### defaultJobOptions（不变）

```
{
  attempts: 2,
  backoff: { type: 'fixed', delay: 300_000 },
  removeOnComplete: 100,
  removeOnFail: 200,
}
```

#### 保留的全局结构（不变）

- `cancelledJobIds: Set<string>` — 全局取消标记集合
- `markJobCancelled(bullJobId)` — 标记任务取消
- `isJobCancelled(bullJobId)` — 检查任务是否已取消
- `cleanupCancelledJob(bullJobId)` — 清理取消标记

#### 废弃别名删除

- `monitorQueue = platformQueue` → 删除
- `publishQueue = platformQueue` → 删除

#### 新增导出

- `getWindowQueue(windowId)` — 获取/创建窗口队列
- `getAllWindowQueues()` — 获取所有已创建的窗口队列

---

## 4. Worker 逻辑

### createWindowWorker(windowId, queue)

```
function createWindowWorker(windowId: string, queue: Queue<PlatformTask>) {
  const worker = new Worker<PlatformTask>(queue.name, handler, {
    connection: getRedis() as any,
    concurrency: 1,              // 核心：每窗口只跑一个任务
    lockDuration: 30 * 60 * 1000, // 30min（浏览器操作慢）
    stalledInterval: 120_000,
    limiter: { max: 10, duration: 60_000 },
  });

  // 事件监听
  worker.on('completed', ...);
  worker.on('failed', ...);
  worker.on('stalled', ...);
  worker.on('ready', ...);  // 启动清理

  workers.set(windowId, worker);
  return worker;
}
```

### Worker handler 内部改造

#### 当前（3 层嵌套 race）

```
handle = await WindowMutex.acquireWithBackoff(task.windowId, ...);  // 无限等待
await Promise.race([
  executeMonitorCheck(task, ...),
  abortPromise(handle.signal),
  setTimeout(reject, 10min),
]);
finally { handle.release() }
```

#### 改为（2 层嵌套 race）

```
// WindowMutex 变为可选的安全网
handle = await WindowMutex.tryAcquireOnce(task.windowId, ...);  // 尝试一次，失败返回 null
await Promise.race([
  executeMonitorCheck(task, ...),
  setTimeout(reject, 10min),
]);
finally { handle?.release() }
```

#### 三个任务类型的统一改造

**monitor 任务**：
- 去掉 `acquireWithBackoff` 的无限等待
- 改用 `tryAcquireOnce`（非阻塞）
- 去掉 `abortPromise(handle.signal)`（不再有心跳续约）
- `finally { handle?.release() }` 保留

**publish 任务**：
- 同上改造
- publisher.publish() 的 `skipLock=true` 参数保留（如果获取到了锁）

**reply 任务**：
- 同上改造

#### tryAcquireOnce — redlock.ts 新方法

```
static async tryAcquireOnce(windowId: string, owner: LockOwner): Promise<MutexHandle | null> {
  try {
    const lock = await WindowMutex.tryAcquire(windowId);
    await WindowMutex.writeOwnerHash(windowId, owner);
    const abortController = new AbortController();
    // 不启动心跳续约 — 单次锁，TTL=30s 自动过期
    let released = false;
    const handle: MutexHandle = {
      windowId, owner,
      signal: abortController.signal,
      acquiredAt: Date.now(),
      async release() {
        if (released) return;
        released = true;
        await WindowMutex.delOwnerHash(windowId);
        await lock.release().catch(() => {});
      },
    };
    return handle;
  } catch {
    return null;  // 锁被占用，直接返回 null
  }
}
```

#### WindowMutex 类保留

`acquireWithBackoff` 方法不删除，保留供未来跨窗口场景使用。
新增 `tryAcquireOnce` 方法。

---

## 5. 入队函数

### enqueueMonitor — 签名不变

```
export async function enqueueMonitor(task: {
  taskId: string;
  userId: number;
  platform: PlatformName;
  windowId: string;
  fingerprintWindowId: string;
}, options?: { jobId?: string }): Promise<Job> {
  const q = getWindowQueue(task.windowId);
  return q.add('monitor', { taskType: 'monitor', ...task }, {
    jobId: options?.jobId || task.taskId,
    attempts: 2,
    backoff: { type: 'fixed', delay: 300_000 },
  });
}
```

### enqueuePublish — 签名不变

```
export async function enqueuePublish(publishTask: PublishTask): Promise<Job> {
  const q = getWindowQueue(publishTask.windowId);
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
```

### enqueueReply — 签名不变

```
export async function enqueueReply(task: {
  taskId: string;
  userId: number;
  platform: PlatformName;
  windowId: string;
  fingerprintWindowId: string;
  replyData: { videoId: string; commentCid: string; text: string };
}): Promise<Job> {
  const q = getWindowQueue(task.windowId);
  return q.add('reply', { taskType: 'reply', ...task }, {
    jobId: task.taskId,
    attempts: 1,
  });
}
```

---

## 6. wechatBotService.ts 改造

### 3 处直接调用统一收入 enqueueMonitor()

**位置 1** (line 692): 15min 自动重试监控

当前:
```
const { platformQueue } = await import('./unifiedQueue');
await platformQueue.add('monitor', { taskType: 'monitor', ... });
```

改为:
```
const { enqueueMonitor } = await import('./unifiedQueue');
await enqueueMonitor({
  taskId: `retry_${Date.now()}_${targetUserId}`,
  userId: targetUserId,
  platform: targetPlatform as any,
  windowId,
  fingerprintWindowId: user.fingerprintWindowId,
});
```

**位置 2** (line 717): 手动恢复监控

当前:
```
const { platformQueue } = await import('./unifiedQueue');
await platformQueue.add('monitor', { taskType: 'monitor', ... });
```

改为:
```
const { enqueueMonitor } = await import('./unifiedQueue');
await enqueueMonitor({
  taskId: `manual_${Date.now()}_${targetUserId}`,
  userId: targetUserId,
  platform: targetPlatform as any,
  windowId,
  fingerprintWindowId: user.fingerprintWindowId,
});
```

**位置 3** (line 863): 验证码验证后恢复监控

当前:
```
const { platformQueue } = await import('./unifiedQueue');
await platformQueue.add('monitor', { taskType: 'monitor', ... });
```

改为:
```
const { enqueueMonitor } = await import('./unifiedQueue');
await enqueueMonitor({
  taskId: `manual_${Date.now()}_${pending.userId}`,
  userId: pending.userId,
  platform: pending.platform as any,
  windowId: pending.windowId,
  fingerprintWindowId: pending.windowId,
});
```

---

## 7. 前端 API 改造（matrix.ts）

### GET /queue/active — 查询活跃任务

遍历所有窗口队列聚合状态:

```
const allQueues = getAllWindowQueues();
const allJobs: Job[] = [];
for (const [windowId, q] of allQueues) {
  const [active, waiting, delayed] = await Promise.all([
    q.getJobs(['active']),
    q.getJobs(['waiting']),
    q.getJobs(['delayed']),
  ]);
  allJobs.push(...active, ...waiting, ...delayed);
}
// 后续去重逻辑不变
```

### POST /monitor/tasks/:taskId/cancel — 取消单个任务

遍历所有窗口队列查找 job，用 BullMQ API 删除（不手动操作 Redis key）:

```
for (const [windowId, q] of allQueues) {
  const jobs = await q.getJobs(['active', 'waiting', 'delayed']);
  const job = jobs.find(j => j.data.taskId === taskId);
  if (job) {
    markJobCancelled(job.id);
    await job.discard();
    await job.remove();  // BullMQ 自带 remove
    break;
  }
}
```

### POST /monitor/active-tasks/cancel-all — 取消所有任务

```
for (const [windowId, q] of allQueues) {
  const jobs = await q.getJobs(['active', 'waiting', 'delayed']);
  for (const job of jobs) {
    markJobCancelled(job.id);
    await job.discard();
    await job.remove();
  }
}
```

### POST /monitor/videos/clear — 清空数据时取消队列

同 cancel-all 模式，遍历所有窗口队列取消任务。

### 改进：去掉手动 Redis key 操作

当前 cancel/cancel-all 代码手动操作 `bull:platform:${jobId}` 等 Redis key。
改为使用 BullMQ 的 `job.remove()` API，BullMQ 自己知道 job 属于哪个队列、该删哪些 key。

---

## 8. 调度器去重改造（monitorService.ts）

### runOneSchedule() 去重逻辑

当前查全局队列:
```
const [activeJobs, waitingJobs] = await Promise.all([
  monitorQueue.getJobs(['active']),
  monitorQueue.getJobs(['waiting']),
]);
```

改为查该窗口的队列:
```
const q = getWindowQueue(windowId);
const [activeJobs, waitingJobs] = await Promise.all([
  q.getJobs(['active']),
  q.getJobs(['waiting']),
]);
```

### stale job 检测简化

当前手动查 Redis lock key:
```
const lockKey = `bull:platform:${j.id}:lock`;
const hasLock = await redis.exists(lockKey);
```

改为 BullMQ API:
```
if (await j.isActive() || await j.isWaiting()) {
  activeUserIds.add(data.userId);
}
```

BullMQ 自带 stalled 检测（`stalledInterval: 120_000`），不需要手动查 Redis lock key。

### 删除 monitorQueue re-export

monitorService.ts line 883: `export { monitorQueue }` → 删除。
matrix.ts 通过 `getWindowQueue()` 或 `getAllWindowQueues()` 查询。

---

## 9. 启动清理

### Worker ready 事件

每个 Worker 的 `ready` 事件自动清理自己窗口的队列:

```
worker.on('ready', async () => {
  const redis = getRedis();
  const queueName = `platform:${windowId}`;
  const activeKey = `bull:${queueName}:active`;
  const stalledKey = `bull:${queueName}:stalled`;

  const staleJobIds = await redis.lrange(activeKey, 0, -1);
  if (staleJobIds.length === 0) return;

  for (const jobId of staleJobIds) {
    await redis.lrem(activeKey, 1, jobId);
    const jobKey = `bull:${queueName}:${jobId}`;
    const jobData = await redis.hgetall(jobKey);
    if (jobData && Object.keys(jobData).length > 0) {
      await redis.hset(jobKey, 'failedReason', JSON.stringify({
        error: 'Worker restarted — job was stale in active list',
        cleanedAt: Date.now(),
      }));
    }
    await redis.srem(stalledKey, jobId).catch(() => {});
  }
});
```

### 旧队列清理（可选）

首次部署时，旧的 `bull:platform:*` Redis key 会残留。
可在任意一个 Worker 的 `ready` 事件中加一次性清理逻辑。
不加也不影响功能。

---

## 10. BigInt 修复

### unifiedQueue.ts:277

```
// 当前
const totalComments = await prisma.video.aggregate({
  where: { userId: task.userId },
  _sum: { commentCount: true },
});
totalComments._sum.commentCount ?? 0

// 修复
Number(totalComments._sum.commentCount ?? 0)
```

### matrix.ts:1479 (new-comments API)

同样需要检查 Prisma aggregate 返回的 BigInt，用 Number() 转换。

---

## 11. 变更影响总结

### 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| unifiedQueue.ts | 重写核心 | 单队列→per-window 队列 Map，懒创建 |
| redlock.ts | 新增方法 | `tryAcquireOnce()` 非阻塞获取锁 |
| matrix.ts | API 改造 | 遍历所有窗口队列聚合状态 |
| monitorService.ts | 调度器改造 | 查窗口队列做去重，删 monitorQueue re-export |
| wechatBotService.ts | 收敛调用 | 3 处 platformQueue.add → enqueueMonitor() |
| publishService.ts | 别名清理 | 删 publishQueue re-export |

### 不变的部分

- `enqueueMonitor` / `enqueuePublish` / `enqueueReply` 签名不变
- `cancelledJobIds` / `markJobCancelled` / `isJobCancelled` / `cleanupCancelledJob` 不变
- `PlatformTask` 类型定义不变
- `startExecution` / `updatePhase` / `finishExecution` 不变
- WindowMutex 的 `acquireWithBackoff` 保留（不删除，供未来使用）
- BullMQ defaultJobOptions 不变

### 验证方法

1. Docker rebuild & restart
2. 启动后观察日志：每个窗口应有独立的 Worker ready 日志
3. 手动触发多个窗口的任务，确认并行执行
4. 取消单个任务，确认只影响该窗口
5. 前端队列状态 API 返回正确的聚合数据
