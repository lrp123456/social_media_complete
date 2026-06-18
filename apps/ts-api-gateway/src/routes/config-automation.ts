// @ts-api-gateway/routes/config-automation.ts — 板块五: 自动化矩阵核心
import { Router, Request, Response } from 'express';
import { getSelectorReader, saveSelectorConfig, resetSelectorConfig } from '../lib/selectorStore';
import type { SelectorCategory } from '@social-media/browser-core';

const router = Router();

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** categoryKey 解析: "menus:menu_home" → { category: "menus", name: "menu_home" } */
function parseCategoryKey(raw: string): { category: SelectorCategory; name: string } | null {
  const categoryKey = param(raw);
  const idx = categoryKey.indexOf(':');
  if (idx < 0) return null;
  const category = categoryKey.slice(0, idx) as SelectorCategory;
  const name = categoryKey.slice(idx + 1);
  const validCategories: SelectorCategory[] = ['menus', 'buttons', 'regions', 'textboxes'];
  if (!validCategories.includes(category) || !name) return null;
  return { category, name };
}

let AUTOMATION = {
  monitor: {
    // 所有 interval 值单位为秒（不是分钟）
    interval_active_min: 180, interval_active_max: 300,     // 高频周期: 180-300秒 (3-5分钟)
    interval_idle_min: 900, interval_idle_max: 1200,        // 空闲周期: 900-1200秒 (15-20分钟)
    idle_threshold: 4, sleep_start_hour: 2, sleep_end_hour: 8,
  },
  browser: { max_tab_reuse: 20, enable_warmup: true },
};

/** 获取自动化配置（供其他模块读取） */
export function getAutomationConfig() {
  return AUTOMATION;
}

/** GET /api/v1/config-automation */
router.get('/', (_req: Request, res: Response) => {
  const reader = getSelectorReader();
  const platforms = reader.listPlatforms();
  res.json({
    success: true,
    data: AUTOMATION,
    selectors: { platforms, total: reader.getConfig() },
  });
});

/** PUT /api/v1/config-automation */
router.put('/', (req: Request, res: Response) => {
  if (req.body.monitor) Object.assign(AUTOMATION.monitor, req.body.monitor);
  if (req.body.browser) Object.assign(AUTOMATION.browser, req.body.browser);

  // 如果监控间隔配置发生变化，重启调度器
  if (req.body.monitor && (req.body.monitor.interval_idle_min || req.body.monitor.interval_idle_max)) {
    import('../services/monitorService').then(({ restartMonitorScheduler }) => {
      restartMonitorScheduler();
    }).catch(() => {});
  }

  res.json({ success: true, data: AUTOMATION, message: '配置已热重载, 下次 Job 启动前自动读取' });
});

// ============================================================
// 选择器管理 — 全面重构：按 平台→类别→选择器名 组织
// 类别: menus / buttons / regions / textboxes
// ============================================================

