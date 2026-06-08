// @ts-api-gateway/routes/security.ts — 板块八: 权限安全密钥
import { Router, Request, Response } from 'express';

const router = Router();

let API_KEY = 'your_api_gateway_key';

/** GET /api/v1/security/api-key — 返回脱敏后的 API Key */
router.get('/api-key', (_req: Request, res: Response) => {
  const masked = API_KEY.slice(0, 8) + '...' + API_KEY.slice(-4);
  res.json({ success: true, data: { masked, lastRotated: '2026-01-15' }, meta: { carrier: 'PostgreSQL config_audit_log (只读历史流)', strategy: 'readonly' } });
});

/** PUT /api/v1/security/api-key — 轮换 API Key */
router.put('/api-key', (req: Request, res: Response) => {
  const { newKey } = req.body;
  if (!newKey || typeof newKey !== 'string' || newKey.length < 16) {
    return res.status(400).json({ success: false, error: '新 Key 长度必须 ≥ 16 字符' });
  }
  const oldMask = API_KEY.slice(0, 8) + '...';
  API_KEY = newKey;
  const newMask = API_KEY.slice(0, 8) + '...' + API_KEY.slice(-4);
  res.json({
    success: true,
    data: { masked: newMask, lastRotated: new Date().toISOString().split('T')[0] },
    message: `已轮换 (旧: ${oldMask})。请同步更新所有微服务的 X-API-Key 头。`,
  });
});

export default router;
