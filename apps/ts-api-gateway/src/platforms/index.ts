// @ts-api-gateway/platforms/index.ts - 发布器工厂

import { BasePublisher } from './BasePublisher';
import { DouyinPublisher } from './douyin';
import { KuaishouPublisher } from './kuaishou';
import { XiaohongshuPublisher } from './xiaohongshu';
import { BilibiliPublisher } from './bilibili';
import { BaijiahaoPublisher } from './baijiahao';
import { TencentPublisher } from './tencent';
import { TiktokPublisher } from './tiktok';
import type { PlatformName } from '@social-media/shared-config';
import { createLogger } from '../lib/logger';

const logger = createLogger('publisher-factory');

const publisherRegistry = new Map<PlatformName, BasePublisher>();

/**
 * 获取指定平台的发布器（单例）
 */
export function getPublisher(platform: PlatformName): BasePublisher {
  if (!publisherRegistry.has(platform)) {
    const publisher = createPublisher(platform);
    publisherRegistry.set(platform, publisher);
    logger.info(`发布器已初始化: ${platform}`);
  }
  return publisherRegistry.get(platform)!;
}

function createPublisher(platform: PlatformName): BasePublisher {
  switch (platform) {
    case 'douyin':      return new DouyinPublisher();
    case 'kuaishou':    return new KuaishouPublisher();
    case 'xiaohongshu': return new XiaohongshuPublisher();
    case 'bilibili':    return new BilibiliPublisher();
    case 'baijiahao':   return new BaijiahaoPublisher();
    case 'tencent':     return new TencentPublisher();
    case 'tiktok':      return new TiktokPublisher();
    default:
      throw new Error(`不支持的平台: ${platform}`);
  }
}

/**
 * 获取所有支持的发布平台列表
 */
export function getSupportedPlatforms(): PlatformName[] {
  return ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok'];
}

export { BasePublisher };
