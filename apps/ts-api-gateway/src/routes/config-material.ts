// config-material.ts — 素材更新配置路由
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getMaterialUpdateConfig,
  saveMaterialUpdateConfig,
  type Platform,
} from '../services/materialUpdateConfig';
import { testPlatform } from '../services/materialUpdateService';
import { reloadMaterialUpdateScheduler } from '../services/materialUpdateScheduler';
import { logger } from '../lib/logger';

export const configMaterialRouter = Router();

// ============================================================
// GET /api/v1/config-material — 读取配置
// ============================================================
configMaterialRouter.get('/', (_req: Request, res: Response) => {
  const config = getMaterialUpdateConfig();
  res.json({
    success: true,
    data: config,
    meta: {
      carrier: 'data/settings-overrides.json',
      strategy: 'hot',
    },
  });
});

// ============================================================
// PUT /api/v1/config-material — 保存配置 + 触发调度器 reload
// ============================================================
const putBodySchema = z.object({}).passthrough(); // 允许任意字段，前端发完整配置对象

configMaterialRouter.put('/', (req: Request, res: Response) => {
  const parsed = putBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const merged = saveMaterialUpdateConfig(parsed.data);
  reloadMaterialUpdateScheduler();
  logger.info('[config-material] 配置已保存，调度器已重载');

  res.json({
    success: true,
    data: merged,
    message: '配置已保存，下次抓取生效',
  });
});

// ============================================================
// POST /api/v1/config-material/test — 测试单个平台 curl + 解析回显
// ============================================================
configMaterialRouter.post('/test', async (req: Request, res: Response) => {
  const platform = req.body as Platform;
  if (!platform || !platform.id || !platform.request?.url) {
    res.status(400).json({ success: false, error: '缺少 platform.id 或 platform.request.url' });
    return;
  }

  try {
    const result = await testPlatform(platform);
    res.json({
      success: true,
      data: {
        videoCount: result.videos.length,
        videos: result.videos.slice(0, 10), // 最多回显 10 条
      },
    });
  } catch (err) {
    logger.error(`[config-material] 测试平台 ${platform.id} 失败: ${err}`);
    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
