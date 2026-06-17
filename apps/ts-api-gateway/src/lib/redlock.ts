// @ts-api-gateway/lib/redlock.ts - Redlock 分布式锁封装
// 心跳续约 + AbortSignal + owner 元数据
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
