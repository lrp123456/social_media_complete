// @ts-api-gateway/routes/webhook.ts - Python Worker 回调接收端点

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('webhook');

router.post('/python-callback', async (req: Request, res: Response) => {
  const traceId = (req as any).traceId as string;
  const { task_id, status, result, error } = req.body;

  logger.info(`📥 Webhook 回调: ${task_id} (${status})`);

  try {
    // 更新任务记录
    const updated = await prisma.taskRecord.update({
      where: { taskId: task_id },
      data: {
        status: status === 'completed' ? 'completed' : 'failed',
        result: result ? JSON.stringify(result) : null,
        error: error ?? null,
      },
    });

    logger.info(`✅ 任务状态已更新: ${task_id} → ${status}`);

    res.json({
      success: true,
      task_id,
      trace_id: traceId,
    });
  } catch (err) {
    logger.error(`Webhook 处理失败: ${(err as Error).message}`);
    res.status(500).json({
      success: false,
      error: (err as Error).message,
    });
  }
});

export default router;
