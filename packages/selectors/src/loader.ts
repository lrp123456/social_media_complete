// @social-media/selectors/loader
// 从 scripts/selectors-extracted.json 加载由 extract_selectors.py 生成的
// 已验证的 DOM 选择器，并转换为现有 SelectorDef / SelectorEntry 格式。
//
// 设计目标：
//   - 不引入新依赖（仅用 Node 内置 fs/path）
//   - 类型完全复用 @social-media/selectors 与 @browser-core/selectorConfig
//   - 提供 build*Default* 工厂，注入到两个 registry 的冷启动 defaults

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SelectorDef } from './index';
import type {
  PlatformSelectors,
  SelectorConfig,
  SelectorEntry,
} from '@social-media/browser-core';

// ============================================================
// 提取出的 JSON 结构（由 scripts/extract_selectors.py 写入）
// ============================================================

export interface ExtractedEntry {
  purposes: string[];
  primary: string;
  staticPrimary?: string;
  fallbacks: string[];
  selectorType: string;
  description: string;
  evidence: {
    page?: string;
    checks?: Array<[string, number | null, string]>;
    staticVerified?: [string, number | null, string] | null;
  };
}

export interface ExtractedConfig {
  version: string;
  updatedAt: string;
  source: string;
  selectorStrategy: string[];
  platforms: Record<string, {
    menus: Record<string, ExtractedEntry>;
    buttons: Record<string, ExtractedEntry>;
    regions: Record<string, ExtractedEntry>;
    textboxes: Record<string, ExtractedEntry>;
  }>;
}

// ============================================================
// 路径与加载
// ============================================================

const DEFAULT_JSON = path.resolve(
  __dirname,
  '..', '..', '..', 'scripts', 'selectors-extracted.json',
);

/** 找到 selectors-extracted.json 的真实路径（开发期 / dist/ 后都可工作）。 */
export function resolveExtractedJsonPath(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (fs.existsSync(DEFAULT_JSON)) return DEFAULT_JSON;
  // 兜底：向上递归查找
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'scripts', 'selectors-extracted.json');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(
    `selectors-extracted.json 未找到，请先运行：python3 scripts/extract_selectors.py`,
  );
}

/** 读取 JSON。失败时抛错，让上层选择是否降级到硬编码默认。 */
export function loadExtractedConfig(jsonPath?: string): ExtractedConfig {
  const fp = resolveExtractedJsonPath(jsonPath);
  const raw = fs.readFileSync(fp, 'utf-8');
  return JSON.parse(raw) as ExtractedConfig;
}

// ============================================================
// 转换：ExtractedEntry → SelectorDef（Prisma 库）
// ============================================================

/**
 * 把一个 ExtractedEntry 适配为 packages/selectors 内的 SelectorDef。
 *
 * 规则：
 *   - id_selector   ← primary 是否是 #xxx（CSS by id）
 *   - css_selector  ← 否则取 staticPrimary（如果存在）或 primary
 *   - xpath_selector ← primary 是否以 xpath= 开头
 *   - text_selector ← primary 是否是 getByText(...)
 *   - level         ← 解析 key 前缀：menu=1 / menu_sub=2 / btn=1 / region=0 / tb=0
 */
