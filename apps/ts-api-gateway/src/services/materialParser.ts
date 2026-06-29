// materialParser.ts — 响应体解析：列表路径 + 标准 8 字段映射（点路径取值）
import type { ParseConfig, ParsedVideo } from './materialUpdateConfig';
import { TARGET_FIELDS } from './materialUpdateConfig';

export type { ParseConfig, ParsedVideo };

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
 * 转换 publishTime 原始值到 Date。
 * 支持三种格式：
 * - Unix 秒（number < 1e12）：×1000
 * - Unix 毫秒（number >= 1e12）：直接使用
 * - ISO 字符串：new Date() 解析
 */
export function parsePublishTime(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'number') {
    if (!isNaN(value)) {
      return new Date(value < 1e12 ? value * 1000 : value);
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    // 尝试数字字符串（如 "1719480000"）
    const num = Number(trimmed);
    if (!isNaN(num) && trimmed.length > 0) {
      return new Date(num < 1e12 ? num * 1000 : num);
    }
    // ISO 字符串
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d;
    return undefined;
  }

  return undefined;
}

/**
 * 将原始值转为 number（用于 likeCount/commentCount）。
 */
function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return isNaN(value) ? undefined : value;
  if (typeof value === 'string') {
    const num = Number(value);
    return isNaN(num) ? undefined : num;
  }
  return undefined;
}

/**
 * 将原始值转为 string。
 */
function toString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * 按 parseConfig 从 API 响应体解析出标准化视频列表。
 * 使用标准 8 字段映射表（fieldMap），8 键恒存在，未配置的返回 undefined。
 */
export function parseVideoList(response: unknown, config: ParseConfig): ParsedVideo[] {
  const list = getByDotPath(response, config.listPath);
  if (!Array.isArray(list)) return [];

  return list.map((item) => {
    const video: Partial<ParsedVideo> & { videoId: string } = { videoId: '' };

    for (const targetField of TARGET_FIELDS) {
      const sourcePath = config.fieldMap?.[targetField];
      if (!sourcePath) continue;

      const value = getByDotPath(item, sourcePath);
      if (value === undefined || value === null) continue;

      switch (targetField) {
        case 'videoId':
          video.videoId = String(value);
          break;
        case 'title':
          video.title = toString(value);
          break;
        case 'author':
          video.author = toString(value);
          break;
        case 'likeCount':
          video.likeCount = toNumber(value);
          break;
        case 'commentCount':
          video.commentCount = toNumber(value);
          break;
        case 'videoUrl':
          video.videoUrl = toString(value);
          break;
        case 'cover':
          video.cover = toString(value);
          break;
        case 'publishTime':
          video.publishTime = parsePublishTime(value);
          break;
      }
    }

    return video as ParsedVideo;
  });
}
