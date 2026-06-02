// @ts-api-gateway/routes/publish.ts - 发布任务 API

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { submitPublishTask } from '../services/publishService';
import { createLogger } from '../lib/logger';
import type { PublishTask } from '../platforms/types';
import type { PlatformName } from '@social-media/shared-config';

const router = Router();
const logger = createLogger('routes:publish');

const publishSchema = z.object({
  platform: z.enum(['douyin','kuaishou','xiaohongshu','bilibili','baijiahao','tencent','tiktok']),
  accountId: z.string().min(1),
  windowId: z.string().min(1),
  credentials: z.object({
    username: z.string().min(1),
    cookies: z.record(z.string()).optional(),
    phone: z.string().optional(),
  }),
  video: z.object({
    ossUrl: z.string().url(),
    filename: z.string().min(1),
    size: z.number().positive(),
    duration: z.number().optional(),
  }),
  metadata: z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(5000).default(''),
    tags: z.array(z.string()).default([]),
    coverUrl: z.string().url().optional(),
    scheduleTime: z.string().optional(),
    isOriginal: z.boolean().default(true),
    category: z.string().optional(),
  }),
});

/** POST /api/v1/publish/video */
router.post('/video', async (req: Request, res: Response) => {
  try {
    const parsed = publishSchema.parse(req.body);
    const traceId = (req as any).traceId as string;

    const task: PublishTask = {
      taskId: `pub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      traceId,
      platform: parsed.platform as PlatformName,
      windowId: parsed.windowId,
      accountId: parsed.accountId,
      credentials: parsed.credentials,
      video: parsed.video,
      metadata: parsed.metadata,
    };

    const { jobId } = await submitPublishTask(task);

    logger.info(`发布任务已提交: ${task.taskId}`);
    res.status(202).json({
      success: true,
      taskId: task.taskId,
      jobId,
      message: '发布任务已加入队列',
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error('发布任务提交失败:', (err as Error).message);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/publish/status/:taskId */
router.get('/status/:taskId', async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const job = await import('bullmq').then((m) => m.Job).then(() => null);
  res.json({ taskId, status: 'pending' }); // 简化实现
});

export default router;
