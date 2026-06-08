// @ts-api-gateway/routes/tasks.ts - 创作任务 API
// 注意: TS 端禁止执行 FFmpeg，仅查询任务状态

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:tasks');

// 创作任务类型（与 compose/render/material 相关）
const CREATION_TASK_TYPES = ['compose', 'render', 'material'];

/** GET /api/v1/tasks/creation?limit=20 - 创作任务 pipeline */
router.get('/creation', async (req: Request, res: Response) => {
  try {
    const querySchema = z.object({
      limit: z.coerce.number().int().positive().default(20),
    });
    const { limit } = querySchema.parse(req.query);

    const tasks = await prisma.taskRecord.findMany({
      where: { taskType: { in: CREATION_TASK_TYPES } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({
      success: true,
      data: tasks.map((t) => ({
        taskId: t.taskId,
        taskType: t.taskType,
        status: t.status,
        progress: t.status === 'completed' ? 100 : t.status === 'running' ? 50 : 0,
        etaSeconds: t.status === 'running' ? 120 : null,
        params: t.params ? JSON.parse(t.params) : null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取创作任务失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/tasks/:taskId - 单个任务详情 */
router.get('/:taskId', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ taskId: z.string().min(1) });
    const { taskId } = paramsSchema.parse(req.params);

    const task = await prisma.taskRecord.findUnique({ where: { taskId } });

    if (!task) {
      return res.status(404).json({ success: false, error: `Task not found: ${taskId}` });
    }

    res.json({
      success: true,
      data: {
        taskId: task.taskId,
        taskType: task.taskType,
        status: task.status,
        progress: task.status === 'completed' ? 100 : task.status === 'running' ? 50 : 0,
        etaSeconds: task.status === 'running' ? 120 : null,
        params: task.params ? JSON.parse(task.params) : null,
        result: task.result ? JSON.parse(task.result) : null,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取任务详情失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
