// @ts-api-gateway/lib/redis.ts - Redis 连接管理

import Redis from 'ioredis';
import { getConfig } from '@social-media/shared-config';

let redisInstance: Redis | null = null;

export function getRedis(): Redis {
  if (!redisInstance) {
    const config = getConfig();
    redisInstance = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: true,
      retryStrategy(times) {
        if (times > 30) return null;
        return Math.min(times * 100, 5000);
      },
    });

    redisInstance.on('error', (err) => {
      console.error('Redis 连接错误:', err.message);
    });

    redisInstance.on('connect', () => {
      console.log('Redis 已连接');
    });
  }

  return redisInstance;
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