/** GET /api/v1/config-automation/selectors — 获取全部或按平台过滤 */
router.get('/selectors', (req: Request, res: Response) => {
  try {
    const reader = getSelectorReader();
    const platform = String(req.query.platform || '');
    if (platform) {
      const data = reader.getPlatform(platform);
      if (!data) return res.status(404).json({ success: false, error: `平台不存在: ${platform}` });
      return res.json({ success: true, data });
    }
    // Query filters
    const categoryFilter = String(req.query.category || '');
    const purposeFilter = String(req.query.purpose || '');
    // 展平所有选择器为前端友好的列表格式
    let flatResult: Array<{
      platform: string; category: string; name: string;
      primary: string; fallbacks: string[]; purposes: string[];
      selectorType: string; description: string; enabled: boolean; updatedAt: string;
    }> = [];
    const config = reader.getConfig();
    for (const [pName, pSelectors] of Object.entries(config.platforms)) {
      for (const cat of ['menus', 'buttons', 'regions', 'textboxes'] as SelectorCategory[]) {
        for (const [name, entry] of Object.entries(pSelectors[cat] || {})) {
          flatResult.push({
            platform: pName, category: cat, name,
            primary: entry.primary,
            fallbacks: entry.fallbacks,
            purposes: entry.purposes,
            selectorType: entry.selectorType,
            description: entry.description || '',
            enabled: (entry as any).enabled !== false,
            updatedAt: config.updatedAt,
          });
        }
      }
    }
    if (categoryFilter) flatResult = flatResult.filter((s) => s.category === categoryFilter);
    if (purposeFilter) flatResult = flatResult.filter((s) => s.purposes.includes(purposeFilter));
    res.json({ success: true, data: flatResult });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/v1/config-automation/selectors/flow-rules — 获取所有平台的流程规则 (含 scope/disabled 检测方式/URL 模式)
 *  v2.1+: 让管理员能在前端查看 "发布按钮搜索范围"、"成功/导航 URL 模式" 等流程级配置
 */
router.get('/selectors/flow-rules', (_req: Request, res: Response) => {
  try {
    const reader = getSelectorReader();
    const config = reader.getConfig();
    const result: Record<string, { flowRules: any; updatedAt: string }> = {};
    for (const [pName, pSelectors] of Object.entries(config.platforms)) {
      result[pName] = {
        flowRules: (pSelectors as any).flowRules || {},
        updatedAt: config.updatedAt,
      };
    }
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT /api/v1/config-automation/selectors/flow-rules — 更新指定平台的流程规则
 *  Body: { platform: string, flowRules: PublishFlowRules | null }
 *  flowRules 为 null 或 {reset:true} 时清空该平台流程规则 (回退到 BasePublisher 硬编码默认)
 */
router.put('/selectors/flow-rules', (req: Request, res: Response) => {
  try {
    const { platform, flowRules, reset } = req.body ?? {};
    if (!platform || typeof platform !== 'string') {
      return res.status(400).json({ success: false, error: '缺少必填字段: platform (string)' });
    }
    const reader = getSelectorReader();
    const platformData = reader.getPlatform(platform);
    if (!platformData) {
      return res.status(404).json({ success: false, error: `平台不存在: ${platform}` });
    }
    let payload: any = null;
    if (reset === true) {
      payload = null;
    } else {
      if (!flowRules || typeof flowRules !== 'object') {
        return res.status(400).json({ success: false, error: '缺少必填字段: flowRules (object)' });
      }
      payload = flowRules;
    }
    const ok = reader.setFlowRules(platform, payload);
    if (!ok) return res.status(500).json({ success: false, error: 'setFlowRules 失败' });
    saveSelectorConfig();
    res.json({
      success: true,
      message: payload === null
        ? `已重置 ${platform} 的流程规则 (回退到硬编码默认)`
        : `已更新 ${platform} 的流程规则 (${Object.keys(payload).length} 字段)`,
      data: { platform, flowRules: payload, updatedAt: reader.getConfig().updatedAt },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT — 新增或更新选择器 (deprecated: use PUT /selectors/:platform/:categoryKey instead) */
router.put('/selectors', (req: Request, res: Response) => {
  res.set('X-Deprecated', 'true');
  res.set('X-Successor', 'PUT /selectors/:platform/:categoryKey');
  try {
    const { platform, category, name, purposes, primary, fallbacks, selectorType, description, enabled, filterTag, filterText, scopeKey } = req.body;
    const errors: string[] = [];
    if (!platform) errors.push('platform is required');
    if (!category) errors.push('category is required');
    if (!name) errors.push('name is required');
    if (!primary) errors.push('primary is required');
    const validCategories: SelectorCategory[] = ['menus', 'buttons', 'regions', 'textboxes'];
    if (category && !validCategories.includes(category)) errors.push(`invalid category: ${category}`);
    const validPurposes = ['publish', 'monitor'] as const;
    if (Array.isArray(purposes)) {
      const invalid = purposes.filter((p: string) => !(validPurposes as readonly string[]).includes(p));
      if (invalid.length > 0) errors.push(`invalid purposes: ${invalid.join(', ')}`);
    }
    const validTypes = ['css', 'role', 'text', 'placeholder', 'label'];
    if (selectorType && !validTypes.includes(selectorType)) errors.push(`invalid selectorType: ${selectorType}`);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; '), errors });
    }
    const reader = getSelectorReader();
    reader.upsertSelector(platform, category as SelectorCategory, name, {
      purposes: purposes || ['publish'],
      primary: String(primary),
      fallbacks: fallbacks || [],
      selectorType: selectorType || 'css',
      description: description || '',
      enabled: typeof enabled === 'boolean' ? enabled : true,
      filterTag: filterTag || undefined,
      filterText: filterText || undefined,
      scopeKey: scopeKey || undefined,
    });
    saveSelectorConfig();
    res.json({ success: true, message: `选择器已更新: ${platform}/${category}/${name}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE — 删除选择器 (deprecated: use DELETE /selectors/:platform/:categoryKey instead) */
router.delete('/selectors', (req: Request, res: Response) => {
  res.set('X-Deprecated', 'true');
  res.set('X-Successor', 'DELETE /selectors/:platform/:categoryKey');
  try {
    const { platform, category, name } = req.body;
    if (!platform || !category || !name) {
      return res.status(400).json({ success: false, error: '缺少必填字段: platform, category, name' });
    }
    const reader = getSelectorReader();
    const ok = reader.deleteSelector(platform, category as SelectorCategory, name);
    if (!ok) return res.status(404).json({ success: false, error: '选择器不存在' });
    saveSelectorConfig();
    res.json({ success: true, message: `选择器已删除: ${platform}/${category}/${name}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /reset — 重置选择器 */
router.post('/selectors/reset', (_req: Request, res: Response) => {
  try {
    const config = resetSelectorConfig();
    res.json({ success: true, data: config, message: '选择器配置已重置为默认值' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 选择器管理 — 新版 RESTful 路由（与 admin-dashboard 对齐）
// 路径: PUT/DELETE /api/v1/config-automation/selectors/:platform/:categoryKey
// categoryKey 格式: "<category>:<name>"，如 "menus:menu_home" / "buttons:btn_upload"
// Body (PUT): { selector_value: <JSON string of SelectorEntry>, description?: string, enabled?: boolean }
// Body (DELETE): 无
// ============================================================

const VALID_CATEGORIES_TUPLE: SelectorCategory[] = ['menus', 'buttons', 'regions', 'textboxes'];
const VALID_PURPOSES_TUPLE = ['publish', 'monitor'] as const;
const VALID_TYPES_TUPLE = ['css', 'role', 'text', 'placeholder', 'label'] as const;

router.put('/selectors/:platform/:categoryKey', (req: Request, res: Response) => {
  try {
    const platform = param(req.params.platform);
    const categoryKey = param(req.params.categoryKey);
    const parsed = parseCategoryKey(categoryKey);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        error: 'categoryKey 格式错误：应为 "<category>:<name>"，如 "menus:menu_home"',
      });
    }
    const { category, name } = parsed;
    const { selector_value, description, enabled } = req.body ?? {};
    if (typeof selector_value !== 'string' || selector_value.length === 0) {
      return res.status(400).json({ success: false, error: '缺少 selector_value (string)' });
    }
    let entryJson: any;
    try {
      entryJson = JSON.parse(selector_value);
    } catch (err: any) {
      return res.status(400).json({ success: false, error: `selector_value 不是合法 JSON: ${err.message}` });
    }
    // 字段归一化 + 校验
    if (!Array.isArray(entryJson.purposes) || entryJson.purposes.length === 0) {
      entryJson.purposes = ['publish'];
    }
    entryJson.purposes = entryJson.purposes.filter((p: string) =>
      (VALID_PURPOSES_TUPLE as readonly string[]).includes(p),
    );
    if (entryJson.purposes.length === 0) entryJson.purposes = ['publish'];
    if (typeof entryJson.primary !== 'string' || !entryJson.primary) {
      return res.status(400).json({ success: false, error: 'selector_value.primary 必填' });
    }
    if (!Array.isArray(entryJson.fallbacks)) entryJson.fallbacks = [];
    if (typeof entryJson.selectorType !== 'string' || !(VALID_TYPES_TUPLE as readonly string[]).includes(entryJson.selectorType)) {
      // 自动按 primary 推断
      if (entryJson.primary.startsWith('getByRole')) entryJson.selectorType = 'role';
      else if (entryJson.primary.startsWith('getByText')) entryJson.selectorType = 'text';
      else if (entryJson.primary.startsWith('getByPlaceholder')) entryJson.selectorType = 'placeholder';
      else if (entryJson.primary.startsWith('getByLabel')) entryJson.selectorType = 'label';
      else entryJson.selectorType = 'css';
    }
    entryJson.description = typeof description === 'string' ? description
      : (typeof entryJson.description === 'string' ? entryJson.description : '');
    // enabled 字段：从 body 或 entryJson 中读取，默认 true
    entryJson.enabled = typeof enabled === 'boolean' ? enabled
      : (typeof entryJson.enabled === 'boolean' ? entryJson.enabled : true);
    const reader = getSelectorReader();
    // 如果提供了 originalPlatform 和 originalCategoryKey，说明是编辑操作且 key 可能变更
    const { originalPlatform, originalCategoryKey } = req.body ?? {};
    if (originalPlatform && originalCategoryKey && (originalPlatform !== platform || originalCategoryKey !== `${category}:${name}`)) {
      // key 变更：先删除旧条目
      const origParsed = parseCategoryKey(String(originalCategoryKey));
      if (origParsed) {
        reader.deleteSelector(String(originalPlatform), origParsed.category as SelectorCategory, origParsed.name);
      }
    }
    reader.upsertSelector(platform, category, name, entryJson);
    saveSelectorConfig();
    return res.json({
      success: true,
      message: `选择器已更新: ${platform}/${category}/${name}`,
      data: { platform, category, name, entry: entryJson, enabled: entryJson.enabled },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/selectors/:platform/:categoryKey', (req: Request, res: Response) => {
  try {
    const platform = param(req.params.platform);
    const categoryKey = param(req.params.categoryKey);
    const parsed = parseCategoryKey(categoryKey);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        error: 'categoryKey 格式错误：应为 "<category>:<name>"',
      });
    }
    const { category, name } = parsed;
    const reader = getSelectorReader();
    const ok = reader.deleteSelector(platform, category, name);
    if (!ok) {
      return res.status(404).json({ success: false, error: `选择器不存在: ${platform}/${category}/${name}` });
    }
    saveSelectorConfig();
    return res.json({
      success: true,
      message: `选择器已删除: ${platform}/${category}/${name}`,
      data: { platform, category, name },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// 选择器有效性追踪
// ============================================================

/** GET /api/v1/config-automation/selectors/full — 获取完整嵌套配置 */
router.get('/selectors/full', (_req: Request, res: Response) => {
  try {
    const reader = getSelectorReader();
    res.json({ success: true, data: reader.getConfig() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/v1/config-automation/selectors/effectiveness — 查询选择器有效性统计 */
router.get('/selectors/effectiveness', async (req: Request, res: Response) => {
  try {
    const { getSelectorEffectiveness, getFailedSelectors } = await import(
      '../services/selectorEffectivenessService'
    );
    const platform = req.query.platform ? String(req.query.platform) : undefined;
    const stats = await getSelectorEffectiveness(platform);
    const failed = await getFailedSelectors(0.3, 3);
    res.json({
      success: true,
      data: { stats, failed },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
