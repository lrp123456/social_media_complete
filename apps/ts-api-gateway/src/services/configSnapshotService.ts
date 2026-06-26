// @ts-api-gateway/services/configSnapshotService.ts
// 配置快照 CAS 回滚 + 导出/导入

import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { Prisma } from '@prisma/client';
import type { ConfigSnapshot } from '@prisma/client';

const logger = createLogger('config-snapshot-service');

// ============================================================
// 自定义错误
// ============================================================

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// ============================================================
// 类型
// ============================================================

export interface CreateSnapshotInput {
  platform: string;
  configType: string;
  snapshotName: string;
  configData: string;
  createdBy?: string;
  description?: string;
}

export interface RollbackInput {
  platform: string;
  configType: string;
  snapshotId: string;
  currentVersion: number;
}

export interface ImportConfigInput {
  platform: string;
  configType: string;
  configData: unknown;
  snapshotName: string;
  createdBy?: string;
  description?: string;
}

// ============================================================
// ConfigSnapshotService
// ============================================================

export class ConfigSnapshotService {
  /**
   * 创建配置快照（自动置为 active，并取消同一 platform+configType 下其他 active 快照）
   */
  async createSnapshot(input: CreateSnapshotInput): Promise<ConfigSnapshot> {
    const { platform, configType, snapshotName, configData, createdBy = 'system', description = '' } = input;

    const snapshot = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. 将旧 active 置为 inactive
      await tx.configSnapshot.updateMany({
        where: { platform, configType, isActive: true },
        data: { isActive: false },
      });

      // 2. 获取当前最大版本号
      const latest = await tx.configSnapshot.findFirst({
        where: { platform, configType },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      // 3. 创建新快照
      return tx.configSnapshot.create({
        data: {
          platform,
          configType,
          snapshotName,
          configData,
          version: (latest?.version ?? 0) + 1,
          createdBy,
          description,
          isActive: true,
        },
      });
    });

    logger.info(`快照已创建: ${platform}/${configType} — ${snapshotName} (v${snapshot.version})`);
    return snapshot;
  }

  /**
   * 回滚到指定快照 —— CAS 乐观锁防并发
   *
   * 检查当前最新版本 == currentVersion，只有匹配时才写入新快照
   * 否则抛出 ConflictError，由调用方决定重试策略
   */
  async rollback(input: RollbackInput): Promise<ConfigSnapshot> {
    const { platform, configType, snapshotId, currentVersion } = input;

    // 1. 获取目标快照
    const target = await prisma.configSnapshot.findUnique({
      where: { id: snapshotId },
    });
    if (!target) {
      throw new Error(`快照不存在: ${snapshotId}`);
    }

    // 2. CAS 检查：版本未被其他人修改
    const { count } = await prisma.configSnapshot.updateMany({
      where: {
        platform,
        configType,
        version: currentVersion, // 只有当前版本匹配时才更新
        isActive: true,
      },
      data: { isActive: false },
    });

    if (count === 0) {
      // 说明当前活跃版本已被其他人修改
      logger.warn(`CAS 冲突 platform=${platform} configType=${configType} currentVersion=${currentVersion}`);
      throw new ConflictError(
        `配置已被其他人修改，请刷新后重试 (platform=${platform}, configType=${configType})`,
      );
    }

    // 3. 基于目标快照创建新版本
    const snapshot = await prisma.configSnapshot.create({
      data: {
        platform: target.platform,
        configType: target.configType,
        snapshotName: `rollback-${target.snapshotName}`,
        configData: target.configData,
        version: currentVersion + 1,
        createdBy: 'system',
        description: `Rollback to ${target.snapshotName} (v${target.version})`,
        isActive: true,
      },
    });

    logger.info(`回滚完成: ${platform}/${configType} → v${snapshot.version} (基于 ${target.snapshotName} v${target.version})`);
    return snapshot;
  }

  /**
   * 导出当前活跃配置（JSON 对象）
   */
  async exportConfig(platform: string, configType: string): Promise<Record<string, unknown>> {
    const active = await prisma.configSnapshot.findFirst({
      where: { platform, configType, isActive: true },
      orderBy: { version: 'desc' },
    });

    if (!active) {
      throw new Error(`未找到活跃配置: ${platform}/${configType}`);
    }

    return JSON.parse(active.configData) as Record<string, unknown>;
  }

  /**
   * 导入配置 —— 校验 JSON 合法性后创建快照
   */
  async importConfig(input: ImportConfigInput): Promise<ConfigSnapshot> {
    const { platform, configType, configData, snapshotName, createdBy, description } = input;

    // 校验 JSON 序列化
    let jsonStr: string;
    try {
      jsonStr = JSON.stringify(configData);
    } catch {
      throw new Error(`无效的 JSON 格式: 无法序列化传入的配置数据`);
    }

    // 额外校验：能被正常反序列化
    try {
      JSON.parse(jsonStr);
    } catch {
      throw new Error(`无效的 JSON 格式: 数据无法被正确解析`);
    }

    return this.createSnapshot({
      platform,
      configType,
      snapshotName,
      configData: jsonStr,
      createdBy: createdBy ?? 'system',
      description: description ?? `Imported config ${snapshotName}`,
    });
  }
}
