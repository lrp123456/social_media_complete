// @browser-core/selectorConfig.ts
// 选择器配置系统 — 按 平台 → 类别 → 用途 组织
// 对外提供 SelectorReader 读取接口
// 配置可通过 API (config-automation/selectors) 动态修改

import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'selector-config' });

// ============================================================
// 类型定义
// ============================================================

/** 选择器类型 */
export type SelectorType = 'css' | 'role' | 'text' | 'placeholder' | 'label';

/** 选择器用途 */
export type SelectorPurpose = 'publish' | 'monitor';

/** 选择器类别 */
export type SelectorCategory = 'menus' | 'buttons' | 'regions' | 'textboxes';

/** 单个选择器条目 */
export interface SelectorEntry {
  /** 用途：发布 / 监控 */
  purposes: SelectorPurpose[];
  /** 主选择器 */
  primary: string;
  /** 回退选择器列表 */
  fallbacks: string[];
  /** 选择器类型 */
  selectorType: SelectorType;
  /** 可选描述 */
  description?: string;
  /** 父选择器键（用于菜单层级导航） */
  parent?: string;
  /** 检测菜单已展开的 CSS 选择器 */
  expandCheckCss?: string;
  /** 是否启用 */
  enabled?: boolean;
  // ============================================================
  // 查找时的过滤约束（v2.1+）— 让"选按钮"和"选链接"在同一份配置中区分开
  // ============================================================
  /** HTML 标签约束 (大写), 例如 'BUTTON' 'A' 'INPUT' — 防止 getByText 误匹配到 <a> 链接 */
  filterTag?: string;
  /** 元素文本精确匹配 (trim 后) */
  filterText?: string;
  /** 父级 scope 键名, 引用同平台的另一个 region (限定搜索范围, 排除侧边栏/导航) */
  scopeKey?: string;
}

/** 按钮可点击性检测方法 — 多路交叉验证, 避免单一信号失效 */
export type DisabledCheckMethod =
  | 'dom-property'    // el.disabled (HTMLButtonElement/HTMLInputElement)
  | 'attr-disabled'   // 存在 disabled 属性 (covers <fieldset disabled> 等)
  | 'aria-disabled'   // aria-disabled="true"
  | 'pseudo-disabled' // matches(':disabled')
  | 'class-disabled'  // classList 包含 disabled/is-disabled/btn-disabled
  | 'cursor'          // computed style cursor === 'not-allowed'
  | 'opacity';        // computed opacity < 0.5

/** 可见性检测方法 */
export type VisibilityCheckMethod =
  | 'offset-size'     // offsetWidth/offsetHeight > 0
  | 'rect'            // getBoundingClientRect 宽高 > 0
  | 'computed-style'  // display/visibility/opacity
  | 'viewport';       // 矩形与视口相交 (避免点击到屏外元素)

/**
 * 发布流程控制规则 (per-platform) — 解决 selector.json 装不下的"流程级"配置
 * 1. 父级 scope 选择器: 限定按钮搜索范围, 排除侧边栏同名链接
 * 2. 成功/导航 URL 模式: 点击后 URL 校验, 检测错位点击
 * 3. 过滤标签: 强制只匹配 <button> (默认), 排除 <a>
 * 4. 检测方法枚举: 多种信号交叉验证 disabled / visible
 */
export interface PublishFlowRules {
  /** 父级 scope 选择器 (扁平, primary + fallbacks) — 限定按钮搜索范围 */
  scopeSelectors?: string[];
  /** disabled 检测方法列表, 命中任一即视为禁用 */
  disabledCheckMethods?: DisabledCheckMethod[];
  /** 可见性检测方法列表, 全部通过才视为可见 */
  visibilityCheckMethods?: VisibilityCheckMethod[];
  /** 视口内边距 (px) — 用于 viewport 检测, 0 = 必须在视口内, > 0 = 允许超出 */
  viewportInsetPx?: number;
  /** 发布成功后, URL 应包含的子串 (任一) */
  successUrlPatterns?: string[];
  /** URL 包含这些子串说明点到导航链接了 (触发重试) */
  navRedirectUrlPatterns?: string[];
  /** 按钮匹配的 HTML 标签约束, 默认 'BUTTON' (排除 <a>) */
  filterTag?: string;
  /** 按钮文本约束, 精确匹配 */
  filterText?: string;
  /** 等待发布结果的总超时 (ms) */
  publishWaitMs?: number;
  /** 发布按钮重试次数 */
  publishMaxRetries?: number;
  /** disabled 时单次重试前的等待 (ms 范围) */
  disabledRetryDelayMs?: [number, number];
  /** scope 全部找不到时的退避等待 (ms 范围) */
  notFoundBackoffMs?: [number, number];
  /** 滚动的总位移 (px) — 把按钮滚到视口内 */
  scrollAmountPx?: number;
  /** 点击后稳定等待 (ms 范围) — 让 URL 跳转 / toast 出现 */
  postClickStabilizeMs?: [number, number];
  /** 点击发布后, "未添加自主声明" 弹窗的检测模式 (多路校验) */
  declareModalMethod?: 'selector' | 'page-text' | 'both';
}

