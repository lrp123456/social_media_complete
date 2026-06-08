// @ts-api-gateway/routes/configSelector.ts
// 选择器管理 CRUD API
// 路径: /api/v1/config-automation/selectors
// 前台管理入口: 系统设置 → 自动化矩阵核心 → 选择器管理

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '../lib/logger';
import { getSelectorReader, saveSelectorConfig, resetSelectorConfig } from '../lib/selectorStore';

const router = Router();
const logger = createLogger('routes:configSelector');

function handleError(res: Response, err: unknown, message: string) {
  logger.error({ err }, message);
  res.status(500).json({ success: false, error: (err as Error).message || message });
}

// ============================================================
// GET / — 获取完整选择器配置
// ============================================================
router.get('/', (_req: Request, res: Response) => {
  try {
    const reader = getSelectorReader();
    res.json({ success: true, data: reader.getConfig() });
  } catch (err) {
    handleError(res, err, '获取选择器配置失败');
  }
});

// ============================================================
// GET /platforms — 列出所有平台
// ============================================================
router.get('/platforms', (_req: Request, res: Response) => {
  try {
    const reader = getSelectorReader();
    res.json({ success: true, data: reader.listPlatforms() });
  } catch (err) {
    handleError(res, err, '获取平台列表失败');
  }
});

// ============================================================
// GET /:platform — 获取指定平台的全部选择器
// ============================================================
router.get('/:platform', (req: Request, res: Response) => {
  try {
    const platform = String(req.params.platform);
    const reader = getSelectorReader();
    const data = reader.getPlatform(platform);
    if (!data) {
      return res.status(404).json({ success: false, error: `平台不存在: ${platform}` });
    }
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err, '获取平台选择器失败');
  }
});

// ============================================================
// GET /:platform/purpose/:purpose — 按用途获取选择器
// ============================================================
router.get('/:platform/purpose/:purpose', (req: Request, res: Response) => {
  try {
    const platform = String(req.params.platform);
    const purpose = String(req.params.purpose);
    if (purpose !== 'publish' && purpose !== 'monitor') {
      return res.status(400).json({ success: false, error: '用途必须是 publish 或 monitor' });
    }
    const reader = getSelectorReader();
    const data = reader.getByPurpose(platform, purpose as 'publish' | 'monitor');
    res.json({ success: true, data });
  } catch (err) {
    handleError(res, err, '按用途获取选择器失败');
  }
});

// ============================================================
// PUT / — 新增或更新选择器
// Body: { platform, category, name, entry }
// ============================================================
const upsertSchema = z.object({
  platform: z.string().min(1),
  category: z.enum(['menus', 'buttons', 'regions', 'textboxes']),
  name: z.string().min(1),
  entry: z.object({
    purposes: z.array(z.enum(['publish', 'monitor'])).nonempty(),
    primary: z.string().min(1),
    fallbacks: z.array(z.string()).default([]),
    selectorType: z.enum(['css', 'role', 'text', 'placeholder', 'label']),
    description: z.string().optional(),
    // v2.1+ 可选
    filterTag: z.string().min(1).optional(),
    filterText: z.string().min(1).optional(),
    scopeKey: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  }),
});

router.put('/', (req: Request, res: Response) => {
  try {
    const parsed = upsertSchema.parse(req.body);
    const reader = getSelectorReader();
    reader.upsertSelector(parsed.platform, parsed.category, parsed.name, parsed.entry);
    saveSelectorConfig();
    res.json({ success: true, message: `选择器已更新: ${parsed.platform}/${parsed.category}/${parsed.name}` });
  } catch (err: any) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ success: false, error: err.message });
    }
    handleError(res, err, '更新选择器失败');
  }
});

// ============================================================
// DELETE / — 删除选择器
// Body: { platform, category, name }
// ============================================================
const deleteSchema = z.object({
  platform: z.string().min(1),
  category: z.enum(['menus', 'buttons', 'regions', 'textboxes']),
  name: z.string().min(1),
});

router.delete('/', (req: Request, res: Response) => {
  try {
    const parsed = deleteSchema.parse(req.body);
    const reader = getSelectorReader();
    const ok = reader.deleteSelector(parsed.platform, parsed.category, parsed.name);
    if (!ok) {
      return res.status(404).json({ success: false, error: '选择器不存在' });
    }
    saveSelectorConfig();
    res.json({ success: true, message: `选择器已删除: ${parsed.platform}/${parsed.category}/${parsed.name}` });
  } catch (err: any) {
    if (err.name === 'ZodError') {
      return res.status(400).json({ success: false, error: err.message });
    }
    handleError(res, err, '删除选择器失败');
  }
});

// ============================================================
// POST /reset — 重置为默认配置
// ============================================================
router.post('/reset', (_req: Request, res: Response) => {
  try {
    const config = resetSelectorConfig();
    res.json({ success: true, data: config, message: '选择器配置已重置为默认值' });
  } catch (err) {
    handleError(res, err, '重置选择器失败');
  }
});

// ============================================================
// 选择器有效性追踪 API
// ============================================================

/**
 * GET /effectiveness — 查询选择器有效性统计
 * Query params: platform, category, name
 */
router.get('/effectiveness', async (req: Request, res: Response) => {
  try {
    const { getSelectorEffectiveness } = await import('../services/selectorEffectivenessService');
    const platform = req.query.platform ? String(req.query.platform) : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;
    const name = req.query.name ? String(req.query.name) : undefined;

    const stats = await getSelectorEffectiveness(platform, category, name);
    res.json({ success: true, data: stats, total: stats.length });
  } catch (err) {
    handleError(res, err, '查询选择器有效性统计失败');
  }
});

/**
 * GET /effectiveness/failed — 查询失效选择器（成功率低于阈值）
 * Query params: threshold (0-1, default 0.3), minAttempts (default 5)
 */
router.get('/effectiveness/failed', async (req: Request, res: Response) => {
  try {
    const { getFailedSelectors } = await import('../services/selectorEffectivenessService');
    const threshold = req.query.threshold ? parseFloat(String(req.query.threshold)) : 0.3;
    const minAttempts = req.query.minAttempts ? parseInt(String(req.query.minAttempts), 10) : 5;

    const failed = await getFailedSelectors(threshold, minAttempts);
    res.json({ success: true, data: failed, total: failed.length, threshold, minAttempts });
  } catch (err) {
    handleError(res, err, '查询失效选择器失败');
  }
});

/**
 * GET /effectiveness/best — 查询每个选择器的最佳策略
 * Query params: platform
 */
router.get('/effectiveness/best', async (req: Request, res: Response) => {
  try {
    const { getBestStrategies } = await import('../services/selectorEffectivenessService');
    const platform = req.query.platform ? String(req.query.platform) : undefined;

    const bestMap = await getBestStrategies(platform);
    const data = Array.from(bestMap.entries()).map(([key, stats]) => ({
      key,
      ...stats,
    }));
    res.json({ success: true, data, total: data.length });
  } catch (err) {
    handleError(res, err, '查询最佳策略失败');
  }
});

export default router;
