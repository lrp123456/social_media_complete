// @ts-api-gateway/lib/selectorStore.ts
// 选择器配置持久化 — JSON 文件存储
// 提供 getSelectorReader() 单例给 publisher/monitor 使用
// 启动时按 selectors.schema.json 做结构校验，失败回退默认

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import {
  SelectorReader,
} from '@social-media/browser-core';
import type { SelectorConfig } from '@social-media/browser-core';
import { createLogger } from './logger';

const logger = createLogger('selector-store');

// Minimal embedded default — only used when data/selectors.json is missing or invalid
// Contains at least the critical navigation selectors so the system stays functional
const FALLBACK_CONFIG: SelectorConfig = {
  version: '2.4.0',
  updatedAt: new Date().toISOString(),
  platforms: {
    douyin: {
      menus: {
        menu_interaction: {
          purposes: ['monitor'],
          primary: 'getByRole("menuitem", name="互动管理")',
          fallbacks: ['#douyin-creator-master-menu-nav-interaction:visible'],
          selectorType: 'role',
        },
        menu_comment_manage_new: {
          purposes: ['monitor'],
          primary: 'getByRole("menuitem", name="评论管理")',
          fallbacks: ['#douyin-creator-master-menu-nav-comment_manage_new:visible'],
          selectorType: 'role',
        },
      },
      buttons: {
        comment_reply_btn: {
          purposes: ['monitor'],
          primary: 'div[class*="item-"]:has-text("回复")',
          fallbacks: ['[role="button"]:has-text("回复")', 'div:text("回复")'],
          selectorType: 'css',
        },
        reply_send_btn: {
          purposes: ['monitor'],
          primary: '[class*="reply-content"] button.douyin-creator-interactive-button-primary:not([class*="disabled"])',
          fallbacks: ['[class*="reply-content"] button:has-text("发送")'],
          selectorType: 'css',
        },
      },
      regions: {
        comment_root_container: {
          purposes: ['monitor'],
          primary: 'div[class*="container-"]',
          fallbacks: ['div[class*="comment-list"]'],
          selectorType: 'css',
        },
      },
      textboxes: {},
      flowRules: {},
      urlMonitors: {},
      apiPatterns: {},
      dataSources: {},
      navigationFlows: {},
      frameworks: {},
    },
    kuaishou: { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {}, apiPatterns: {}, dataSources: {}, navigationFlows: {}, frameworks: {} },
    xiaohongshu: { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {}, apiPatterns: {}, dataSources: {}, navigationFlows: {}, frameworks: {} },
    tencent: { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {}, apiPatterns: {}, dataSources: {}, navigationFlows: {}, frameworks: {} },
  },
};

const DATA_DIR = resolve(process.cwd(), 'data');
const SELECTOR_FILE = resolve(DATA_DIR, 'selectors.json');
const SCHEMA_FILE = resolve(DATA_DIR, 'selectors.schema.json');

let instance: SelectorReader | null = null;

// ============================================================
// 启动期轻量校验器（不引入 ajv / zod-to-json-schema 依赖）
// 涵盖 selectors.schema.json 的所有 required + 关键 enum
// 失败回退默认并 log warning
// ============================================================

const VALID_PURPOSES = new Set(['publish', 'monitor', 'login']);
const VALID_CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes', 'apiPatterns', 'dataSources', 'navigationFlows', 'frameworks', 'loginFlows'];
const VALID_TYPES = new Set(['css', 'role', 'text', 'placeholder', 'label']);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

interface ValidationIssue {
  path: string;
  message: string;
}

