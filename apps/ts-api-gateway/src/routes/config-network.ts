// @ts-api-gateway/routes/config-network.ts — 板块六: 网络路由与物理代理
import { Router, Request, Response } from 'express';

const router = Router();

let NETWORK = {
  proxy: {
    download_proxy_url: 'http://127.0.0.1:7890',
    api: {
      rapidapi_keys: { xiaohongshu: 'rapidapi_key_xxxxxx', tiktok: 'rapidapi_key_xxxxxx', instagram: 'rapidapi_key_xxxxxx' },
      hosts: { xiaohongshu: 'xiaohongshu-all-api.p.rapidapi.com', tiktok: 'tiktok-all-api.p.rapidapi.com' },
    },
  },
};

/** GET /api/v1/config-network */
router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: NETWORK, meta: { carrier: 'PostgreSQL config_entries', strategy: 'cold' } });
});

/** PUT /api/v1/config-network */
router.put('/', (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ success: false, error: '请求体必须是对象' });
  }
  if (req.body.proxy) Object.assign(NETWORK.proxy, req.body.proxy);
  res.json({ success: true, data: NETWORK, message: '代理配置已保存, 下次发布任务出栈时加载' });
});

export default router;
