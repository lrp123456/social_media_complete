# 窗口互斥锁重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 WindowMutex 加心跳续约（TTL=30s，每 10s 续约）+ AbortSignal + owner 元数据 + inspect API，解决进程崩溃后锁残留 30 分钟和业务锁丢失无感知的问题

**架构：** Handle 模式 — acquire 返回 MutexHandle（含 AbortSignal），内部持有心跳定时器每 10s 续约锁 + owner hash；续约失败自动 abort 信号；release 幂等（停止心跳 + DEL owner + 释放锁）

**技术栈：** ioredis, redlock@5.0.0-beta.2, Express, Jest, ts-jest

---

## 文件结构

```
apps/ts-api-gateway/src/lib/redlock.ts              # [重写] 核心锁模块
apps/ts-api-gateway/src/lib/redlock.test.ts          # [重写] 单元测试
apps/ts-api-gateway/src/services/unifiedQueue.ts     # [修改] 三处调用方适配 Handle + abortPromise
apps/ts-api-gateway/src/platforms/BasePublisher.ts   # [修改] 删除锁代码，断言 skipLock
apps/ts-api-gateway/src/routes/system.ts             # [修改] 添加 GET /api/v1/system/locks
apps/ts-api-gateway/src/index.ts                     # [不改] systemRouter 已挂载到 /api/v1/system
```

---

## 任务 1：重写 redlock.ts — 类型定义 + abortPromise + WindowMutex 完整实现

**文件：**
- 修改：`apps/ts-api-gateway/src/lib/redlock.ts`（全量重写）
- 测试：`apps/ts-api-gateway/src/lib/redlock.test.ts`（全量重写）

### 步骤 1：编写 redlock.test.ts 测试文件（全部失败）

运行：`cd apps/ts-api-gateway && npx jest src/lib/redlock.test.ts --no-cache 2>&1 | tail -5`
预期：FAIL，报错 `Cannot find module './redlock'` 或类型不存在

