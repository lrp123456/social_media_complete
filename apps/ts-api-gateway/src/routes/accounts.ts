// @ts-api-gateway/routes/accounts.ts - 账号托管 API

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:accounts');

// ============================================================
// 平台图标颜色常量
// ============================================================

export const PLATFORM_COLORS: Record<string, string> = {
  douyin: '#000',
  xiaohongshu: '#ff2442',
  tencent: '#07c160',
  kuaishou: '#fed91b',
  bilibili: '#fb7299',
  baijiahao: '#ff6f00',
};

// ============================================================
// Cookie 状态计算（基于更新时间）
// ============================================================

function computeCookieStatus(
  updatedAt: Date,
): { cookieStatus: 'valid' | 'expiring' | 'expired'; cookieValidDays: number } {
  const daysSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate < 15) {
    return { cookieStatus: 'valid', cookieValidDays: Math.max(1, Math.round(30 - daysSinceUpdate)) };
  }
  if (daysSinceUpdate < 25) {
    return { cookieStatus: 'expiring', cookieValidDays: Math.max(1, Math.round(30 - daysSinceUpdate)) };
  }
  return { cookieStatus: 'expired', cookieValidDays: 0 };
}

/** GET /api/v1/accounts/hosted - 托管账号列表 */
router.get('/hosted', async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    const accounts = users.map((user) => {
      const { cookieStatus, cookieValidDays } = computeCookieStatus(user.updatedAt);
      return {
        id: user.id,
        platform: user.platform,
        accountName: user.wechatUserid,
        windowId: user.fingerprintWindowId,
        cookieStatus,
        cookieValidDays,
      };
    });

    res.json({ success: true, data: accounts });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取托管账号失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
