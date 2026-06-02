// @ts-api-gateway/lib/redlock.ts - Redlock 分布式锁封装
// 基于 window_id 的互斥锁，防止并发操控同一指纹浏览器窗口

import Redlock from 'redlock';
import { getRedis } from './redis';
import { getTraceId } from '../middleware/trace';

let redlockInstance: Redlock | null = null;

export function getRedlock(): Redlock {
  if (!redlockInstance) {
    redlockInstance = new Redlock([getRedis()], {
      driftFactor: 0.01,
      retryCount: 5,
      retryDelay: 500,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });

    redlockInstance.on('error', (err) => {
      console.error('Redlock 错误:', err.message);
    });
  }

  return redlockInstance;
}

/**
 * 指纹浏览器窗口互斥锁
 * 锁定 window_id，确保同一时间只有一个任务操控该窗口
 */
export class WindowMutex {
  private static readonly LOCK_TTL = 600_000; // 10 分钟（发布操作超时）
  private static readonly LOCK_PREFIX = 'window_lock:';

  static lockKey(windowId: string): string {
    return `${WindowMutex.LOCK_PREFIX}${windowId}`;
  }

  static async acquire(windowId: string): Promise<Redlock.Lock> {
    const redlock = getRedlock();
    const key = WindowMutex.lockKey(windowId);
    const traceId = getTraceId();

    console.log(`[Redlock][${traceId}] 尝试获取窗口锁: ${windowId}`);

    try {
      const lock = await redlock.acquire([key], WindowMutex.LOCK_TTL);
      console.log(`[Redlock][${traceId}] ✅ 窗口锁获取成功: ${windowId}`);
      return lock;
    } catch (err) {
      console.error(`[Redlock][${traceId}] ❌ 窗口锁获取失败: ${windowId}`, (err as Error).message);
      throw new Error(`窗口 ${windowId} 正被其他任务占用，请稍后重试`);
    }
  }

  static async release(lock: Redlock.Lock, windowId: string): Promise<void> {
    const traceId = getTraceId();
    try {
      await lock.release();
      console.log(`[Redlock][${traceId}] 🔓 窗口锁已释放: ${windowId}`);
    } catch (err) {
      console.warn(`[Redlock][${traceId}] ⚠️ 窗口锁释放异常: ${windowId}`, (err as Error).message);
    }
  }

  /**
   * 尝试获取锁，如果失败则延迟重试（指数退避）
   * 用于 BullMQ 任务队列的防撞机制
   */
  static async acquireWithBackoff(windowId: string, maxRetries = 3): Promise<Redlock.Lock> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await WindowMutex.acquire(windowId);
      } catch {
        if (i < maxRetries - 1) {
          const delay = Math.min(60_000 * Math.pow(2, i), 120_000); // 1min, 2min, 4min
          console.log(`[Redlock] 窗口 ${windowId} 锁重试 #${i + 1}, ${delay / 1000}s 后重试`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw new Error(`窗口 ${windowId} 经过 ${maxRetries} 次重试仍无法获取锁`);
  }
}
