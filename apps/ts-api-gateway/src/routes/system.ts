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

export default router;
