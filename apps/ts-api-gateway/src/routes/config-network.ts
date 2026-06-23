// @ts-api-gateway/routes/config-network.ts — 板块六: 网络路由与物理代理
import { Router, Request, Response } from 'express';
import { getSection, saveSection } from '../lib/settingsStore';

const router = Router();

const networkDefaults = {
  proxy: {
    download_proxy_url: process.env.DOWNLOAD_PROXY_URL || '',
    api: {
      rapidapi_keys: {} as Record<string, string>,
      hosts: {} as Record<string, string>,
    },
  },
};

const NETWORK = getSection('network', networkDefaults);

/** GET /api/v1/config-network */
router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: NETWORK, meta: { carrier: 'data/settings-overrides.json', strategy: 'hot' } });
});

/** PUT /api/v1/config-network */
router.put('/', (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ success: false, error: '请求体必须是对象' });
  }
  if (req.body.proxy) Object.assign(NETWORK.proxy, req.body.proxy);
  saveSection('network', NETWORK);
  res.json({ success: true, data: NETWORK, message: '代理配置已保存, 下次发布任务出栈时加载' });
});

export default router;
