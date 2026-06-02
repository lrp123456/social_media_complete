// @ts-api-gateway/services/configService.ts - 配置服务
// Redis Pub/Sub 广播配置变更 + Prisma 持久化

import { getRedis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { getSelectorRegistry } from '@social-media/selectors';

const logger = createLogger('config-service');

const CONFIG_CHANNEL = 'config:updates';

// ============================================================
// Pub/Sub: TS 配置变更广播
// ============================================================

/**
 * 发布配置变更通知到 Redis Pub/Sub
 * Python Worker 监听此频道实现热重载
 */
export async function broadcastConfigUpdate(
  changeType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const redis = getRedis();
  const message = JSON.stringify({
    type: changeType,
    timestamp: Date.now(),
    ...payload,
  });

  await redis.publish(CONFIG_CHANNEL, message);
  logger.info(`📡 配置广播: ${CONFIG_CHANNEL} → ${changeType}`);
}

// ============================================================
// 配置 CRUD
// ============================================================

export interface ConfigEntry {
  platform: string;
  key: string;
  value: string;
  description?: string;
  version: number;
}

/**
 * 更新平台配置（含版本控制 + 审计日志）
 */
export async function updatePlatformConfig(
  platform: string,
  configKey: string,
  configValue: string,
  operator = 'system',
  description?: string,
): Promise<ConfigEntry> {
  // 获取旧值
  const existing = await prisma.platformConfig.findUnique({
    where: {
      platform_configKey: { platform, configKey },
    },
  });

  const oldValue = existing?.configValue ?? '';

  // Upsert
  const config = await prisma.platformConfig.upsert({
    where: {
      platform_configKey: { platform, configKey },
    },
    create: {
      platform,
      configKey,
      configValue,
      description: description ?? '',
    },
    update: {
      configValue,
      description: description ?? '',
      version: { increment: 1 },
    },
  });

  // 审计日志
  await prisma.platformConfigAudit.create({
    data: {
      platform,
      configKey,
      oldValue,
      newValue: configValue,
      version: config.version,
      action: existing ? 'update' : 'create',
      operator,
    },
  });

  // 🔥 热重载：如果更新的是选择器，同步到 SelectorRegistry
  if (configKey.startsWith('selector.') || configKey === 'menu_selectors') {
    const registry = getSelectorRegistry(prisma);
    await registry.init(); // 重新加载
  }

  // 广播变更
  await broadcastConfigUpdate('config_updated', {
    platform,
    configKey,
    version: config.version,
  });

  logger.info(`配置已更新: ${platform}.${configKey} (v${config.version})`);
  return config as ConfigEntry;
}

/**
 * 获取平台所有配置
 */
export async function getPlatformConfigs(platform: string): Promise<ConfigEntry[]> {
  const configs = await prisma.platformConfig.findMany({
    where: { platform, enabled: true },
    orderBy: { updatedAt: 'desc' },
  });
  return configs as ConfigEntry[];
}
