// @ts-api-gateway/crawlers/probeBootstrap.ts
// 探针启用/卸载样板：按任务 isDebugMode 启用探针 + 注入 Redis pusher。

import { MaintenanceProbe, PROBE_CHANNEL } from '@social-media/browser-core';
import { getRedis } from '../lib/redis';

function warnLog(msg: string, errMsg: string): void {
  // 避免依赖 @social-media/shared-config（测试环境无配置），退化为 console
  console.warn(`[probe-bootstrap] ${msg}: ${errMsg}`);
}

export async function bootstrapProbe(opts: { isDebugMode: boolean; taskExecutionId?: string }): Promise<void> {
  MaintenanceProbe.setEnabled(opts.isDebugMode);
  if (!opts.isDebugMode) return;

  try {
    const redis = getRedis();
    MaintenanceProbe.setRedisPusher(async (_channel, payload) => {
      await redis.lpush(PROBE_CHANNEL, payload);
    });
  } catch (err: any) {
    warnLog('redis pusher wiring failed, probe will silently drop', err.message);
    MaintenanceProbe.setRedisPusher(null);
  }
}

export async function teardownProbe(): Promise<void> {
  try {
    await MaintenanceProbe.flush();
  } catch (err: any) {
    warnLog('probe flush on teardown failed', err.message);
  }
  MaintenanceProbe.setEnabled(false);
  MaintenanceProbe.setRedisPusher(null);
}