```ts
// apps/ts-api-gateway/src/lib/redlock.test.ts
import { WindowMutex, abortPromise, LockOwner } from './redlock';

// ============================================================
// Mock
// ============================================================

const mockRedis = {
  hset: jest.fn().mockResolvedValue(1),
  hgetall: jest.fn().mockResolvedValue({}),
  keys: jest.fn().mockResolvedValue([]),
  del: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  pttl: jest.fn().mockResolvedValue(-1),
};

jest.mock('./redis', () => ({
  getRedis: jest.fn(() => mockRedis),
}));

jest.mock('../middleware/trace', () => ({
  getTraceId: jest.fn(() => 'test-trace'),
}));

const mockOwner: LockOwner = {
  taskId: 'task-1',
  taskType: 'monitor',
  traceId: 'trace-1',
};

function createMockLock(overrides?: Partial<Record<string, jest.Mock>>) {
  return {
    release: jest.fn().mockResolvedValue({}),
    extend: jest.fn().mockResolvedValue(null as any), // extend 返回自身
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // 每次 extend 返回一个新 mock lock（redlock.extend 返回新 Lock）
  let extendCallCount = 0;
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.hset.mockResolvedValue(1);
  mockRedis.del.mockResolvedValue(1);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ============================================================
// 1. acquire 成功 → 返回 Handle，owner hash 已写入
// ============================================================
describe('acquireWithBackoff', () => {
  it('1. acquire 成功：返回 MutexHandle，写入 owner hash，启动心跳', async () => {
    const mockLock = createMockLock();
    // extend 返回新 lock 对象（与 redlock 行为一致）
    mockLock.extend.mockResolvedValue(mockLock);

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-1', mockOwner);

    expect(handle.windowId).toBe('win-1');
    expect(handle.owner).toEqual(mockOwner);
    expect(handle.acquiredAt).toBeGreaterThan(0);
    expect(handle.signal.aborted).toBe(false);

    // owner hash 写入
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'window_lock:win-1:owner',
      expect.objectContaining({
        taskId: 'task-1',
        taskType: 'monitor',
        traceId: 'trace-1',
        host: expect.any(String),
        pid: expect.any(String),
        startedAt: expect.any(String),
      }),
    );
    expect(mockRedis.expire).toHaveBeenCalledWith('window_lock:win-1:owner', 30);

    // 心跳未立即触发（间隔 10s）
    expect(mockLock.extend).not.toHaveBeenCalled();

    // 清理
    await handle.release();
  });

  // ============================================================
  // 2. acquire 排队 → 第一次失败，第二次成功，onWaiting 被调用
  // ============================================================
  it('2. acquire 排队：第一次失败，第二次成功，onWaiting 被调用', async () => {
    const mockLock = createMockLock();
    mockLock.extend.mockResolvedValue(mockLock);

    let attempts = 0;
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockImplementation(async () => {
      attempts++;
      if (attempts < 2) throw new Error('locked');
      return mockLock;
    });

    const onWaiting = jest.fn();
    const handle = await WindowMutex.acquireWithBackoff('win-2', mockOwner, { onWaiting });

    expect(attempts).toBe(2);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }));

    await handle.release();
  });

  // ============================================================
  // 3. acquire 取消 → onWaiting 抛错 → reject
  // ============================================================
  it('3. acquire 取消：onWaiting 抛错 → acquireWithBackoff reject', async () => {
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockRejectedValue(new Error('locked'));

    const cancelErr = new Error('TASK_CANCELLED');
    const onWaiting = jest.fn(() => {
      throw cancelErr;
    });

    await expect(WindowMutex.acquireWithBackoff('win-3', mockOwner, { onWaiting })).rejects.toThrow(
      'TASK_CANCELLED',
    );
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 4. release 幂等 → 连续调用 3 次不抛错
  // ============================================================
  it('4. release 幂等：连续调用 3 次不抛错，lock.release 只调一次', async () => {
    const mockLock = createMockLock();
    mockLock.extend.mockResolvedValue(mockLock);
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-4', mockOwner);

    await handle.release();
    await handle.release();
    await handle.release();

    // lock.release 只调一次
    expect(mockLock.release).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 5. release 清理 → owner hash DEL，lock 释放
  // ============================================================
  it('5. release 清理：DEL owner hash + 释放 lock + 停心跳', async () => {
    const mockLock = createMockLock();
    mockLock.extend.mockResolvedValue(mockLock);
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-5', mockOwner);

    await handle.release();

    expect(mockRedis.del).toHaveBeenCalledWith('window_lock:win-5:owner');
    expect(mockLock.release).toHaveBeenCalled();
  });

  // ============================================================
  // 6. 心跳续约 → 10s 后 extend 被调用，owner EXPIRE 被调用
  // ============================================================
  it('6. 心跳续约：10s 后 extend + EXPIRE owner hash', async () => {
    const mockLock = createMockLock();
    const extendedLock = createMockLock();
    extendedLock.extend.mockResolvedValue(extendedLock);
    mockLock.extend.mockResolvedValue(extendedLock);

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-6', mockOwner);

    // 推进 10 秒
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockLock.extend).toHaveBeenCalledWith(30_000);
    expect(mockRedis.expire).toHaveBeenCalledWith('window_lock:win-6:owner', 30);

    await handle.release();
  });

  // ============================================================
  // 7. 续约失败 abort → extend reject → signal.aborted
  // ============================================================
  it('7. 续约失败：extend reject → signal.aborted=true，reason 含 lock_lost', async () => {
    const mockLock = createMockLock();
    mockLock.extend.mockRejectedValue(new Error('lock expired'));

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-7', mockOwner);
    expect(handle.signal.aborted).toBe(false);

    // 推进 10 秒触发心跳，extend 失败
    await jest.advanceTimersByTimeAsync(10_000);

    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toContain('lock_lost');

    // release 仍可用（幂等）
    await handle.release();
  });

  // ============================================================
  // 8. inspect → mock HGETALL，返回结构化 owner 列表
  // ============================================================
  it('8. inspect：返回结构化 owner 列表', async () => {
    const now = Date.now();
    mockRedis.keys.mockResolvedValue(['window_lock:win-8:owner']);
    mockRedis.hgetall.mockResolvedValue({
      taskId: 'task-8',
      taskType: 'reply',
      traceId: 'trace-8',
      startedAt: String(now - 5000),
      host: 'test-host',
      pid: '1234',
    });
    mockRedis.pttl.mockResolvedValue(25_000);

    const snapshots = await WindowMutex.inspect('win-8');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      windowId: 'win-8',
      taskId: 'task-8',
      taskType: 'reply',
      traceId: 'trace-8',
      host: 'test-host',
      pid: 1234,
      startedAt: now - 5000,
      ageMs: expect.any(Number),
      ttlRemainingMs: 25_000,
    });
  });

  // ============================================================
  // 9. 多窗口隔离 → win-A 持锁不影响 win-B
  // ============================================================
  it('9. 多窗口隔离：win-A 持锁不影响 win-B acquire', async () => {
    const lockA = createMockLock();
    lockA.extend.mockResolvedValue(lockA);
    const lockB = createMockLock();
    lockB.extend.mockResolvedValue(lockB);

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockImplementation(async (windowId: string) => {
      if (windowId === 'win-A') return lockA;
      if (windowId === 'win-B') return lockB;
      throw new Error('unknown window');
    });

    const handleA = await WindowMutex.acquireWithBackoff('win-A', mockOwner);
    const handleB = await WindowMutex.acquireWithBackoff('win-B', mockOwner);

    expect(handleA.windowId).toBe('win-A');
    expect(handleB.windowId).toBe('win-B');
    expect(mockRedis.hset).toHaveBeenCalledTimes(2);

    await handleA.release();
    await handleB.release();
  });
});

// ============================================================
// abortPromise 单独测试
// ============================================================
describe('abortPromise', () => {
  it('10. signal 未 abort 时 pending，abort 后 reject', async () => {
    const ac = new AbortController();

    const race = Promise.race([
      abortPromise(ac.signal),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);

    ac.abort('test reason');

    await expect(race).rejects.toThrow('锁失效，业务中止');
  });

  it('11. signal 已 aborted 时立即 reject', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(abortPromise(ac.signal)).rejects.toThrow('锁失效，业务中止');
  });
});
```

