// @social-media/browser-core/snapshotSanitizer.ts
// Debug 快照存储前的令牌清洗：DOM/响应体可能含认证令牌，落库前必须脱敏。

export const TOKEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'csrf_token', re: /(csrf_token['":\s]*['"])([\w-]+)(['"])/gi },
  { name: 'session_id', re: /(session_id['":\s]*['"])([\w-]+)(['"])/gi },
  // authorization: 支持 JSON 引号格式和裸 header 格式（如 authorization:Bearer xxx）
  { name: 'authorization', re: /(authorization['":\s]*['"]?\s*Bearer\s+)([\w-]+)(['"]?)/gi },
  { name: 'ticket', re: /(ticket['":\s]*['"])([\w-]+)(['"])/gi },
  { name: 'X-Token', re: /(X-Token['":\s]*['"])([\w-]+)(['"])/gi },
];

function redactValue(value: string): string {
  // 保留前 3 字符，其余替换为 ***REDACTED***
  return value.length <= 3 ? '***REDACTED***' : value.slice(0, 3) + '***REDACTED***';
}

export function sanitizeSnapshot(
  content: string,
  _mimeType: string,
  onRedacted?: (patternName: string) => void,
): string {
  let sanitized = content;
  for (const { name, re } of TOKEN_PATTERNS) {
    let matched = false;
    sanitized = sanitized.replace(re, (match, prefix: string, value: string, suffix: string) => {
      matched = true;
      return `${prefix}${redactValue(value)}${suffix}`;
    });
    if (matched && onRedacted) onRedacted(name);
  }
  return sanitized;
}
