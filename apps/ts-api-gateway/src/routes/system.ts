// @ts-api-gateway/routes/system.ts - 运营看板 API

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:system');

/** GET /api/v1/system/overview - 运营看板首页 */
router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [monitorUsers, todayNewComments, pendingPublishTasks, systemStatus, recentActivities] =
      await Promise.all([
        prisma.user.count(),
        prisma.comment.count({ where: { createdAt: { gte: todayStart } } }),
        prisma.taskRecord.count({ where: { status: { in: ['pending', 'running'] } } }),
        prisma.systemStatus.findFirst({ orderBy: { id: 'desc' } }),
        prisma.operationLog.findMany({ orderBy: { createdAt: 'desc' }, take: 5 }),
      ]);

    res.json({
      success: true,
      data: {
        monitorUsers,
        todayNewComments,
        pendingPublishTasks,
        systemStatus: systemStatus
          ? {
              id: systemStatus.id,
              status: systemStatus.status,
              totalChecks: systemStatus.totalChecks,
              lastCheckTime: systemStatus.lastCheckTime,
            }
          : null,
        recentActivities: recentActivities.map((log) => ({
          id: log.id,
          time: log.createdAt,
          action: log.action,
          details: log.details,
          userName: log.userName,
        })),
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取运营概览失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/system/debug-mode - 获取调试模式状态 */
router.get('/debug-mode', async (_req: Request, res: Response) => {
  try {
    const status = await prisma.systemStatus.findFirst();
    res.json({ success: true, data: { enabled: status?.isDebugMode ?? false } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取调试模式状态失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** PUT /api/v1/system/debug-mode - 设置调试模式 */
router.put('/debug-mode', async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }

    const status = await prisma.systemStatus.findFirst();
    if (status) {
      await prisma.systemStatus.update({ where: { id: status.id }, data: { isDebugMode: enabled } });
    } else {
      await prisma.systemStatus.create({ data: { id: 1, isDebugMode: enabled } });
    }

    logger.info({ enabled }, '调试模式已切换');
    res.json({ success: true, data: { enabled } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '设置调试模式失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
