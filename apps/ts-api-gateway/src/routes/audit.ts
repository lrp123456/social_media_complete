// @ts-api-gateway/routes/audit.ts - 审计日志 API

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:audit');

/** GET /api/v1/audit/logs?limit=50&platform= - 审计日志（合并 PlatformConfigAudit + OperationLog） */
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const querySchema = z.object({
      limit: z.coerce.number().int().positive().default(50),
      platform: z.string().optional(),
    });
    const { limit, platform } = querySchema.parse(req.query);

    const auditWhere: any = {};
    if (platform) auditWhere.platform = platform;

    const [auditLogs, opLogs] = await Promise.all([
      prisma.platformConfigAudit.findMany({
        where: auditWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.operationLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    // 合并并按时间倒序排列
    const merged = [
      ...auditLogs.map((a) => ({
        id: `audit_${a.id}`,
        time: a.createdAt,
        actor: a.operator,
        action: a.action,
        resource: `${a.platform}/${a.configKey}`,
        status: 'SUCCESS' as const,
      })),
      ...opLogs.map((o) => ({
        id: `op_${o.id}`,
        time: o.createdAt,
        actor: o.userName || 'system',
        action: o.action,
        resource: o.details,
        status: (o.result === 'failure'
          ? 'ERROR'
          : o.level === 'warn'
            ? 'WARN'
            : 'SUCCESS') as 'SUCCESS' | 'WARN' | 'ERROR',
      })),
    ]
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(0, limit);

    res.json({ success: true, data: merged });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取审计日志失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