// ============================================================
// URL 监控配置 (v2.4+) — 网络请求旁路拦截规则
// ============================================================

/** HTTP 请求方法 */
export type HttpMethod = 'GET' | 'POST';

/** 响应数据提取规则 */
export interface ResponseExtraction {
  /** 数据列表的 JSON 路径 (如 "data.list", "data.comment", "data.items") */
  itemsPath: string;
  /** 单条记录的唯一 ID 字段路径 (如 "exportId", "commentId", "aweme_id") */
  idField: string;
  /** 可选: 需要提取的关键字段映射 {别名: JSON路径} */
  fieldMap?: Record<string, string>;
}

/** 分页检测规则 */
export interface PaginationRule {
  /** hasMore 标志的 JSON 路径 (如 "data.downContinueFlag", "data.has_more") */
  hasMorePath?: string;
  /** hasMore=true 的判定值 (如 1, true, "1") — 默认 true */
  hasMoreValue?: unknown;
  /** hasMore=false 的判定值 (如 0, false, "0", -1) — 默认 false */
  hasMoreFalseValue?: unknown;
  /** 游标字段路径 (如 "data.lastBuff", "cursor.max", "data.cursor") */
  cursorPath?: string;
  /** 分页参数名 (请求体中传入的字段名, 如 "lastBuff", "cursor", "pcursor") */
  cursorParamName?: string;
}

/** URL 监控条目 — 描述一个需要拦截的 API 端点 (v2.4+) */
export interface UrlMonitorEntry {
  /** 启用/禁用 */
  enabled: boolean;
  /** 描述 */
  description?: string;
  /** 标签 (如 ["核心", "评论"]) */
  tags?: string[];
  /** URL 匹配模式 — 请求 URL 包含任一子串即命中 */
  urlPatterns: string[];
  /** HTTP 方法 */
  method: HttpMethod;
  /** 响应提取规则 */
  extraction: ResponseExtraction;
  /** 分页检测规则 */
  pagination?: PaginationRule;
  /** 关联的业务流程阶段 (如 "monitor:scan", "monitor:collect", "reply:execute") */
  flowPhase?: string;
  /** 可选: 响应结构校验 (复用 interceptor 的 ValidationConfig 子集) */
  validation?: {
    expectedPageUrls?: string[];
    requiredItemFields?: string[];
    minItems?: number;
    requiredUrlParams?: string[];
  };
}

/** 平台选择器集合 + 流程规则 (v2.1+) */
export interface PlatformSelectors {
  /** 菜单 / 导航项 */
  menus: Record<string, SelectorEntry>;
  /** 按钮 */
  buttons: Record<string, SelectorEntry>;
  /** 区域 / 容器 */
  regions: Record<string, SelectorEntry>;
  /** 文本框 / 输入 */
  textboxes: Record<string, SelectorEntry>;
  // ============================================================
  // 发布流程控制规则 (v2.1+)
  // ============================================================
  /** 该平台的发布流程规则 (scope/disabled 方式/URL 模式) */
  flowRules?: PublishFlowRules;
  // ============================================================
  // URL 监控配置 (v2.4+) — 网络请求拦截规则
  // ============================================================
  /** 该平台的 URL 监控条目 (API 拦截模式, 替代/补充 DOM 爬取) */
  urlMonitors?: Record<string, UrlMonitorEntry>;
  // ============================================================
  // API 模式配置 (v2.5+) — API 请求模式匹配
  // ============================================================
  /** 该平台的 API 模式配置 */
  apiPatterns?: Record<string, Record<string, unknown>>;
  // ============================================================
  // 数据源配置 (v2.5+) — 外部数据源定义
  // ============================================================
  /** 该平台的数据源配置 */
  dataSources?: Record<string, Record<string, unknown>>;
  // ============================================================
  // 导航流程配置 (v2.5+) — 页面导航流程定义
  // ============================================================
  /** 该平台的导航流程配置 */
  navigationFlows?: Record<string, Record<string, unknown>>;
  // ============================================================
  // Frameworks 配置 (v2.6+) — 框架级配置
  // ============================================================
  /** 该平台的框架配置 */
  frameworks?: Record<string, Record<string, unknown>>;
}

// ============================================================
// 默认配置 — 基于 Python douyin.py/kuaishou.py 等验证
// ============================================================

// ============================================================
// 弃用：DEFAULT_SELECTOR_CONFIG 已被 data/selectors.json 取代
// 运行时配置由 selectorStore.ts 中的 FALLBACK_CONFIG 提供
// 此常量仅导出为向后兼容，未来版本将删除
// ============================================================

