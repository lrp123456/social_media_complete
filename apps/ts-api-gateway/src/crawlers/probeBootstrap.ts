// @ts-api-gateway/crawlers/probeBootstrap.ts
// 探针启用/卸载样板：按任务 isDebugMode 启用探针 + 注入 Redis pusher。

import { MaintenanceProbe, PROBE_CHANNEL } from '@social-media/browser-core';
import { getRedis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const logger = createLogger('probe-bootstrap');

export async function bootstrapProbe(opts: { isDebugMode: boolean; taskExecutionId?: string }): Promise<void> {
  MaintenanceProbe.setEnabled(opts.isDebugMode);
  if (!opts.isDebugMode) return;

  try {
    const redis = getRedis();
    MaintenanceProbe.setRedisPusher(async (_channel, payload) => {
      await redis.lpush(PROBE_CHANNEL, payload);
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, 'redis pusher wiring failed, probe will silently drop');
    MaintenanceProbe.setRedisPusher(null);
  }
}

export async function teardownProbe(): Promise<void> {
  try {
    await MaintenanceProbe.flush();
  } catch (err: any) {
    logger.warn({ err: err.message }, 'probe flush on teardown failed');
  }
  MaintenanceProbe.setEnabled(false);
  MaintenanceProbe.setRedisPusher(null);
}
