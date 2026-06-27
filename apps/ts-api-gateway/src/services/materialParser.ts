// materialParser.ts — 响应体解析：列表路径 + 字段映射（点路径取值）
export interface ParseConfig {
  listPath: string;
  fields: Record<string, string>;
}

export interface ParsedVideo {
  videoId: string;
  title?: string;
  author?: string;
  playCount?: number;
  cover?: string;
  videoUrl?: string;
  publishTime?: number;
}

/**
 * 按点路径从对象中取值。
 * 'data.videos' => obj.data.videos
 * 空路径返回原对象。
 */
export function getByDotPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return obj;
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 按 parseConfig 从 API 响应体解析出标准化视频列表。
 */
export function parseVideoList(response: unknown, config: ParseConfig): ParsedVideo[] {
  const list = getByDotPath(response, config.listPath);
  if (!Array.isArray(list)) return [];

  return list.map((item) => {
    const video: ParsedVideo = { videoId: '' };
    for (const [targetField, sourcePath] of Object.entries(config.fields)) {
      const value = getByDotPath(item, sourcePath);
      if (value === undefined || value === null) continue;

      if (targetField === 'playCount') {
        video.playCount = typeof value === 'number' ? value : parseInt(String(value), 10) || undefined;
      } else if (targetField === 'publishTime') {
        // Unix 秒时间戳 → 毫秒
        const num = typeof value === 'number' ? value : parseInt(String(value), 10);
        if (!isNaN(num)) {
          video.publishTime = num > 1e12 ? num : num * 1000;
        }
      } else {
        (video as unknown as Record<string, unknown>)[targetField] = value;
      }
    }
    return video;
  });
}