function validateConfig(raw: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!raw || typeof raw !== 'object') {
    issues.push({ path: '$', message: 'root must be an object' });
    return issues;
  }
  const cfg = raw as Record<string, unknown>;
  if (typeof cfg.version !== 'string' || !SEMVER_RE.test(cfg.version)) {
    issues.push({ path: '$.version', message: `version must be semver, got ${JSON.stringify(cfg.version)}` });
  }
  if (typeof cfg.updatedAt !== 'string' || Number.isNaN(Date.parse(cfg.updatedAt))) {
    issues.push({ path: '$.updatedAt', message: `updatedAt must be ISO 8601, got ${JSON.stringify(cfg.updatedAt)}` });
  }
  if (!cfg.platforms || typeof cfg.platforms !== 'object') {
    issues.push({ path: '$.platforms', message: 'platforms must be an object' });
    return issues;
  }
  for (const [plat, pVal] of Object.entries(cfg.platforms as Record<string, unknown>)) {
    if (!pVal || typeof pVal !== 'object') {
      issues.push({ path: `$.platforms.${plat}`, message: 'must be an object' });
      continue;
    }
    const p = pVal as Record<string, unknown>;
    for (const cat of VALID_CATEGORIES) {
      // loginFlows 有专用校验，跳过通用 selector schema
      if (cat === 'loginFlows') continue;
      if (!p[cat] || typeof p[cat] !== 'object') {
        issues.push({ path: `$.platforms.${plat}.${cat}`, message: 'missing or not an object' });
        continue;
      }
      for (const [name, eVal] of Object.entries(p[cat] as Record<string, unknown>)) {
        const ep = `$.platforms.${plat}.${cat}.${name}`;
        if (!eVal || typeof eVal !== 'object') {
          issues.push({ path: ep, message: 'entry must be an object' });
          continue;
        }
        const e = eVal as Record<string, unknown>;
        if (!Array.isArray(e.purposes) || e.purposes.length === 0) {
          issues.push({ path: `${ep}.purposes`, message: 'must be a non-empty array' });
        } else {
          for (const pur of e.purposes) {
            if (!VALID_PURPOSES.has(pur as string)) {
              issues.push({ path: `${ep}.purposes[]`, message: `invalid purpose: ${pur}` });
            }
          }
        }
        if (typeof e.primary !== 'string' || e.primary.length === 0) {
          issues.push({ path: `${ep}.primary`, message: 'must be a non-empty string' });
        }
        if (!Array.isArray(e.fallbacks)) {
          issues.push({ path: `${ep}.fallbacks`, message: 'must be an array' });
        } else {
          const seen = new Set<string>();
          for (let i = 0; i < e.fallbacks.length; i++) {
            const f = e.fallbacks[i];
            if (typeof f !== 'string' || f.length === 0) {
              issues.push({ path: `${ep}.fallbacks[${i}]`, message: 'must be a non-empty string' });
            } else if (seen.has(f)) {
              issues.push({ path: `${ep}.fallbacks[${i}]`, message: `duplicate fallback: ${f}` });
            }
            seen.add(f);
          }
        }
        if (typeof e.selectorType !== 'string' || !VALID_TYPES.has(e.selectorType)) {
          issues.push({ path: `${ep}.selectorType`, message: `must be one of ${[...VALID_TYPES].join('|')}, got ${JSON.stringify(e.selectorType)}` });
        }
        // v2.1+ 可选字段 — 校验类型 (允许缺失)
        if (e.filterTag !== undefined && (typeof e.filterTag !== 'string' || e.filterTag.length === 0)) {
          issues.push({ path: `${ep}.filterTag`, message: 'filterTag must be a non-empty string (e.g. "BUTTON", "A")' });
        }
        if (e.filterText !== undefined && (typeof e.filterText !== 'string' || e.filterText.length === 0)) {
          issues.push({ path: `${ep}.filterText`, message: 'filterText must be a non-empty string' });
        }
        if (e.scopeKey !== undefined && (typeof e.scopeKey !== 'string' || e.scopeKey.length === 0)) {
          issues.push({ path: `${ep}.scopeKey`, message: 'scopeKey must be a non-empty string (reference to a region name in same platform)' });
        }
      }
    }
    // v2.5+ loginFlows 校验
    if (p.loginFlows !== undefined) {
      if (typeof p.loginFlows !== 'object' || p.loginFlows === null) {
        issues.push({ path: `$.platforms.${plat}.loginFlows`, message: 'must be an object' });
      } else {
        for (const [flowId, fVal] of Object.entries(p.loginFlows as Record<string, unknown>)) {
          const fp = `$.platforms.${plat}.loginFlows.${flowId}`;
          if (!fVal || typeof fVal !== 'object') {
            issues.push({ path: fp, message: 'entry must be an object' });
            continue;
          }
          const f = fVal as Record<string, unknown>;
          // domain 必填
          if (typeof f.domain !== 'string' || f.domain.length === 0) {
            issues.push({ path: `${fp}.domain`, message: 'must be a non-empty string' });
          }
          // loginUrl 必填
          if (typeof f.loginUrl !== 'string' || f.loginUrl.length === 0) {
            issues.push({ path: `${fp}.loginUrl`, message: 'must be a non-empty string' });
          }
          // loggedOutIndicators 和 loggedInIndicators 至少有一个非空
          const outArr = Array.isArray(f.loggedOutIndicators) ? f.loggedOutIndicators : [];
          const inArr = Array.isArray(f.loggedInIndicators) ? f.loggedInIndicators : [];
          if (outArr.length === 0 && inArr.length === 0) {
            issues.push({ path: `${fp}`, message: 'at least one of loggedOutIndicators or loggedInIndicators must be non-empty' });
          }
          // closeOnLoginSuccess 可选，存在时必须是 boolean
          if (f.closeOnLoginSuccess !== undefined && typeof f.closeOnLoginSuccess !== 'boolean') {
            issues.push({ path: `${fp}.closeOnLoginSuccess`, message: 'must be boolean if present' });
          }
        }
      }
    }
    // v2.4+ urlMonitors 校验
    if (p.urlMonitors !== undefined) {
      if (typeof p.urlMonitors !== 'object' || p.urlMonitors === null) {
        issues.push({ path: `$.platforms.${plat}.urlMonitors`, message: 'must be an object' });
      } else {
        for (const [name, mVal] of Object.entries(p.urlMonitors as Record<string, unknown>)) {
          const mp = `$.platforms.${plat}.urlMonitors.${name}`;
          if (!mVal || typeof mVal !== 'object') {
            issues.push({ path: mp, message: 'entry must be an object' });
            continue;
          }
          const m = mVal as Record<string, unknown>;
          if (!Array.isArray(m.urlPatterns) || m.urlPatterns.length === 0) {
            issues.push({ path: `${mp}.urlPatterns`, message: 'must be a non-empty array' });
          }
          if (typeof m.method !== 'string' || !['GET', 'POST'].includes(m.method)) {
            issues.push({ path: `${mp}.method`, message: 'must be GET or POST' });
          }
          if (!m.extraction || typeof m.extraction !== 'object') {
            issues.push({ path: `${mp}.extraction`, message: 'must be an object with itemsPath and idField' });
          } else {
            const ext = m.extraction as Record<string, unknown>;
            if (typeof ext.itemsPath !== 'string' || ext.itemsPath.length === 0) {
              issues.push({ path: `${mp}.extraction.itemsPath`, message: 'must be a non-empty string' });
            }
            if (typeof ext.idField !== 'string' || ext.idField.length === 0) {
              issues.push({ path: `${mp}.extraction.idField`, message: 'must be a non-empty string' });
            }
          }
        }
      }
    }
  }
  return issues;
}

