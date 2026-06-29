// material-update.ts — 素材更新运行态路由
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getMaterialUpdateConfig } from '../services/materialUpdateConfig';
import { runMaterialUpdate, isRunning, getRunState } from '../services/materialUpdateService';
import { logger } from '../lib/logger';

export const materialUpdateRouter = Router();

// ============================================================
// POST /api/v1/material-update/run — 手动触发采集（支持 styleDir/count 覆盖）
// 请求体: { styleDir?: string, count?: number }
// ============================================================
const runBodySchema = z.object({
  styleDir: z.string().optional(),
  count: z.number().int().positive().optional(),
});

materialUpdateRouter.post('/run', async (req: Request, res: Response) => {
  const parsed = runBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  if (isRunning()) {
    res.status(409).json({ success: false, error: '采集正在运行中' });
    return;
  }

  const { styleDir, count } = parsed.data;

  // 非阻塞触发
  runMaterialUpdate({ styleDir, count }).catch((err) => {
    logger.error(`[material-update] 手动触发失败: ${err}`);
  });

  res.status(202).json({ success: true, message: styleDir ? `采集已触发（风格: ${styleDir}）` : '采集已触发（全部风格）' });
});

// ============================================================
// GET /api/v1/material-update/status — 运行态 + key 冷却状态
// ============================================================
materialUpdateRouter.get('/status', async (_req: Request, res: Response) => {
  const config = getMaterialUpdateConfig();
  const runState = getRunState();
  const now = Date.now();

  const platformStatus = config.platforms.map((p) => {
    const state = config.keyCooldownState[p.id] || {};
    const keys = p.keyPool.keys.map((k) => {
      const expiry = state[k];
      const cooledDown = expiry && expiry > now;
      return {
        masked: k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : k,
        cooledDown: !!cooledDown,
        cooldownRemaining: cooledDown ? expiry - now : 0,
      };
    });
    return {
      platformId: p.id,
      platformName: p.name,
      enabled: p.enabled,
      keys,
    };
  });

  try {
    const counts = await prisma.hotVideoCandidate.groupBy({
      by: ['status'],
      _count: true,
    });
    const candidateCounts: Record<string, number> = {};
    for (const c of counts) candidateCounts[c.status] = c._count;

    res.json({
      success: true,
      data: {
        running: runState.running,
        lastRunAt: runState.lastRunAt,
        lastResult: runState.lastResult,
        platforms: platformStatus,
        candidateCounts,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ============================================================
// GET /api/v1/material-update/candidates — 候选视频分页预览
// ============================================================
const candidatesQuerySchema = z.object({
  page: z.string().optional().default('1'),
  pageSize: z.string().optional().default('20'),
  platformId: z.string().optional(),
  status: z.string().optional(),
});

materialUpdateRouter.get('/candidates', async (req: Request, res: Response) => {
  const parsed = candidatesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const { page, pageSize, platformId, status } = parsed.data;
  const pageNum = parseInt(page, 10);
  const size = parseInt(pageSize, 10);

  const where: Record<string, unknown> = {};
  if (platformId) where.platform = platformId;
  if (status) where.status = status;

  try {
    const [items, total] = await Promise.all([
      prisma.hotVideoCandidate.findMany({
        where,
        orderBy: { fetchedAt: 'desc' },
        skip: (pageNum - 1) * size,
        take: size,
      }),
      prisma.hotVideoCandidate.count({ where }),
    ]);

    res.json({
      success: true,
      data: { items, total, page: pageNum, pageSize: size },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ============================================================
// POST /api/v1/material-update/webhook — Python Worker 完成回调
// ============================================================
const webhookBodySchema = z.object({
  candidate_id: z.string().optional(),
  task_id: z.string(),
  status: z.string(),
  style: z.string().nullable().optional(),
  result: z.record(z.unknown()).optional(),
  error: z.string().nullable().optional(),
});

materialUpdateRouter.post('/webhook', async (req: Request, res: Response) => {
  const parsed = webhookBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const { candidate_id, status, style } = parsed.data;

  logger.info(`[material-update] webhook 回调: candidate=${candidate_id} status=${status} style=${style}`);

  if (candidate_id) {
    try {
      const candidateStatus = status === 'completed'
        ? (style ? 'accepted' : 'rejected')
        : 'rejected';

      await prisma.hotVideoCandidate.update({
        where: { id: candidate_id },
        data: {
          status: candidateStatus,
          style: style || null,
        },
      });
      logger.info(`[material-update] 候选 ${candidate_id} 更新为 ${candidateStatus}`);
    } catch (err) {
      logger.error(`[material-update] 更新候选 ${candidate_id} 失败: ${err}`);
    }
  }

  res.json({ success: true });
});
