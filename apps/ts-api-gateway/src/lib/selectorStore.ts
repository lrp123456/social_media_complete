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
  version: '2.1.0',
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
    },
    kuaishou: { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {} },
    xiaohongshu: { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {} },
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

const VALID_PURPOSES = new Set(['publish', 'monitor']);
const VALID_CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes'];
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
  const sanitized: Record<string, { menus: Record<string, unknown>; buttons: Record<string, unknown>; regions: Record<string, unknown>; textboxes: Record<string, unknown>; flowRules: Record<string, unknown> }> = {};

  let removedCount = 0;
  for (const [plat, pVal] of Object.entries(platforms || {})) {
    const p = pVal as Record<string, unknown>;
    const out: Record<string, Record<string, unknown>> = { menus: {}, buttons: {}, regions: {}, textboxes: {}, flowRules: {} };
    for (const cat of VALID_CATEGORIES) {
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

export function saveSelectorConfig(): void {
  if (instance) {
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
