export const ANTI_DETECTION_MODE = {
  LEGACY: 'legacy',
  V2: 'v2',
} as const;

// 平台 → 环境变量名映射（抖音保留原 ANTI_DETECTION_MODE 向后兼容）
const PLATFORM_ENV: Record<string, string> = {
  douyin: 'ANTI_DETECTION_MODE',
  tencent: 'ANTI_DETECTION_MODE_TENCENT',
  kuaishou: 'ANTI_DETECTION_MODE_KUAISHOU',
  xiaohongshu: 'ANTI_DETECTION_MODE_XIAOHONGSHU',
};

/** 指定平台是否启用 v2 反检测路径 */
export function isEnabled(platform: string): boolean {
  const envName = PLATFORM_ENV[platform];
  if (!envName) return false;
  return process.env[envName] === ANTI_DETECTION_MODE.V2;
}

/** 抖音向后兼容入口（== isEnabled('douyin')） */
export function isAntiDetectionV2(): boolean {
  return isEnabled('douyin');
}
