type PlatformName = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'tencent';

/**
 * 统一清洗 video id：String() 包裹 + 按平台处理。
 * 所有 video id 写入点必须经过此函数，防止跨平台撞车和 number 精度丢失。
 */
export function normalizeVideoId(platform: PlatformName, rawId: string | number | null | undefined): string {
  if (rawId === null || rawId === undefined) return '';
  return String(rawId);
}