/**
 * Check if a selector entry contains any purposes outside the valid set.
 */
function hasInvalidPurposes(entry: Record<string, unknown>): boolean {
  if (!Array.isArray(entry.purposes)) return true;
  return entry.purposes.some((p: unknown) => !VALID_PURPOSES.has(p as string));
}

/**
 * Strip entries with invalid purposes from the config, keeping everything else intact.
 * This is more resilient than hard-falling-back to FALLBACK_CONFIG when only a few
 * entries have issues (e.g. a new purpose value not yet in the enum).
 */
function sanitizeConfig(raw: unknown): SelectorConfig {
  const cfg = raw as Record<string, unknown>;
  const platforms = cfg.platforms as Record<string, Record<string, Record<string, unknown>>>;
  const sanitized: Record<string, { menus: Record<string, unknown>; buttons: Record<string, unknown>; regions: Record<string, unknown>; textboxes: Record<string, unknown>; flowRules: Record<string, unknown>; urlMonitors: Record<string, unknown>; apiPatterns: Record<string, unknown>; dataSources: Record<string, unknown>; navigationFlows: Record<string, unknown>; frameworks: Record<string, unknown>; loginFlows: Record<string, unknown> }> = {};

  let removedCount = 0;
  for (const [plat, pVal] of Object.entries(platforms || {})) {
    const p = pVal as Record<string, unknown>;
    const out: Record<string, Record<string, unknown>> = { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {}, urlMonitors: {}, apiPatterns: {}, dataSources: {}, navigationFlows: {}, frameworks: {}, loginFlows: {} };
    for (const cat of VALID_CATEGORIES) {
      // loginFlows 有专用校验，跳过通用 purposes 校验
      if (cat === 'loginFlows') continue;
      const entries = (p[cat] || {}) as Record<string, unknown>;
      for (const [name, eVal] of Object.entries(entries)) {
        const e = eVal as Record<string, unknown>;
        if (hasInvalidPurposes(e)) {
          logger.warn({ platform: plat, category: cat, name, purposes: e.purposes }, 'sanitizeConfig: removing entry with invalid purpose');
          removedCount++;
        } else {
          out[cat][name] = eVal;
        }
      }
    }
    // 透传 urlMonitors 字段
    out.urlMonitors = (p.urlMonitors || {}) as Record<string, unknown>;
    // 透传 apiPatterns / dataSources / navigationFlows 字段（不做 purposes 校验）
    out.apiPatterns = (p.apiPatterns || {}) as Record<string, unknown>;
    out.dataSources = (p.dataSources || {}) as Record<string, unknown>;
    out.navigationFlows = (p.navigationFlows || {}) as Record<string, unknown>;
    out.frameworks = (p.frameworks || {}) as Record<string, unknown>;
    // 透传 loginFlows（不做 purposes 校验）
    out.loginFlows = (p.loginFlows || {}) as Record<string, unknown>;
    sanitized[plat] = out as any;
  }

  const result: SelectorConfig = {
    version: (typeof cfg.version === 'string' ? cfg.version : FALLBACK_CONFIG.version) as any,
    updatedAt: new Date().toISOString(),
    platforms: sanitized as any,
  };

  logger.warn({ removedEntries: removedCount, validPlatforms: Object.keys(sanitized).length }, 'sanitizeConfig: removed entries with invalid purposes');
  return result;
}