### 步骤 2：运行测试确认失败

运行：`cd apps/ts-api-gateway && npx jest src/lib/redlock.test.ts --no-cache 2>&1 | tail -15`
预期：FAIL — `Cannot find module` 或 `does not exist on type` 错误

### 步骤 3：重写 redlock.ts

```ts
// apps/ts-api-gateway/src/lib/redlock.ts
// Redlock 分布式锁封装 — 心跳续约 + AbortSignal + owner 元数据
//
// 设计原则：
// 1. 锁的释放与业务完成强挂钩（业务在 finally 中 handle.release()）
// 2. 锁的获取不会超时，只会排队等待（无限重试直到拿到锁）
// 3. 锁 TTL=30s，心跳每 10s 续约；进程崩溃后最多 30s 锁自动过期
// 4. 续约失败时 AbortSignal 通知业务中止，避免双任务共享浏览器

import Redlock, { Lock } from 'redlock';
import { getRedis } from './redis';
import { getTraceId } from '../middleware/trace';
import * as os from 'os';

let redlockInstance: Redlock | null = null;

export function getRedlock(): Redlock {
  if (!redlockInstance) {
    redlockInstance = new Redlock([getRedis()], {
      driftFactor: 0.01,
      retryCount: 0,        // 单次 acquire 不重试，由外层 acquireWithBackoff 控制
      retryDelay: 200,
      retryJitter: 100,
      automaticExtensionThreshold: 0, // 禁用 redlock 内置自动续约，由我们自己的心跳控制
    });

    redlockInstance.on('error', (err) => {
      if (err.message.includes('0 of the 1 requested resources')) return;
      if (err.message.includes('quorum')) return;
      console.error('Redlock 错误:', err.message);
    });
  }
  return redlockInstance;
}

// ============================================================
// 类型定义
// ============================================================

export interface LockOwner {
  taskId: string;
  taskType: 'monitor' | 'publish' | 'reply';
  traceId?: string;
}

export interface MutexHandle {
  readonly windowId: string;
  readonly owner: LockOwner;
  readonly signal: AbortSignal;
  readonly acquiredAt: number;
  release(): Promise<void>;
}

export interface LockOwnerSnapshot {
  windowId: string;
  taskId: string;
  taskType: string;
  traceId: string;
  host: string;
  pid: number;
  startedAt: number;
  ageMs: number;
  ttlRemainingMs: number;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 将 AbortSignal 化为可 reject 的 Promise
 * 用于 Promise.race 中，当锁失效时中断业务
 */
export function abortPromise(
  signal: AbortSignal,
  msg = '锁失效，业务中止',
): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error(msg));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error(msg)), { once: true });
  });
}

// ============================================================
// WindowMutex
// ============================================================

export class WindowMutex {
  private static readonly LOCK_TTL = 30_000;            // 30 秒
  private static readonly HEARTBEAT_INTERVAL = 10_000;  // 10 秒
  private static readonly RETRY_INTERVAL_MS = 5_000;    // 排队重试间隔
  private static readonly LOCK_PREFIX = 'window_lock:';

  static lockKey(windowId: string): string {
    return `${WindowMutex.LOCK_PREFIX}${windowId}`;
  }

  static ownerKey(windowId: string): string {
    return `${WindowMutex.LOCK_PREFIX}${windowId}:owner`;
  }

  // ------------------------------------------------------------
  // 私有：Redis owner hash 操作
  // ------------------------------------------------------------

  private static async writeOwnerHash(windowId: string, owner: LockOwner): Promise<void> {
    const redis = getRedis();
    const key = WindowMutex.ownerKey(windowId);
    await redis.hset(key, {
      taskId: owner.taskId,
      taskType: owner.taskType,
      traceId: owner.traceId || '',
      startedAt: String(Date.now()),
      host: os.hostname(),
      pid: String(process.pid),
    });
    await redis.expire(key, Math.ceil(WindowMutex.LOCK_TTL / 1000));
  }

  private static async delOwnerHash(windowId: string): Promise<void> {
    const redis = getRedis();
    await redis.del(WindowMutex.ownerKey(windowId));
  }

  private static async expireOwnerHash(windowId: string): Promise<void> {
    const redis = getRedis();
    await redis.expire(WindowMutex.ownerKey(windowId), Math.ceil(WindowMutex.LOCK_TTL / 1000));
  }

  // ------------------------------------------------------------
  // 私有：单次尝试获取锁
  // ------------------------------------------------------------

  private static async tryAcquire(windowId: string): Promise<Lock> {
    const redlock = getRedlock();
    const key = WindowMutex.lockKey(windowId);
    return await redlock.acquire([key], WindowMutex.LOCK_TTL);
  }

  // ------------------------------------------------------------
  // 私有：心跳续约
  // ------------------------------------------------------------

  private static startHeartbeat(
    windowId: string,
    abortController: AbortController,
  ): { timer: NodeJS.Timeout; updateLock: (newLock: Lock) => void } {
    let currentLock: Lock | null = null;

    const timer = setInterval(async () => {
      if (!currentLock) return;
      try {
        currentLock = await currentLock.extend(WindowMutex.LOCK_TTL);
        await WindowMutex.expireOwnerHash(windowId);
      } catch (err) {
        abortController.abort(`lock_lost: ${(err as Error).message}`);
        clearInterval(timer);
      }
    }, WindowMutex.HEARTBEAT_INTERVAL);

    return {
      timer,
      updateLock(newLock: Lock) {
        currentLock = newLock;
      },
    };
  }

  // ------------------------------------------------------------
  // 公开：acquireWithBackoff
  // ------------------------------------------------------------

  static async acquireWithBackoff(
    windowId: string,
    owner: LockOwner,
    opts?: {
      onWaiting?: (info: { attempt: number; elapsedMs: number }) => void | Promise<void>;
    },
  ): Promise<MutexHandle> {
    const traceId = owner.traceId || getTraceId();
    const startTime = Date.now();
    let attempt = 0;

    console.log(`[Redlock][${traceId}] 尝试获取窗口锁: ${windowId}`);

    // 无限重试，直到拿到锁或被外部取消
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      try {
        const lock = await WindowMutex.tryAcquire(windowId);
        await WindowMutex.writeOwnerHash(windowId, owner);

        const abortController = new AbortController();
        const heartbeat = WindowMutex.startHeartbeat(windowId, abortController);
        heartbeat.updateLock(lock);

        let released = false;

        const handle: MutexHandle = {
          windowId,
          owner,
          signal: abortController.signal,
          acquiredAt: Date.now(),
          async release() {
            if (released) return;
            released = true;
            clearInterval(heartbeat.timer);
            await WindowMutex.delOwnerHash(windowId);
            try {
              await lock.release();
              console.log(`[Redlock][${traceId}] 🔓 窗口锁已释放: ${windowId}`);
            } catch (err) {
              console.warn(
                `[Redlock][${traceId}] ⚠️ 窗口锁释放异常: ${windowId}`,
                (err as Error).message,
              );
            }
          },
        };

        if (attempt === 1) {
          console.log(`[Redlock][${traceId}] ✅ 窗口锁获取成功: ${windowId}`);
        } else {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(
            `[Redlock][${traceId}] ✅ 窗口锁获取成功: ${windowId} (排队 ${elapsed}s, 第${attempt}次尝试)`,
          );
        }

        return handle;
      } catch (err) {
        const elapsed = Date.now() - startTime;
        const elapsedSec = Math.round(elapsed / 1000);

        if (attempt === 1 || attempt % 6 === 0) {
          console.log(
            `[Redlock][${traceId}] 窗口 ${windowId} 锁被占用，排队中 (已等待 ${elapsedSec}s, 第${attempt}次尝试)`,
          );
        }

        if (opts?.onWaiting) {
          try {
            await opts.onWaiting({ attempt, elapsedMs: elapsed });
          } catch (cancelErr) {
            console.log(`[Redlock][${traceId}] 排队被中断: ${(cancelErr as Error).message}`);
            throw cancelErr;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, WindowMutex.RETRY_INTERVAL_MS));
      }
    }
  }

  // ------------------------------------------------------------
  // 公开：inspect
  // ------------------------------------------------------------

  static async inspect(windowId?: string): Promise<LockOwnerSnapshot[]> {
    const redis = getRedis();
    const now = Date.now();

    let keys: string[];
    if (windowId) {
      keys = [WindowMutex.ownerKey(windowId)];
    } else {
      keys = await redis.keys(`${WindowMutex.LOCK_PREFIX}*:owner`);
    }

    const snapshots: LockOwnerSnapshot[] = [];
    for (const key of keys) {
      const data = await redis.hgetall(key);
      if (!data || Object.keys(data).length === 0) continue;

      const wid = key.replace(WindowMutex.LOCK_PREFIX, '').replace(':owner', '');
      const ttlRemainingMs = await redis.pttl(WindowMutex.lockKey(wid));

      snapshots.push({
        windowId: wid,
        taskId: data.taskId,
        taskType: data.taskType,
        traceId: data.traceId,
        host: data.host,
        pid: Number(data.pid),
        startedAt: Number(data.startedAt),
        ageMs: now - Number(data.startedAt),
        ttlRemainingMs,
      });
    }

    return snapshots;
  }
}
```

