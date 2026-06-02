// @ts-api-gateway/routes/pinterest.ts - Pinterest 素材采集路由

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PinterestScraper } from '../platforms/pinterest';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:pinterest');

const scrapeSchema = z.object({
  query: z.string().min(1).max(100),
  maxPins: z.number().min(1).max(500).default(50),
  windowId: z.string().min(1),
  options: z
    .object({
      boardId: z.string().optional(),
      saveImages: z.boolean().default(true),
    })
    .optional(),
});

/** POST /api/v1/pinterest/scrape */
router.post('/scrape', async (req: Request, res: Response) => {
  try {
    const parsed = scrapeSchema.parse(req.body);
    const traceId = (req as any).traceId as string;

    const task = {
      taskId: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      traceId,
      windowId: parsed.windowId,
      query: parsed.query,
      maxPins: parsed.maxPins,
      options: parsed.options,
    };

    const scraper = new PinterestScraper();
    // 异步执行（非阻塞）
    scraper.scrape(task).then((result) => {
      logger.info(`[Pinterest] 采集完成: ${result.totalScraped} pins`);
    });

    res.status(202).json({
      success: true,
      taskId: task.taskId,
      message: 'Pinterest 采集任务已启动',
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error('Pinterest 采集失败:', (err as Error).message);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/pinterest/status/:taskId */
router.get('/status/:taskId', async (_req: Request, res: Response) => {
  // 轮询兜底
  res.json({ status: 'running' });
});

export default router;
