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
      retryCount: 30,        // 多次重试等待锁释放
      retryDelay: 1000,      // 每次重试间隔1秒
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });

    redlockInstance.on('error', (err) => {
      // 忽略锁释放相关的错误（锁已过期或已被其他进程释放）
      if (err.message.includes('0 of the 1 requested resources')) {
        return;
      }
      // 忽略锁获取超时错误（正常竞争）
      if (err.message.includes('quorum')) {
        return;
      }
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
  private static readonly LOCK_TTL = 90_000; // 90 秒（监控任务约需 2-3 分钟，TTL 由持有者自动续期；崩溃后 90s 自动释放）
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
   * 尝试获取锁，快速失败由 BullMQ 重试
   * 不在 worker 内部长时间等待，而是立即失败让 BullMQ 的重试机制处理
   * 这样 worker 不会被阻塞，可以处理其他窗口的任务
   */
  static async acquireWithBackoff(windowId: string, maxRetries = 2): Promise<Redlock.Lock> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await WindowMutex.acquire(windowId);
      } catch {
        if (i < maxRetries - 1) {
          // 短暂等待后重试一次（5秒）
          console.log(`[Redlock] 窗口 ${windowId} 锁获取失败，5s 后重试`);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    }
    throw new Error(`窗口 ${windowId} 正被其他任务占用，稍后由 BullMQ 重试`);
  }
}
