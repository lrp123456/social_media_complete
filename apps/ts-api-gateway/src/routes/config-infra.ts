// @ts-api-gateway/routes/config-infra.ts — 板块一: 基础设施变量
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { reloadBrowserVendors } from '../services/browserApiService';

const router = Router();

// 持久化到 data/infra-overrides.json（挂载卷，重启不丢失）
const OVERRIDES_FILE = path.resolve(process.cwd(), 'data', 'infra-overrides.json');

/** 读取已保存的覆盖值 */
function loadOverrides(): Record<string, string | number> {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** 保存覆盖值到文件 */
function saveOverrides(overrides: Record<string, string | number>): void {
  const dir = path.dirname(OVERRIDES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf-8');
}

// 启动时加载覆盖值并应用到 process.env
const savedOverrides = loadOverrides();
for (const [k, v] of Object.entries(savedOverrides)) {
  process.env[k] = String(v);
}

// 构建 INFRA（process.env 优先，含已加载的覆盖值）
const INFRA: Record<string, string | number> = {
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
  // 指纹浏览器 API 地址
  ROXY_BROWSER_URL: process.env.ROXY_BROWSER_URL || 'http://localhost:54345',
  BIT_BROWSER_URL: process.env.BIT_BROWSER_URL || 'http://localhost:54346',
};

/** GET /api/v1/config-infra */
router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: INFRA, meta: { carrier: 'data/infra-overrides.json → Docker env', strategy: 'restart' } });
});

/** PUT /api/v1/config-infra */
router.put('/', (req: Request, res: Response) => {
  const updates = req.body as Record<string, string | number>;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ success: false, error: '请求体必须是键值对' });
  }
  // 更新内存
  Object.assign(INFRA, updates);
  // 合并到已保存的覆盖值
  const overrides = { ...loadOverrides(), ...updates };
  delete overrides.DATABASE_URL; // 不允许覆盖
  saveOverrides(overrides);
  // 如果修改了浏览器 URL，自动热重载
  const browserKeys = ['ROXY_BROWSER_URL', 'BIT_BROWSER_URL'];
  if (Object.keys(updates).some((k) => browserKeys.includes(k))) {
    try {
      reloadBrowserVendors();
    } catch (err: any) {
      console.error('[config-infra] 热重载浏览器失败:', err.message);
    }
  }
  res.json({ success: true, data: INFRA, message: '已保存, 需重启对应容器生效' });
});

/** POST /api/v1/config-infra/reload-browsers — 手动热重载浏览器供应商 */
router.post('/reload-browsers', (_req: Request, res: Response) => {
  try {
    reloadBrowserVendors();
    res.json({ success: true, message: '浏览器供应商已重载' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