### 步骤 4：运行测试确认通过

运行：`cd apps/ts-api-gateway && npx jest src/lib/redlock.test.ts --no-cache 2>&1`
预期：PASS（11 tests）

### 步骤 5：Commit

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/lib/redlock.ts apps/ts-api-gateway/src/lib/redlock.test.ts
git commit -m "feat(redlock): heartbeat renewal + AbortSignal + owner metadata

- TTL=30s, heartbeat every 10s via lock.extend()
- MutexHandle with AbortSignal (abort on extend failure)
- Owner hash (window_lock:{id}:owner) with task metadata
- acquireWithBackoff unchanged signature pattern (owner as 2nd arg)
- abortPromise utility for Promise.race integration
- inspect() for lock observability
- 11 unit tests covering acquire/retry/cancel/heartbeat/abort/inspect
- automaticExtensionThreshold:0 disables redlock built-in auto-extend"
```

---

## 任务 2：重写 unifiedQueue.ts — 三处调用方适配 Handle + abortPromise

**文件：**
- 修改：`apps/ts-api-gateway/src/services/unifiedQueue.ts`
  - L7: import 行（新增 MutexHandle 类型 + abortPromise）
  - L106-127: reply 路径
  - L141-179: publish 路径
  - L201-357: monitor 路径

### 步骤 1：更新 import

当前 L7：
```ts
import { WindowMutex } from '../lib/redlock';
```

改为：
```ts
import { WindowMutex, abortPromise, type MutexHandle } from '../lib/redlock';
```

同时在文件顶部添加（与现有 imports 并列）：
```ts
import { getTraceId } from '../middleware/trace';
```

### 步骤 2：改 reply 路径（L106-127）

当前：
```ts
let lock: any = null;
try {
  lock = await WindowMutex.acquireWithBackoff(task.windowId);
  await Promise.race([
    executeReplyAction(task, task.replyData),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`回复超时: 超过 ${REPLY_TIMEOUT_MS / 1000}s`)), REPLY_TIMEOUT_MS),
    ),
  ]);
  ...
} finally {
  if (lock) await WindowMutex.release(lock, task.windowId).catch(() => {});
}
```

改为：
```ts
let handle: MutexHandle | null = null;
try {
  handle = await WindowMutex.acquireWithBackoff(task.windowId, {
    taskId: task.taskId,
    taskType: 'reply',
    traceId: getTraceId(),
  });

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
  if (handle) await handle.release().catch(() => {});
}
```

### 步骤 3：改 publish 路径（L141-179）

同样的模式：
```ts
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
    publisher.publish(task.publishPayload, true),
    abortPromise(handle.signal),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`发布超时: 超过 ${PUBLISH_TIMEOUT_MS / 1000}s`)), PUBLISH_TIMEOUT_MS),
    ),
  ]);
  // ... 后续 prisma.operationLog 等保持不变
} finally {
  if (handle) await handle.release().catch(() => {});
}
```

### 步骤 4：改 monitor 路径（L201-357）

```ts
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
  // ... 后续 executeMonitorCheck 等保持不变

  const result = await Promise.race([
    executeMonitorCheck(task, onProgress, checkCancelled),
    abortPromise(handle.signal),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`任务超时: 超过 ${MONITOR_TIMEOUT_MS / 1000}s`)), MONITOR_TIMEOUT_MS),
    ),
  ]);
  // ... 后续结果处理、prisma 等保持不变
} finally {
  if (handle) {
    await handle.release().catch((releaseErr) => {
      logger.warn({ taskId: task.taskId, windowId: task.windowId, error: releaseErr.message }, '锁释放异常');
    });
  }
}
```

### 步骤 5：Commit

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "feat(queue): adapt reply/publish/monitor to MutexHandle + abortPromise

- All three paths now pass LockOwner metadata to acquireWithBackoff
- Promise.race includes abortPromise(handle.signal) for lock-loss abort
- finally block uses handle.release() instead of WindowMutex.release(lock, windowId)"
```

