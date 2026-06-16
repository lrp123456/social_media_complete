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
  private static readonly LOCK_TTL = 600_000; // 600 秒（10分钟，与任务超时 MONITOR_TIMEOUT_MS 匹配）
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
   * 持续尝试获取锁，直到成功或超时
   * 任务排队等待锁释放，而不是快速失败
   */
  static async acquireWithBackoff(windowId: string, maxWaitMs = 600_000): Promise<Redlock.Lock> {
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < maxWaitMs) {
      attempt++;
      try {
        return await WindowMutex.acquire(windowId);
      } catch {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Redlock] 窗口 ${windowId} 锁获取失败，等待重试 (已等待 ${elapsed}s, 第${attempt}次尝试)`);
        // 每5秒重试一次
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }

    throw new Error(`窗口 ${windowId} 等待锁超时 (${maxWaitMs / 1000}s)`);
  }
}
