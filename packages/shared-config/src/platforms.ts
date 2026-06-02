// @social-media/shared-config/platforms.ts - 7 平台静态常量定义

export const SUPPORTED_PLATFORMS = [
  'douyin',
  'kuaishou',
  'xiaohongshu',
  'bilibili',
  'baijiahao',
  'tencent',
  'tiktok',
] as const;

export type PlatformName = (typeof SUPPORTED_PLATFORMS)[number];

export interface PlatformMeta {
  name: PlatformName;
  label: string;
  color: string;
  creatorUrl: string;
  domains: string[];
  requiresBrowser: boolean;
}

export const PLATFORM_META: Record<PlatformName, PlatformMeta> = {
  douyin: {
    name: 'douyin',
    label: '抖音',
    color: '#000000',
    creatorUrl: 'https://creator.douyin.com',
    domains: ['creator.douyin.com', 'www.douyin.com'],
    requiresBrowser: true,
  },
  kuaishou: {
    name: 'kuaishou',
    label: '快手',
    color: '#FA4907',
    creatorUrl: 'https://cp.kuaishou.com',
    domains: ['cp.kuaishou.com', 'www.kuaishou.com'],
    requiresBrowser: true,
  },
  xiaohongshu: {
    name: 'xiaohongshu',
    label: '小红书',
    color: '#FF2442',
    creatorUrl: 'https://creator.xiaohongshu.com',
    domains: ['creator.xiaohongshu.com', 'www.xiaohongshu.com'],
    requiresBrowser: true,
  },
  bilibili: {
    name: 'bilibili',
    label: 'B站',
    color: '#00A1D6',
    creatorUrl: 'https://member.bilibili.com',
    domains: ['member.bilibili.com', 'www.bilibili.com'],
    requiresBrowser: false, // Uses biliup CLI
  },
  baijiahao: {
    name: 'baijiahao',
    label: '百家号',
    color: '#3385FF',
    creatorUrl: 'https://baijiahao.baidu.com',
    domains: ['baijiahao.baidu.com'],
    requiresBrowser: true,
  },
  tencent: {
    name: 'tencent',
    label: '腾讯视频号',
    color: '#00C800',
    creatorUrl: 'https://channels.weixin.qq.com',
    domains: ['channels.weixin.qq.com'],
    requiresBrowser: true,
  },
  tiktok: {
    name: 'tiktok',
    label: 'TikTok',
    color: '#00F2EA',
    creatorUrl: 'https://www.tiktok.com',
    domains: ['www.tiktok.com', 'ads.tiktok.com'],
    requiresBrowser: true,
  },
};

// 监控平台子集（仅支持评论监控的平台）
export const MONITOR_PLATFORMS: PlatformName[] = ['douyin', 'kuaishou', 'xiaohongshu'];

// 发布平台全集
export const PUBLISH_PLATFORMS: PlatformName[] = [
  'douyin',
  'kuaishou',
  'xiaohongshu',
  'bilibili',
  'baijiahao',
  'tencent',
  'tiktok',
];
