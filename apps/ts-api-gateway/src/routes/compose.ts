// @ts-api-gateway/routes/compose.ts - 视频合成路由
// TS 端选择素材 → 排序 → HTTP 触发 Python 合成

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { selectMaterials } from '../services/materialService';
import { createLogger } from '../lib/logger';
import { getConfig } from '@social-media/shared-config';

const router = Router();
const logger = createLogger('routes:compose');

const composeSchema = z.object({
  mode: z.enum(['no_narration', 'with_narration']).default('no_narration'),
  strategy: z.enum(['random', 'style_fixed', 'user_uploaded']).default('random'),
  count: z.number().min(1).max(20).default(5),
  style: z.string().optional(),
  platform: z.string().optional(),
  bgm_oss_url: z.string().optional(),
  user_segments: z.array(z.object({
    name: z.string(),
    oss_url: z.string(),
  })).optional(),
  narration_config: z.object({
    voice: z.string().default('default'),
    tone: z.string().default('professional'),
  }).optional(),
});

/** POST /api/v1/compose - TS选素材 → HTTP触发Python合成 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = composeSchema.parse(req.body);
    const traceId = (req as any).traceId as string;
    const taskId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 1. TS 端选择素材并排序
    const userSegments = parsed.user_segments?.map(s => ({
      name: s.name,
      file: s.oss_url,
    }));

    const { segments } = await selectMaterials(parsed.strategy, {
      count: parsed.count,
      style: parsed.style,
      platform: parsed.platform as any,
      user_segments: userSegments,
    });

    // 2. HTTP 调用 Python Worker
    const config = getConfig();
    const response = await axios.post(
      `${config.PYTHON_WORKER_URL}/api/v1/tasks/compose`,
      {
        task_id: taskId,
        mode: parsed.mode,
        segments,
        bgm_oss_url: parsed.bgm_oss_url,
        style: parsed.style || 'modern',
        narration_config: parsed.narration_config,
      },
      { headers: { 'X-Trace-Id': traceId } },
    );

    res.status(202).json({
      success: true,
      taskId,
      arq_job_id: response.data.arq_job_id,
      mode: parsed.mode,
      segments: segments.length,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error('合成请求失败:', (err as Error).message);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
