// @social-media/selectors - 7 平台动态 DOM 选择器注册表

import { PrismaClient } from '@prisma/client';
import type { PlatformName } from '@social-media/shared-config';

// 子模块：JSON loader（从 scripts/selectors-extracted.json 加载已验证选择器）
export {
  loadExtractedConfig,
  loadSelectorConfig,
  toSelectorConfig,
  toSelectorDef,
  buildSelectorDefMap,
  resolveExtractedJsonPath,
} from './loader';
export type {
  ExtractedConfig,
  ExtractedEntry,
} from './loader';

// ============================================================
// 选择器接口定义
// ============================================================

export interface SelectorDef {
  /** ID 选择器 (优先) */
  id_selector?: string;
  /** CSS 选择器 */
  css_selector?: string;
  /** XPath 选择器 */
  xpath_selector?: string;
  /** 文本匹配选择器 */
  text_selector?: string;
  /** 层级 */
  level: number;
  /** 是否可展开 */
  expandable?: boolean;
  /** 父菜单名 */
  parent_menu?: string;
}

export interface SelectorEntry {
  platform: PlatformName;
  key: string;
  selector: SelectorDef;
  version: number;
  enabled: boolean;
}

// ============================================================
// 平台默认选择器（冷启动基准，可被 DB 覆盖）
// ============================================================

export const DEFAULT_DOUYIN_SELECTORS: Record<string, SelectorDef> = {
  home: { id_selector: '#douyin-creator-master-menu-nav-home', text_selector: '首页', level: 1 },
  content: { id_selector: '#douyin-creator-master-menu-nav-content', text_selector: '内容管理', level: 1, expandable: true },
  workManage: { id_selector: '#douyin-creator-master-menu-nav-work_manage', text_selector: '作品管理', parent_menu: 'content', level: 2 },
  interact: { id_selector: '#douyin-creator-master-menu-nav-interaction', text_selector: '互动管理', level: 1, expandable: true },
  commentManage: { id_selector: '#douyin-creator-master-menu-nav-comment_manage_new', text_selector: '评论管理', parent_menu: 'interact', level: 2 },
  dataCenter: { id_selector: '#douyin-creator-master-menu-nav-data-center', text_selector: '数据中心', level: 1, expandable: true },
};

export const DEFAULT_KUAISHOU_SELECTORS: Record<string, SelectorDef> = {
  home: { css_selector: '#app .el-menu > .el-menu-item:nth-of-type(1)', text_selector: '首页', level: 1 },
  contentManage: { css_selector: '#app .el-menu > .el-submenu:nth-of-type(1) > .el-submenu__title', text_selector: '内容管理', level: 1, expandable: true },
  workManage: { css_selector: '#app .el-menu > .el-submenu:nth-of-type(1) .el-menu--inline > .el-menu-item:nth-of-type(1)', text_selector: '作品管理', parent_menu: 'contentManage', level: 2 },
  interactManage: { css_selector: '#app .el-menu > .el-submenu:nth-of-type(2) > .el-submenu__title', text_selector: '互动管理', level: 1, expandable: true },
  commentManage: { css_selector: '#app .el-menu > .el-submenu:nth-of-type(2) .el-menu--inline > .el-menu-item', text_selector: '评论管理', parent_menu: 'interactManage', level: 2 },
};

export const DEFAULT_XIAOHONGSHU_SELECTORS: Record<string, SelectorDef> = {
  home: { css_selector: '.d-menu-item__active.d-menu-horizontal-icon', text_selector: '首页', level: 1 },
  noteManage: { css_selector: '.d-new-menu__inner > .d-menu-item:nth-child(2)', text_selector: '笔记管理', level: 1 },
  dataDashboard: { css_selector: '.d-sub-menu', text_selector: '数据看板', level: 1, expandable: true },
  dataOverview: { css_selector: '.d-sub-menu__content > div:nth-child(1)', text_selector: '账号概览', parent_menu: 'dataDashboard', level: 2 },
};

// ============================================================
// 选择器注册表 (Prisma 持久化)
// ============================================================

export class SelectorRegistry {
  private prisma: PrismaClient;
  private cache: Map<string, SelectorDef> = new Map();
  private initialized = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /** 冷启动：从 DB 加载所有选择器，缺失的使用默认值 */
  async init(): Promise<void> {
    const dbSelectors = await this.prisma.customSelector.findMany({
      where: { enabled: true },
    });

    for (const s of dbSelectors) {
      const key = `${s.platform}:${s.selectorKey}`;
      try {
        this.cache.set(key, JSON.parse(s.selectorValue));
      } catch {
        // 损坏的 JSON 跳过
      }
    }

    // 填充默认值
    this.ensureDefaults('douyin', DEFAULT_DOUYIN_SELECTORS);
    this.ensureDefaults('kuaishou', DEFAULT_KUAISHOU_SELECTORS);
    this.ensureDefaults('xiaohongshu', DEFAULT_XIAOHONGSHU_SELECTORS);

    this.initialized = true;
  }

  /** 获取选择器（三级降级：DB → Cache → Default） */
  get(platform: PlatformName, key: string): SelectorDef | null {
    const cacheKey = `${platform}:${key}`;
    return this.cache.get(cacheKey) ?? null;
  }

  /** 热更新：写入新的选择器配置 */
  async set(
    platform: PlatformName,
    key: string,
    selector: SelectorDef,
    description?: string,
  ): Promise<void> {
    const configValue = JSON.stringify(selector);

    await this.prisma.customSelector.upsert({
      where: {
        idx_selector_platform_key: { platform, selectorKey: key },
      },
      create: {
        platform,
        selectorKey: key,
        selectorValue: configValue,
        description: description ?? '',
      },
      update: {
        selectorValue: configValue,
        description: description ?? '',
        version: { increment: 1 },
      },
    });

    this.cache.set(`${platform}:${key}`, selector);
  }

  /** 获取所有平台的选择器 */
  getByPlatform(platform: PlatformName): Record<string, SelectorDef> {
    const result: Record<string, SelectorDef> = {};
    for (const [key, def] of this.cache) {
      if (key.startsWith(`${platform}:`)) {
        result[key.slice(platform.length + 1)] = def;
      }
    }
    return result;
  }

  /** 确保默认选择器存在 */
  private ensureDefaults(platform: string, defaults: Record<string, SelectorDef>): void {
    for (const [key, def] of defaults) {
      const cacheKey = `${platform}:${key}`;
      if (!this.cache.has(cacheKey)) {
        this.cache.set(cacheKey, def);
      }
    }
  }
}

/** 单例 */
let _registry: SelectorRegistry | null = null;

export function getSelectorRegistry(prisma?: PrismaClient): SelectorRegistry {
  if (!_registry && prisma) {
    _registry = new SelectorRegistry(prisma);
  }
  if (!_registry) {
    throw new Error('SelectorRegistry 未初始化，需要先传入 PrismaClient');
  }
  return _registry;
}
