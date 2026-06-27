// materialUpdateConfig.ts — 素材更新配置类型 + 默认值 + settingsStore 封装
import { getSection, saveSection } from '../lib/settingsStore';

// ============================================================
// 类型定义
// ============================================================

export interface KeyPool {
  placeholder: string;
  keys: string[];
  cooldownMs: number;
}

export interface ParseConfig {
  listPath: string;
  fields: Record<string, string>;
}

export interface PlatformRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body: string | null;
  maxPages: number;
  timeoutMs: number;
}

export interface Platform {
  id: string;
  name: string;
  enabled: boolean;
  request: PlatformRequest;
  keyPool: KeyPool;
  parse: ParseConfig;
}

export interface StyleDef {
  name: string;
  dir: string;
  keywords: string[];
}

export interface Processing {
  frameIntervalMs: number;
  evaluatePrompt: string;
  styles: StyleDef[];
  minRating: number;
}

export interface Schedule {
  cron: string[];
  enabled: boolean;
}

export interface KeyCooldownState {
  [platformId: string]: Record<string, number>; // key -> cooldown expiry timestamp (ms)
}

export interface MaterialUpdateConfig {
  platforms: Platform[];
  schedule: Schedule;
  processing: Processing;
  keyCooldownState: KeyCooldownState;
  allCooldownRetryAfterMs: number;
}

// ============================================================
// 默认值
// ============================================================

export const DEFAULT_PROCESSING: Processing = {
  frameIntervalMs: 1000,
  evaluatePrompt: `分析这张视频截图，返回 JSON（只返回 JSON 不要其他内容）：
{
  "style": "风格分类名称",
  "rating": "品质评级 1-5 (1最低,5最高)",
  "matched": "是否命中候选风格: true|false",
  "matchedStyle": "命中的风格目录名，未命中则为 null"
}`,
  styles: [
    { name: '口播', dir: '口播', keywords: ['口播', '讲解', '说话'] },
    { name: '场景', dir: '场景', keywords: ['户外', '街景', '风景'] },
  ],
  minRating: 4,
};

export const DEFAULT_CONFIG: MaterialUpdateConfig = {
  platforms: [],
  schedule: {
    cron: ['7 3 * * 1'],
    enabled: false,
  },
  processing: DEFAULT_PROCESSING,
  keyCooldownState: {},
  allCooldownRetryAfterMs: 1800000,
};

// ============================================================
// settingsStore 封装
// ============================================================

export function getMaterialUpdateConfig(): MaterialUpdateConfig {
  return getSection<MaterialUpdateConfig>('materialUpdate', DEFAULT_CONFIG);
}

export function saveMaterialUpdateConfig(data: Partial<MaterialUpdateConfig>): MaterialUpdateConfig {
  const current = getMaterialUpdateConfig();
  const merged = { ...current, ...data };
  saveSection('materialUpdate', merged);
  return merged;
}

export function saveKeyCooldownState(state: KeyCooldownState): void {
  const current = getMaterialUpdateConfig();
  current.keyCooldownState = state;
  saveSection('materialUpdate', current);
}
