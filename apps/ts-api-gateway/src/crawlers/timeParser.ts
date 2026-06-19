/**
 * 四平台 DOM 时间文本解析为 Unix 秒级时间戳
 * 抖音：发布于2026年05月25日 14:43
 * 快手：2026-05-28 09:03:19
 * 小红书：2026-06-18 18:01
 * 视频号：2026/06/13 13:58
 */
export function parseDomTimestamp(containerText: string, platform: string, timezoneOffset: string = '+08:00'): number | null {
  let match: RegExpMatchArray | null;

  switch (platform) {
    case 'douyin': {
      match = containerText.match(/发布于(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute] = match;
      return toTimestamp(year, month, day, hour, minute, '00', timezoneOffset);
    }
    case 'kuaishou': {
      match = containerText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute, second] = match;
      return toTimestamp(year, month, day, hour, minute, second, timezoneOffset);
    }
    case 'xiaohongshu': {
      match = containerText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute] = match;
      return toTimestamp(year, month, day, hour, minute, '00', timezoneOffset);
    }
    case 'tencent': {
      match = containerText.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
      if (!match) return null;
      const [, year, month, day, hour, minute] = match;
      return toTimestamp(year, month, day, hour, minute, '00', timezoneOffset);
    }
    default:
      return null;
  }
}

function toTimestamp(year: string, month: string, day: string, hour: string, minute: string, second: string, tz: string): number {
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${tz}`;
  const ms = new Date(iso).getTime();
  return Math.floor(ms / 1000);
}

/**
 * 检查两个时间戳是否在容差范围内（秒）
 */
export function isTimestampMatch(domTimestamp: number, apiTimestamp: number, toleranceSeconds: number = 60): boolean {
  return Math.abs(domTimestamp - apiTimestamp) <= toleranceSeconds;
}

/**
 * 从容器文本中提取 description 前缀匹配
 */
export function isDescriptionMatch(containerText: string, description: string, prefixLength: number = 20): boolean {
  const descPrefix = description.toLowerCase().substring(0, prefixLength);
  if (descPrefix.length === 0) return true; // 空描述不做匹配
  return containerText.toLowerCase().includes(descPrefix);
}