export function toSelectorDef(key: string, entry: ExtractedEntry): SelectorDef {
  const primary = entry.primary || '';
  const fallback = entry.staticPrimary || '';

  const def: SelectorDef = { level: inferLevel(key) };

  if (primary.startsWith('#') || fallback.startsWith('#')) {
    def.id_selector = (primary.startsWith('#') ? primary : fallback);
  }
  if (primary.startsWith('xpath=')) {
    def.xpath_selector = primary;
  } else if (fallback.startsWith('xpath=')) {
    def.xpath_selector = fallback;
  }

  const cssCandidate = (primary.startsWith('#') || primary.startsWith('xpath=') || primary.startsWith('getBy'))
    ? fallback
    : primary;
  if (cssCandidate && !cssCandidate.startsWith('xpath=') && !cssCandidate.startsWith('getBy')) {
    def.css_selector = cssCandidate;
  }

  // text_selector: getByText / getByRole(name=)
  const textMatch =
    primary.match(/getByText\(\s*"([^"]+)"/) ||
    primary.match(/getByRole\(\s*"\w+"\s*,\s*name="([^"]+)"/) ||
    fallback.match(/getByText\(\s*"([^"]+)"/) ||
    fallback.match(/getByRole\(\s*"\w+"\s*,\s*name="([^"]+)"/);
  if (textMatch) {
    def.text_selector = textMatch[1];
  }

  // expandable 仅对父菜单生效
  if (/^menu_/.test(key) && !/^menu_sub_/.test(key) && entry.purposes.length > 0) {
    def.expandable = true;
  }
  if (/^menu_sub_/.test(key)) {
    def.parent_menu = key.replace(/^menu_sub_/, 'menu_');
  }

  return def;
}

function inferLevel(key: string): number {
  if (/^menu_sub_/.test(key)) return 2;
  if (/^menu_/.test(key)) return 1;
  return 0;
}

/** 把 platforms.menus/buttons/regions/textboxes 扁平为 platform→key→SelectorDef */
export function buildSelectorDefMap(cfg: ExtractedConfig): Record<string, Record<string, SelectorDef>> {
  const out: Record<string, Record<string, SelectorDef>> = {};
  for (const [platform, cats] of Object.entries(cfg.platforms)) {
    out[platform] = {};
    for (const cat of ['menus', 'buttons', 'regions', 'textboxes'] as const) {
      for (const [k, v] of Object.entries(cats[cat])) {
        out[platform][k] = toSelectorDef(k, v);
      }
    }
  }
  return out;
}

// ============================================================
// 转换：ExtractedEntry → SelectorEntry（browser-core 配置库）
// ============================================================

function toSelectorEntry(e: ExtractedEntry): SelectorEntry {
  // 顺序：safe 优先 (primary=getByRole / getByText) → staticPrimary → 其余 fallbacks
  const fallbacks: string[] = [];
  for (const f of [e.staticPrimary, ...(e.fallbacks || [])]) {
    if (f && !fallbacks.includes(f) && f !== e.primary) {
      fallbacks.push(f);
    }
  }
  return {
    purposes: (e.purposes || []) as SelectorEntry['purposes'],
    primary: e.primary || e.staticPrimary || '',
    fallbacks,
    selectorType: (e.selectorType as SelectorEntry['selectorType']) || 'css',
    description: e.description,
  };
}

/** 把 ExtractedConfig 转为 @browser-core/selectorConfig 的 SelectorConfig 形态。 */
export function toSelectorConfig(cfg: ExtractedConfig): SelectorConfig {
  const platforms: Record<string, PlatformSelectors> = {};
  for (const [platform, cats] of Object.entries(cfg.platforms)) {
    const mapPlatform: PlatformSelectors = {
      menus: {}, buttons: {}, regions: {}, textboxes: {},
    };
    for (const cat of ['menus', 'buttons', 'regions', 'textboxes'] as const) {
      for (const [k, v] of Object.entries(cats[cat])) {
        mapPlatform[cat][k] = toSelectorEntry(v);
      }
    }
    // 透传 urlMonitors（如果存在）
    if ((cats as any).urlMonitors) {
      mapPlatform.urlMonitors = (cats as any).urlMonitors;
    }
    platforms[platform] = mapPlatform;
  }
  return {
    version: cfg.version,
    updatedAt: cfg.updatedAt,
    platforms,
  };
}

// ============================================================
// 便捷工厂
// ============================================================

/** 直接返回合并后的 SelectorConfig（含 selectorStrategy 注解） */
export function loadSelectorConfig(jsonPath?: string): SelectorConfig & { selectorStrategy: string[]; source: string } {
  const cfg = loadExtractedConfig(jsonPath);
  return { ...toSelectorConfig(cfg), selectorStrategy: cfg.selectorStrategy, source: cfg.source };
}
