// @ts-api-gateway/routes/config-infra.ts — 板块一: 基础设施变量
import { Router, Request, Response } from 'express';

const router = Router();

// in-memory 模拟(生产应持久化到 .env / PostgreSQL)
let INFRA: Record<string, string | number> = {
  DB_HOST: process.env.DB_HOST || '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://localhost:5432/social_media',
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
  LITELLM_MASTER_KEY: process.env.LITELLM_MASTER_KEY || '',
  LITELLM_BASE_URL: process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000/v1',
  WEB_PORT: parseInt(process.env.WEB_PORT || '3000'),
  DATA_DIR: process.env.DATA_DIR || './data',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

/** GET /api/v1/config-infra */
router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: INFRA, meta: { carrier: '.env → Docker Compose', strategy: 'restart' } });
});

/** PUT /api/v1/config-infra */
router.put('/', (req: Request, res: Response) => {
  const updates = req.body as Record<string, string | number>;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ success: false, error: '请求体必须是键值对' });
  }
  Object.assign(INFRA, updates);
  res.json({ success: true, data: INFRA, message: '已保存, 需重启对应容器生效' });
});

export default router;