function loadFromDisk(): SelectorConfig {
  if (!existsSync(SELECTOR_FILE)) {
    logger.warn('selectors.json not found, using defaults');
    return JSON.parse(JSON.stringify(FALLBACK_CONFIG));
  }
  let raw: string;
  try {
    raw = readFileSync(SELECTOR_FILE, 'utf-8');
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to read selectors.json, using defaults');
    return JSON.parse(JSON.stringify(FALLBACK_CONFIG));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    logger.error({ error: err.message, file: SELECTOR_FILE }, 'selectors.json is not valid JSON, using defaults');
    return JSON.parse(JSON.stringify(FALLBACK_CONFIG));
  }
  const issues = validateConfig(parsed);
  if (issues.length > 0) {
    logger.warn(
      { issues: issues.slice(0, 20), totalIssues: issues.length, schemaFile: SCHEMA_FILE },
      'selectors.json has validation issues — sanitising instead of falling back to empty defaults',
    );
    return sanitizeConfig(parsed);
  }
  const config = parsed as SelectorConfig;
  logger.info(
    {
      version: config.version,
      platforms: Object.keys(config.platforms).length,
      totalEntries: Object.values(config.platforms).reduce(
        (acc, p) => acc + (p?.menus ? Object.keys(p.menus).length : 0)
                  + (p?.buttons ? Object.keys(p.buttons).length : 0)
                  + (p?.regions ? Object.keys(p.regions).length : 0)
                  + (p?.textboxes ? Object.keys(p.textboxes).length : 0),
        0,
      ),
    },
    'selectors.json loaded & schema-validated',
  );

  // 自动合并 urlMonitors → apiPatterns（向后兼容）
  for (const [platform, pVal] of Object.entries(config.platforms || {})) {
    const p = pVal as any;
    if (!p.urlMonitors || Object.keys(p.urlMonitors).length === 0) continue;
    if (!p.apiPatterns) p.apiPatterns = {};

    for (const [name, monitor] of Object.entries(p.urlMonitors) as [string, any][]) {
      // 如果 apiPatterns 中已存在同名条目，跳过
      if (p.apiPatterns[name]) continue;

      // 从 urlMonitor 创建 apiPattern
      const patterns = monitor.urlPatterns || [];
      if (patterns.length === 0) continue;

      p.apiPatterns[name] = {
        pattern: patterns[0],
        description: monitor.description || `Auto-migrated from urlMonitor: ${name}`,
      };

      // 如果 urlMonitor 有 extraction 配置，映射到 responseArrayPath
      if (monitor.extraction?.itemsPath) {
        p.apiPatterns[name].responseArrayPath = [monitor.extraction.itemsPath];
      }
      if (monitor.extraction?.idField) {
        p.apiPatterns[name].fieldMappings = { aweme_id: [monitor.extraction.idField] };
      }

      // 如果 urlMonitor 有 pagination 配置，映射到 hasMoreField/cursorField
      if (monitor.pagination?.hasMorePath) {
        p.apiPatterns[name].hasMoreField = monitor.pagination.hasMorePath;
      }
      if (monitor.pagination?.cursorPath) {
        p.apiPatterns[name].cursorField = monitor.pagination.cursorPath;
      }

      logger.info({ platform, name, pattern: patterns[0] }, 'Auto-migrated urlMonitor to apiPattern');
    }
  }

  return config;
}

