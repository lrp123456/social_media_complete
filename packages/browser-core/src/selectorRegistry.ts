// @browser-core/selectorRegistry.ts
// 选择器注册表 — 将 "platform.flow.key" 路径桥接到 SelectorReader
// 提供统一的单例访问入口，通过推断 key 前缀自动匹配类别

import type { SelectorEntry, SelectorCategory, SelectorReader } from './selectorConfig';

// ============================================================
// 类型定义
// ============================================================

/** 解析后的选择器（运行时完整信息） */
export interface ResolvedSelector {
  /** 完整选择器键名 (如 "douyin.monitor.menu_home") */
  selectorKey: string;
  /** 平台标识 */
  platform: string;
  /** 流程标识 (如 publish / monitor) */
  flow: string;
  /** 策略名 (如 menu_home) */
  strategy: string;
  /** 主选择器 */
  primary: string;
  /** 回退选择器列表 */
  fallbacks: string[];
  /** 限定搜索范围的父级 scope 选择器 */
  scope?: string;
  /** 链式选择器数组 (多层导航) */
  chain?: string[];
  /** 目标元素描述 */
  target?: string;
  /** 反蜜罐标志 */
  antiHoneypot?: boolean;
  /** 等待超时 (ms)，默认 5000 */
  timeout: number;
  /** 可读描述 */
  description?: string;
}

// ============================================================
// 类别推断
// ============================================================

const CATEGORY_PREFIXES: [string, SelectorCategory][] = [
  ['menu_', 'menus'],
  ['btn_', 'buttons'],
  ['button_', 'buttons'],
  ['region_', 'regions'],
  ['input_', 'textboxes'],
  ['textbox_', 'textboxes'],
];

/**
 * 根据选择器名称推断所属类别。
 * 返回匹配的类别名，若无匹配则返回 null（触发全类别扫描）。
 */
export function inferCategory(key: string): SelectorCategory | null {
  for (const [prefix, cat] of CATEGORY_PREFIXES) {
    if (key.startsWith(prefix)) return cat;
  }
  return null;
}

// ============================================================
// 适配器
// ============================================================

/**
 * 将 SelectorEntry 转换为 ResolvedSelector。
 */
export function adapt(
  entry: SelectorEntry,
  selectorKey: string,
  platform: string,
  flow: string,
): ResolvedSelector {
  const parts = selectorKey.split('.');
  const strategy = parts[parts.length - 1] || selectorKey;

  return {
    selectorKey,
    platform,
    flow,
    strategy,
    primary: entry.primary,
    fallbacks: entry.fallbacks ?? [],
    scope: entry.scopeKey,
    chain: entry.parent ? [entry.parent] : undefined,
    timeout: 5000,
    description: entry.description,
    target: entry.filterText,
  };
}

// ============================================================
// SelectorRegistry 单例
// ============================================================

const ALL_CATEGORIES: SelectorCategory[] = ['menus', 'buttons', 'regions', 'textboxes'];

class SelectorRegistryClass {
  private reader: SelectorReader | null = null;

  /** 设置底层 SelectorReader */
  setReader(reader: SelectorReader): void {
    this.reader = reader;
  }

  /** 获取当前 SelectorReader */
  getReader(): SelectorReader | null {
    return this.reader;
  }

  /**
   * 通过 "platform.flow.key" 路径解析选择器。
   * 先通过 key 前缀推断类别，若无法推断则扫描全部类别。
   *
   * @param path - 格式: platform.flow.key (如 "douyin.monitor.menu_home")
   * @returns 解析后的选择器，未找到返回 null
   */
  get(path: string): ResolvedSelector | null {
    if (!this.reader) return null;
    if (!path) return null;

    // 解析 platform.flow.key
    const firstDot = path.indexOf('.');
    if (firstDot === -1) return null;
    const secondDot = path.indexOf('.', firstDot + 1);
    if (secondDot === -1) return null;

    const platform = path.slice(0, firstDot);
    const flow = path.slice(firstDot + 1, secondDot);
    const key = path.slice(secondDot + 1);

    if (!platform || !flow || !key) return null;

    // 推断类别
    const category = inferCategory(key);

    if (category) {
      // 快速路径：已知类别
      const entry = this.reader.getSelector(platform, category, key);
      if (!entry) return null;
      return adapt(entry, path, platform, flow);
    }

    // 慢速路径：扫描全部类别
    for (const cat of ALL_CATEGORIES) {
      const entry = this.reader.getSelector(platform, cat, key);
      if (entry) {
        return adapt(entry, path, platform, flow);
      }
    }

    return null;
  }
}

/** SelectorRegistry 单例 */
export const SelectorRegistry = new SelectorRegistryClass();