/** 完整选择器配置 (顶层结构) */
export interface SelectorConfig {
  version: string;
  updatedAt: string;
  platforms: Record<string, PlatformSelectors>;
}

/** @deprecated 使用 data/selectors.json + SelectorReader 代替 */
export const DEFAULT_SELECTOR_CONFIG: SelectorConfig = {
  version: '1.0.0',
  updatedAt: '2026-06-04T00:00:00.000Z',
  platforms: {},
};

// ============================================================
// SelectorReader — 独立配置读取器
// ============================================================

export class SelectorReader {
  private config: SelectorConfig;

  constructor(config?: SelectorConfig) {
    this.config = config || JSON.parse(JSON.stringify(DEFAULT_SELECTOR_CONFIG));
  }

  /** 获取完整配置（用于 API 查询） */
  getConfig(): SelectorConfig {
    return this.config;
  }

  /** 更新配置（用于 API 写入） */
  updateConfig(config: SelectorConfig): void {
    this.config = config;
    this.config.updatedAt = new Date().toISOString();
    logger.info({ version: config.version }, 'SelectorConfig updated');
  }

  /** 列出所有平台 */
  listPlatforms(): string[] {
    return Object.keys(this.config.platforms);
  }

  /** 获取指定平台的全部选择器 */
  getPlatform(platform: string): PlatformSelectors | null {
    return this.config.platforms[platform] || null;
  }

  /**
   * 获取平台的发布流程规则 (v2.1+) — 缺省时返回空对象 (调用方用 ?? 拼接默认值)
   * 例: const rules = reader.getFlowRules('douyin') ?? {};
   */
  getFlowRules(platform: string): PublishFlowRules | null {
    const p = this.config.platforms[platform];
    if (!p) return null;
    return p.flowRules || null;
  }

  /**
   * 获取流程规则, 缺省时回退到传入的默认值 (避免空对象导致静默)
   */
  getFlowRulesWithFallback(
    platform: string,
    hardcodedFallback: PublishFlowRules,
  ): PublishFlowRules {
    const configured = this.getFlowRules(platform);
    if (configured && Object.keys(configured).length > 0) return configured;
    return hardcodedFallback;
  }

  /**
   * 获取单个选择器
   * @param platform 平台 (douyin/kuaishou/xiaohongshu/bilibili)
   * @param category 类别 (menus/buttons/regions/textboxes)
   * @param name 选择器名称
   * @returns 选择器条目，未找到返回 null
   */
  getSelector(
    platform: string,
    category: SelectorCategory,
    name: string,
  ): SelectorEntry | null {
    const p = this.config.platforms[platform];
    if (!p) return null;
    const cat = p[category];
    if (!cat) return null;
    return cat[name] || null;
  }

  /**
   * 获取选择器的主+回退列表（扁平化为字符串数组）
   * 主选择器放在最前面，回退跟随
   */
  getSelectorList(
    platform: string,
    category: SelectorCategory,
    name: string,
  ): string[] {
    const entry = this.getSelector(platform, category, name);
    if (!entry) return [];
    return [entry.primary, ...entry.fallbacks];
  }

  /**
   * 安全获取选择器列表，配置缺失时回退到硬编码默认值。
   * 避免空数组导致运行时静默失败。
   */
  getSelectorListWithFallback(
    platform: string,
    category: SelectorCategory,
    name: string,
    hardcodedFallback: string[],
  ): string[] {
    const configured = this.getSelectorList(platform, category, name);
    if (configured.length > 0) return configured;
    logger.warn({ platform, category, name }, 'Selector not found in config, using hardcoded fallback');
    return hardcodedFallback;
  }

  /**
   * 按用途过滤选择器
   * @param platform 平台
   * @param purpose 用途 (publish/monitor)
   * @returns 按类别分组的匹配选择器
   */
  getByPurpose(
    platform: string,
    purpose: SelectorPurpose,
  ): Partial<PlatformSelectors> {
    const p = this.config.platforms[platform];
    if (!p) return {};
    const result: Partial<PlatformSelectors> = {};
    for (const cat of ['menus', 'buttons', 'regions', 'textboxes'] as SelectorCategory[]) {
      const entries: Record<string, SelectorEntry> = {};
      for (const [name, entry] of Object.entries(p[cat] || {})) {
        if (entry.purposes.includes(purpose)) {
          entries[name] = entry;
        }
      }
      if (Object.keys(entries).length > 0) {
        result[cat] = entries;
      }
    }
    return result;
  }