---

## 任务 3：修复 BasePublisher.ts — 删除锁代码，断言 skipLock

**文件：**
- 修改：`apps/ts-api-gateway/src/platforms/BasePublisher.ts`
  - L9: 删除 `import { WindowMutex } from '../lib/redlock';`
  - L14: 删除 `import type Redlock from 'redlock';`
  - L42: 删除 `protected lock: Redlock.Lock | null = null;`
  - L100-104: 改 acquire 分支为断言 skipLock
  - L196-203: 删除 `releaseLock()` 方法
  - L221-231: cleanup() 中删除锁释放逻辑

### 步骤 1：删除锁相关 import 和属性

L9 删除：`import { WindowMutex } from '../lib/redlock';`
L14 删除：`import type Redlock from 'redlock';`
L42 删除：`protected lock: Redlock.Lock | null = null;`

### 步骤 2：改 acquire 分支为断言

当前 L100-104：
```ts
if (!skipLock) {
  this.lock = await WindowMutex.acquireWithBackoff(task.windowId);
}
```

改为：
```ts
if (!skipLock) {
  throw new Error('BasePublisher must be called with skipLock=true from unifiedQueue. Direct lock management is not supported.');
}
```

### 步骤 3：删除 releaseLock 方法

删除 L196-203 整个 `releaseLock()` 方法。

