// @ts-api-gateway/routes/config.ts - 配置管理 API

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { updatePlatformConfig, getPlatformConfigs } from '../services/configService';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:config');

const configSchema = z.object({
  platform: z.string().min(1),
  configKey: z.string().min(1),
  configValue: z.string(),
  description: z.string().optional(),
  operator: z.string().default('api'),
});

/** POST /api/v1/config */
router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = configSchema.parse(req.body);
    const result = await updatePlatformConfig(
      parsed.platform,
      parsed.configKey,
      parsed.configValue,
      parsed.operator,
      parsed.description,
    );
    res.json({ success: true, config: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error('配置更新失败:', (err as Error).message);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/config/:platform */
router.get('/:platform', async (req: Request, res: Response) => {
  const configs = await getPlatformConfigs(req.params.platform);
  res.json({ success: true, configs });
});

export default router;
