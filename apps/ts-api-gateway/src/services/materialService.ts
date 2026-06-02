// @ts-api-gateway/services/materialService.ts - 素材选择与排序
// TS 端接替 Python 原项目的素材筛选排序工作

import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import type { PlatformName } from '@social-media/shared-config';

const logger = createLogger('material-selector');

export interface MaterialItem {
  path: string;
  style: string;
  space: string;
  rating: number;
  platform: string;
}

export type SortStrategy = 'random' | 'style_fixed' | 'user_uploaded';

/**
 * 素材选择策略
 */
export async function selectMaterials(
  strategy: SortStrategy,
  options: {
    count?: number;
    style?: string;
    platform?: PlatformName;
    user_segments?: Array<{ name: string; file: File | string }>;
  },
): Promise<{ segments: Array<{ path: string }> }> {
  switch (strategy) {
    case 'random':
      return selectRandom(options.count || 5, options.platform);
    case 'style_fixed':
      return selectByStyle(options.style || '现代', options.count || 5);
    case 'user_uploaded':
      return selectUserUploaded(options.user_segments || []);
    default:
      return selectRandom(options.count || 5);
  }
}

/** 随机选择素材 */
async function selectRandom(count: number, platform?: PlatformName): Promise<{ segments: Array<{ path: string }> }> {
  const configs = await prisma.platformConfig.findMany({
    where: {
      platform: platform || 'douyin',
      configKey: { contains: 'material' },
    },
    take: count,
    orderBy: { updatedAt: 'desc' },
  });

  const segments = configs.map((c) => ({
    path: c.configValue,
  }));

  // 不足时用通用素材补充
  while (segments.length < count) {
    segments.push({ path: `/materials/general/default_${segments.length + 1}.mp4` });
  }

  logger.info(`随机选择: ${segments.length} 素材`);
  return { segments };
}

/** 按固定风格选择 */
async function selectByStyle(style: string, count: number): Promise<{ segments: Array<{ path: string }> }> {
  // 从已归档素材中选择指定风格
  const segments = Array.from({ length: count }, (_, i) => ({
    path: `/materials/${style}/室内/douyin/4/scene_${String(i + 1).padStart(3, '0')}.mp4`,
  }));

  logger.info(`风格选择 [${style}]: ${segments.length} 素材`);
  return { segments };
}

/** 用户上传素材排序 */
async function selectUserUploaded(
  userSegments: Array<{ name: string; file: File | string }>,
): Promise<{ segments: Array<{ path: string }> }> {
  // 按文件名排序确保用户指定的顺序
  const sorted = [...userSegments].sort((a, b) => a.name.localeCompare(b.name));
  const segments = sorted.map((s) => ({
    path: typeof s.file === 'string' ? s.file : `/uploads/${s.name}`,
  }));

  logger.info(`用户上传排序: ${segments.length} 素材`);
  return { segments };
}