### 步骤 4：清理 cleanup 方法

当前 L221-237：
```ts
protected async cleanup(): Promise<void> {
  if (this.lock) {
    try {
      await this.lock.release();
    } catch {
      // 锁可能已过期
    }
    this.lock = null;
  }
  this.browser = null;
  this.page = null;
  this.state = 'idle';
}
```

改为：
```ts
protected async cleanup(): Promise<void> {
  // CDP 模式下不关闭浏览器 — 窗口属于 RoxyBrowser，保持打开供复用
  // 锁的释放由调用方（unifiedQueue）在 finally 中统一处理
  this.browser = null;
  this.page = null;
  this.state = 'idle';
}
```

### 步骤 5：Commit

```bash
git add apps/ts-api-gateway/src/platforms/BasePublisher.ts
git commit -m "fix(publisher): remove broken lock code, assert skipLock=true

- Delete releaseLock() which used page.context() as windowId (bug)
- Delete cleanup() lock release (handled by unifiedQueue)
- Throw if skipLock is false (must always be called from unifiedQueue)"
```

---

## 任务 4：添加 GET /api/v1/system/locks 路由

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/system.ts`（添加 /locks 端点）

### 步骤 1：在 system.ts 末尾添加路由

在文件末尾（L85 之后）添加：

```ts
/** GET /api/v1/system/locks - 查看当前所有窗口锁的持有状态 */
router.get('/locks', async (_req: Request, res: Response) => {
  try {
    const { WindowMutex } = await import('../lib/redlock');
    const snapshots = await WindowMutex.inspect();

    res.json({
      success: true,
      data: {
        locks: snapshots,
        serverTime: Date.now(),
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取窗口锁状态失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

### 步骤 2：Commit

```bash
git add apps/ts-api-gateway/src/routes/system.ts
git commit -m "feat(api): add GET /api/v1/system/locks for lock observability"
```

---

## 任务 5：构建验证 + Redis 残留锁清理

### 步骤 1：构建镜像

运行：`cd /home/lrp/social_media_complete && docker build -t social_media_complete-ts-api-gateway -f apps/ts-api-gateway/Dockerfile . 2>&1 | tail -5`
预期：构建成功，无新增编译错误

### 步骤 2：清理 Redis 中的残留窗口锁

运行：
```bash
docker exec sm-redis redis-cli -a your_redis_password --scan --pattern 'window_lock:*' 2>&1 | grep -v Warning | xargs -I{} docker exec sm-redis redis-cli -a your_redis_password DEL {} 2>&1 | grep -v Warning
```
预期：删除残留锁（如果有的话输出 DEL (integer) 1）

### 步骤 3：重启容器

运行：`cd /home/lrp/social_media_complete && docker stop sm-ts-api && docker compose up -d ts-api-gateway 2>&1`
预期：容器启动正常

### 步骤 4：验证日志

运行：`docker logs sm-ts-api --since 30s 2>&1 | grep -E "Redlock|心跳|窗口锁|Redis"`
预期：看到 Redis 已连接 + 调度器注册日志，无报错

### 步骤 5：手动测试锁 API

运行：`curl -s http://localhost:3000/api/v1/system/locks | python3 -m json.tool`
预期：`{"success": true, "data": {"locks": [], "serverTime": ...}}`（启动时无任务持锁）

### 步骤 6：触发监控任务验证心跳

等待一个监控任务自然触发，然后检查锁状态：
```bash
# 等待任务执行中
curl -s http://localhost:3000/api/v1/system/locks | python3 -m json.tool
```
预期：看到 `locks` 数组有 1 个元素，含 `taskId`, `taskType`, `startedAt`, `ttlRemainingMs`

### 步骤 7：Commit（如有修复）

如果此步骤发现了需要修的问题，修复后 commit。