function saveToDisk(config: SelectorConfig): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SELECTOR_FILE, JSON.stringify(config, null, 2), 'utf-8');
    logger.info({ version: config.version }, 'Selectors saved to disk');
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to save selectors to disk');
  }
}

export function getSelectorReader(): SelectorReader {
  if (!instance) {
    const config = loadFromDisk();
    instance = new SelectorReader(config);
    logger.info('SelectorReader singleton created');
  }
  return instance;
}

export function saveSelectorConfig(config?: SelectorConfig): void {
  if (config) {
    saveToDisk(config);
    instance = new SelectorReader(config);
  } else if (instance) {
    saveToDisk(instance.getConfig());
  }
}

export function reloadSelectorReader(): SelectorReader {
  instance = null;
  return getSelectorReader();
}

export function resetSelectorConfig(): SelectorConfig {
  const defaults = JSON.parse(JSON.stringify(FALLBACK_CONFIG));
  instance = new SelectorReader(defaults);
  saveToDisk(defaults);
  return defaults;
}

// 暴露给测试用
export { validateConfig, SCHEMA_FILE };

/**
 * 从 selectors.json 读取 apiPattern 配置
 * @returns pattern 字符串，未找到返回 undefined
 */
export function getApiPattern(platform: string, key: string): string | undefined {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  if (!p?.apiPatterns?.[key]) return undefined;
  return p.apiPatterns[key].pattern;
}

/**
 * 从 selectors.json 读取 dataSource 配置
 * @returns DataSourceConfig 对象，未找到返回 undefined
 */
export function getDataSource(platform: string, key: string): Record<string, any> | undefined {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  if (!p?.dataSources?.[key]) return undefined;
  return p.dataSources[key];
}

/**
 * 从 selectors.json 读取所有 dataSource 配置
 */
export function getDataSources(platform: string): Record<string, Record<string, any>> {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  return p?.dataSources || {};
}

/**
 * 从 selectors.json 读取 navigationFlow 配置
 */
export function getNavigationFlow(platform: string, flowName: string): Record<string, any> | undefined {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  if (!p?.navigationFlows?.[flowName]) return undefined;
  return p.navigationFlows[flowName];
}

/**
 * 从 selectors.json 读取所有 frameworks 配置
 */
export function getFrameworks(platform: string): Record<string, Record<string, any>> {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  return p?.frameworks || {};
}

/**
 * 从 selectors.json 读取单个 framework 配置
 */
export function getFramework(platform: string, key: string): Record<string, any> | undefined {
  const reader = getSelectorReader();
  const config = reader.getConfig();
  const p = (config.platforms as any)?.[platform];
  if (!p?.frameworks?.[key]) return undefined;
  return p.frameworks[key];
}
