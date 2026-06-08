// @ts-api-gateway/routes/materials.ts - 素材更新 API
// 提供素材采集、归档、统计等功能于 /api/v1/materials/ 命名空间下

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { PinterestScraper } from '../platforms/pinterest';

const router = Router();
const logger = createLogger('routes:materials');

// ============================================================
// 类型定义
// ============================================================

interface MaterialItem {
  id: string;
  thumbnail: string;
  title: string;
  style: string;   // 奶油风, 侘寂风, 现代简约, 国潮混搭
  room: string;    // 客厅, 卧室, 厨房, 卫浴
  quality: 'S' | 'A' | 'B' | 'C';
  source: string;  // pinterest, douyin, xiaohongshu, bilibili
  sourceLabel: string;
  date: string;
  likes: number;
  saves: number;
  ossUrl?: string;
}

// ============================================================
// 模拟数据
// ============================================================

const STYLES = ['奶油风', '侘寂风', '现代简约', '国潮混搭'] as const;
const ROOMS = ['客厅', '卧室', '厨房', '卫浴'] as const;
const QUALITIES: ('S' | 'A' | 'B' | 'C')[] = ['S', 'A', 'B', 'C'];
const SOURCES = ['pinterest', 'douyin', 'xiaohongshu', 'bilibili'] as const;
const SOURCE_LABELS: Record<string, string> = {
  pinterest: 'Pinterest',
  douyin: '抖音',
  xiaohongshu: '小红书',
  bilibili: 'B站',
};

function randomItem<T>(arr: readonly T[] | T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateMockMaterials(count: number): MaterialItem[] {
  const materials: MaterialItem[] = [];
  for (let i = 0; i < count; i++) {
    const style = randomItem(STYLES);
    const room = randomItem(ROOMS);
    const source = randomItem(SOURCES);
    const date = `2025-${String(randomInt(1, 6)).padStart(2, '0')}-${String(randomInt(1, 28)).padStart(2, '0')}`;
    materials.push({
      id: `mat_${String(i + 1).padStart(3, '0')}`,
      thumbnail: `https://picsum.photos/seed/mat_${i + 1}/400/300`,
      title: `${style}${room}设计案例 ${i + 1}`,
      style,
      room,
      quality: randomItem(QUALITIES),
      source,
      sourceLabel: SOURCE_LABELS[source],
      date,
      likes: randomInt(10, 500),
      saves: randomInt(5, 200),
      ossUrl: Math.random() > 0.3 ? `https://oss.example.com/materials/mat_${String(i + 1).padStart(3, '0')}.jpg` : undefined,
    });
  }
  return materials;
}

// 预生成 24 条模拟素材
const MOCK_MATERIALS = generateMockMaterials(24);

// ============================================================
// Zod 校验 schema
// ============================================================

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  style: z.string().optional(),
  room: z.string().optional(),
  quality: z.enum(['S', 'A', 'B', 'C']).optional(),
  source: z.string().optional(),
  status: z.string().optional(),
});

const collectBodySchema = z.object({
  platform: z.string().min(1).max(50),
  query: z.string().min(1).max(100),
  maxPins: z.number().int().min(1).max(500).default(50),
  windowId: z.string().min(1),
  filters: z
    .object({
      likeThreshold: z.number().int().optional(),
      saveThreshold: z.number().int().optional(),
      categoryTag: z.string().optional(),
    })
    .optional(),
});

// ============================================================
// 1. GET / — 分页素材列表
// ============================================================

router.get('/', async (req: Request, res: Response) => {
  try {
    const { page, pageSize, style, room, quality, source, status: _status } =
      listQuerySchema.parse(req.query);

    let filtered = [...MOCK_MATERIALS];

    if (style) {
      filtered = filtered.filter((m) => m.style === style);
    }
    if (room) {
      filtered = filtered.filter((m) => m.room === room);
    }
    if (quality) {
      filtered = filtered.filter((m) => m.quality === quality);
    }
    if (source) {
      filtered = filtered.filter((m) => m.source === source);
    }

    const total = filtered.length;
    const offset = (page - 1) * pageSize;
    const items = filtered.slice(offset, offset + pageSize);

    res.json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取素材列表失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 2. POST /collect — 触发采集
// ============================================================

router.post('/collect', async (req: Request, res: Response) => {
  try {
    const parsed = collectBodySchema.parse(req.body);
    const traceId = (req as any).traceId as string;

    const task = {
      taskId: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      traceId,
      windowId: parsed.windowId,
      query: parsed.query,
      maxPins: parsed.maxPins,
      options: {
        ...(parsed.filters?.likeThreshold ? { minWidth: parsed.filters.likeThreshold } : {}),
        saveImages: true,
      },
    };

    const scraper = new PinterestScraper();
    // 异步执行（非阻塞）
    scraper.scrape(task).then((result) => {
      logger.info(`[Materials] 采集完成: ${result.totalScraped} items`);
    });

    res.status(202).json({
      success: true,
      taskId: task.taskId,
      message: '素材采集任务已启动',
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '触发素材采集失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 3. GET /collect/status/:taskId — 采集任务状态
// ============================================================

router.get('/collect/status/:taskId', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ taskId: z.string().min(1) });
    paramsSchema.parse(req.params);

    res.json({
      success: true,
      data: {
        status: 'running',
        progress: 45,
        elapsed: 120,
        itemsScraped: 23,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取采集状态失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 4. DELETE /:id — 软删除素材
// ============================================================

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse(req.params);

    res.json({
      success: true,
      id,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '删除素材失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 5. GET /stats — 素材统计
// ============================================================

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: {
        total: 248,
        byStyle: { '奶油风': 68, '侘寂风': 52, '现代简约': 85, '国潮混搭': 43 },
        byRoom: { '客厅': 72, '卧室': 58, '厨房': 61, '卫浴': 57 },
        byQuality: { 'S': 32, 'A': 89, 'B': 86, 'C': 41 },
        bySource: { 'pinterest': 120, 'douyin': 65, 'xiaohongshu': 43, 'bilibili': 20 },
        recentCollections: [
          { taskId: 'pin_001', date: '2025-06-02', count: 45, query: '奶油风客厅' },
          { taskId: 'pin_002', date: '2025-06-01', count: 32, query: '现代简约卧室' },
        ],
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取素材统计失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