  /**
   * 添加或更新选择器
   * @param platform 平台
   * @param category 类别
   * @param name 选择器名称
   * @param entry 选择器配置
   */
  upsertSelector(
    platform: string,
    category: SelectorCategory,
    name: string,
    entry: SelectorEntry,
  ): void {
    if (!this.config.platforms[platform]) {
      this.config.platforms[platform] = {
        menus: {},
        buttons: {},
        regions: {},
        textboxes: {},
      };
    }
    const cat = this.config.platforms[platform][category];
    cat[name] = entry;
    this.config.updatedAt = new Date().toISOString();
    logger.info({ platform, category, name }, 'Selector upserted');
  }

  /**
   * 删除选择器
   */
  deleteSelector(
    platform: string,
    category: SelectorCategory,
    name: string,
  ): boolean {
    const p = this.config.platforms[platform];
    if (!p) return false;
    const cat = p[category];
    if (!cat || !cat[name]) return false;
    delete cat[name];
    this.config.updatedAt = new Date().toISOString();
    logger.info({ platform, category, name }, 'Selector deleted');
    return true;
  }

  /**
   * 更新指定平台的发布流程规则 (v2.1+) — 仅覆盖 flowRules 字段, 其他类别不受影响
   * 传 null/undefined 视为清空
   */
  setFlowRules(platform: string, flowRules: PublishFlowRules | null): boolean {
    const p = this.config.platforms[platform];
    if (!p) return false;
    if (flowRules === null || flowRules === undefined) {
      delete p.flowRules;
    } else {
      p.flowRules = flowRules;
    }
    this.config.updatedAt = new Date().toISOString();
    logger.info({ platform, hasFlowRules: !!flowRules }, 'FlowRules updated');
    return true;
  }

  // ============================================================
  // URL 监控配置 (v2.4+) — 网络请求拦截规则
  // ============================================================

  /** 获取平台的全部 URL 监控条目 */
  getUrlMonitors(platform: string): Record<string, UrlMonitorEntry> | null {
    const p = this.config.platforms[platform];
    if (!p) return null;
    return p.urlMonitors || null;
  }

  /** 获取单个 URL 监控条目 */
  getUrlMonitor(platform: string, name: string): UrlMonitorEntry | null {
    const p = this.config.platforms[platform];
    if (!p || !p.urlMonitors) return null;
    return p.urlMonitors[name] || null;
  }

  /** 整体替换平台的 URL 监控条目 (null 清空) */
  setUrlMonitors(platform: string, monitors: Record<string, UrlMonitorEntry> | null): boolean {
    const p = this.config.platforms[platform];
    if (!p) return false;
    if (monitors === null || monitors === undefined) {
      delete p.urlMonitors;
    } else {
      p.urlMonitors = monitors;
    }
    this.config.updatedAt = new Date().toISOString();
    logger.info({ platform, count: monitors ? Object.keys(monitors).length : 0 }, 'UrlMonitors updated');
    return true;
  }

  /** 新增或更新单个 URL 监控条目 */
  upsertUrlMonitor(platform: string, name: string, entry: UrlMonitorEntry): void {
    if (!this.config.platforms[platform]) {
      this.config.platforms[platform] = {
        menus: {}, buttons: {}, regions: {}, textboxes: {},
      };
    }
    if (!this.config.platforms[platform].urlMonitors) {
      this.config.platforms[platform].urlMonitors = {};
    }
    this.config.platforms[platform].urlMonitors![name] = entry;
    this.config.updatedAt = new Date().toISOString();
    logger.info({ platform, name }, 'UrlMonitor upserted');
  }

  /** 删除单个 URL 监控条目 */
  deleteUrlMonitor(platform: string, name: string): boolean {
    const p = this.config.platforms[platform];
    if (!p || !p.urlMonitors || !p.urlMonitors[name]) return false;
    delete p.urlMonitors[name];
    this.config.updatedAt = new Date().toISOString();
    logger.info({ platform, name }, 'UrlMonitor deleted');
    return true;
  }
}

/**
 * 将旧格式选择器（primary: string）自动转换为新格式 ScopedSelector。
 * 旧格式：{ primary: "css-selector", selectorType: "css", filterTag: "BUTTON", ... }
 * 新格式：{ type: "css", value: "css-selector", scopeMode: "none", filterTag: "BUTTON", ... }
 */
export function normalizeSelector(entry: any): { type: string; value: string; scopeMode: string; frameworkKey?: string; subContainer?: string; customContainer?: string; filterTag?: string; filterText?: string } {
  // 新格式：primary 是对象
  if (typeof entry?.primary === 'object' && entry.primary !== null) {
    return entry.primary;
  }
  // 旧格式：primary 是字符串
  return {
    type: (entry?.selectorType as string) || 'css',
    value: (entry?.primary as string) || '',
    scopeMode: 'none',
    frameworkKey: entry?.scopeKey,
    filterTag: entry?.filterTag,
    filterText: entry?.filterText,
  };
}
