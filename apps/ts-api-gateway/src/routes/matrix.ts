// @ts-api-gateway/routes/matrix.ts - 社媒矩阵统一 API
// 收拢发布、账号、监控、评论于 /api/v1/matrix/ 命名空间下

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { getRedis } from '../lib/redis';
import { submitPublishTask } from '../services/publishService';
import type { PublishTask } from '../platforms/types';
import type { PlatformName } from '@social-media/shared-config';
import { getAllSchedulerStatuses, resetSchedulerTimer, restartMonitorScheduler, markJobCancelled, cancelledJobIds } from '../services/monitorService';
import { enqueueReply, enqueueMonitor, getAllJobs, findJobByTaskId, getWindowQueue, getAllWindowQueues } from '../services/unifiedQueue';

const router = Router();
const logger = createLogger('routes:matrix');

// ============================================================
// 平台显示名称映射
// ============================================================

const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  baijiahao: '百家号',
  tencent: '腾讯视频号',
  tiktok: 'TikTok',
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

// ============================================================
// 通用错误处理包装
// ============================================================

function handleError(res: Response, logger: ReturnType<typeof createLogger>, err: unknown, message: string) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, errors: err.errors });
  }
  logger.error({ err: (err as Error).message }, message);
  res.status(500).json({ success: false, error: (err as Error).message });
}

// ============================================================
// 1. Accounts
// ============================================================

/** GET /api/v1/matrix/accounts — 托管账号列表 */
router.get('/accounts', async (_req: Request, res: Response) => {
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
    handleError(res, logger, err, '获取托管账号失败');
  }
});

/** POST /api/v1/matrix/accounts/check-login — 检查账号登录状态 */
router.post('/accounts/check-login', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      accountId: z.string().min(1),
    });
    const { accountId } = bodySchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: Number(accountId) } });
    if (!user) {
      return res.status(404).json({ success: false, error: `账号不存在: ${accountId}` });
    }

    const { cookieStatus, cookieValidDays } = computeCookieStatus(user.updatedAt);
    const loggedIn = cookieStatus !== 'expired';

    res.json({
      success: true,
      data: {
        id: user.id,
        platform: user.platform,
        accountName: user.wechatUserid,
        loggedIn,
        cookieStatus,
        cookieValidDays,
        lastUpdated: user.updatedAt,
      },
    });
  } catch (err) {
    handleError(res, logger, err, '检查登录状态失败');
  }
});

// ============================================================
// 2. Publish
// ============================================================

const publishSchema = z.object({
  platform: z.enum(['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok']),
  accountId: z.string().min(1),
  windowId: z.string().min(1),
  credentials: z.object({
    username: z.string().min(1),
    cookies: z.record(z.string()).optional(),
    phone: z.string().optional(),
  }),
  video: z.object({
    ossUrl: z.string().url(),
    filename: z.string().min(1),
    size: z.number().positive(),
    duration: z.number().optional(),
  }),
  metadata: z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(5000).default(''),
    tags: z.array(z.string()).default([]),
    coverUrl: z.string().url().optional(),
    scheduleTime: z.string().optional(),
    isOriginal: z.boolean().default(true),
    category: z.string().optional(),
  }),
});

/** POST /api/v1/matrix/publish — 提交发布任务 */
router.post('/publish', async (req: Request, res: Response) => {
  try {
    const parsed = publishSchema.parse(req.body);
    const traceId = (req as any).traceId as string;

    const task: PublishTask = {
      taskId: `pub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      traceId,
      platform: parsed.platform as PlatformName,
      windowId: parsed.windowId,
      accountId: parsed.accountId,
      credentials: parsed.credentials,
      video: parsed.video,
      metadata: parsed.metadata,
    };

    const { jobId } = await submitPublishTask(task);

    logger.info(`发布任务已提交: ${task.taskId}`);
    res.status(202).json({
      success: true,
      taskId: task.taskId,
      jobId,
      message: '发布任务已加入队列',
    });
  } catch (err) {
    handleError(res, logger, err, '发布任务提交失败');
  }
});

/** GET /api/v1/matrix/publish/tasks — 发布任务列表 */
router.get('/publish/tasks', async (_req: Request, res: Response) => {
  try {
    const logs = await prisma.operationLog.findMany({
      where: { action: { startsWith: 'publish' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const tasks = logs.map((log) => {
      let details: Record<string, unknown> = {};
      try {
        details = JSON.parse(log.details);
      } catch {
        // ignore parse errors
      }
      return {
        id: log.id,
        taskId: (details.taskId as string) ?? log.id,
        action: log.action,
        platform: (details.platform as string) ?? 'unknown',
        status: log.result,
        userName: log.userName,
        createdAt: log.createdAt,
      };
    });

    res.json({ success: true, data: tasks });
  } catch (err) {
    handleError(res, logger, err, '获取发布任务列表失败');
  }
});

/** GET /api/v1/matrix/publish/tasks/batch-status?ids=pub_xxx,pub_yyy — 批量查询任务状态 (必须在 :taskId 之前注册) */
router.get('/publish/tasks/batch-status', async (req: Request, res: Response) => {
  try {
    const idsParam = (req.query.ids as string) || '';
    const taskIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (taskIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const results = await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          const job = await findJobByTaskId(taskId);
          const log = await prisma.operationLog.findFirst({
            where: { details: { contains: taskId } },
            orderBy: { createdAt: 'desc' },
          });

          let status: 'queued' | 'running' | 'completed' | 'failed';
          let error: string | undefined;

          if (!job) {
            if (log) {
              status = log.result === 'success' ? 'completed' : 'failed';
              if (log.result === 'failure') {
                try { const d = JSON.parse(log.details); error = d.error as string; } catch {}
              }
            } else {
              status = 'completed';
            }
          } else if (await job.isCompleted()) {
            status = 'completed';
          } else if (await job.isFailed()) {
            status = 'failed';
            error = job.failedReason || '未知错误';
          } else if (await job.isActive()) {
            status = 'running';
          } else {
            status = 'queued';
          }

          const details = log ? (() => { try { return JSON.parse(log.details); } catch { return {}; } })() : {};

          // 获取 BullMQ job 进度数据（由 worker 的 job.updateProgress() 设置）
          let progress: { phase: string; step: string; percent: number; detail?: string } | null = null;
          if (job) {
            try {
              const p = await job.progress;
              if (p && typeof p === 'object' && 'phase' in p) {
                progress = p as any;
              }
            } catch {}
          }

          return {
            taskId,
            status,
            platform: (details.platform as string) ?? (job?.data as any)?.platform ?? 'unknown',
            userId: (job?.data as any)?.userId ?? 0,
            error,
            details,
            progress,
          };
        } catch {
          return { taskId, status: 'failed' as const, platform: 'unknown' as const, userName: '', error: '查询失败' };
        }
      }),
    );

    res.json({ success: true, data: results });
  } catch (err) {
    handleError(res, logger, err, '批量查询任务状态失败');
  }
});

/** GET /api/v1/matrix/publish/tasks/:taskId — 发布任务详情 */
router.get('/publish/tasks/:taskId', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ taskId: z.string().min(1) });
    const { taskId } = paramsSchema.parse(req.params);

    const log = await prisma.operationLog.findFirst({
      where: { details: { contains: taskId } },
      orderBy: { createdAt: 'desc' },
    });

    if (!log) {
      return res.status(404).json({ success: false, error: `任务不存在: ${taskId}` });
    }

    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(log.details);
    } catch {
      // ignore parse errors
    }

    res.json({
      success: true,
      data: {
        taskId,
        action: log.action,
        platform: (details.platform as string) ?? 'unknown',
        status: log.result,
        userName: log.userName,
        details,
        createdAt: log.createdAt,
      },
    });
  } catch (err) {
    handleError(res, logger, err, '获取发布任务详情失败');
  }
});

/** GET /api/v1/matrix/monitor/tasks/batch-status?ids=mon_xxx,mon_yyy — 批量查询监控任务状态 */
router.get('/monitor/tasks/batch-status', async (req: Request, res: Response) => {
  try {
    const idsParam = (req.query.ids as string) || '';
    const taskIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (taskIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const results = await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          const job = await findJobByTaskId(taskId);
          const log = await prisma.operationLog.findFirst({
            where: { details: { contains: taskId } },
            orderBy: { createdAt: 'desc' },
          });

          let status: 'queued' | 'running' | 'completed' | 'failed';
          let error: string | undefined;

          if (!job) {
            if (log) {
              status = log.result === 'success' ? 'completed' : 'failed';
              if (log.result === 'failure') {
                try { const d = JSON.parse(log.details); error = d.error as string; } catch {}
              }
            } else {
              status = 'completed';
            }
          } else if (await job.isCompleted()) {
            status = 'completed';
          } else if (await job.isFailed()) {
            status = 'failed';
            error = job.failedReason || '未知错误';
          } else if (await job.isActive()) {
            status = 'running';
          } else {
            status = 'queued';
          }

          const details = log ? (() => { try { return JSON.parse(log.details); } catch { return {}; } })() : {};

          // 获取任务进度（通过 job.updateProgress 设置）
          let progress: any = undefined;
          if (job && status === 'running') {
            try {
              const p = await job.progress;
              if (p && typeof p === 'object' && 'phase' in p) {
                progress = p;
              }
            } catch {}
          }

          return {
            taskId,
            status,
            platform: (details.platform as string) ?? (job?.data as any)?.platform ?? 'unknown',
            userId: (job?.data as any)?.userId ?? 0,
            error,
            details,
            progress,
          };
        } catch {
          return { taskId, status: 'failed' as const, platform: 'unknown' as const, userId: 0, error: '查询失败', details: {} };
        }
      }),
    );

    res.json({ success: true, data: results });
  } catch (err) {
    handleError(res, logger, err, '批量查询监控任务状态失败');
  }
});

// ============================================================
// 3. Monitor — Active Tasks (live queue)
// ============================================================

/** GET /api/v1/matrix/monitor/active-tasks — 获取所有活跃/排队中的监控任务 */
router.get('/monitor/active-tasks', async (_req: Request, res: Response) => {
  try {
    const [active, waiting, delayed] = await Promise.all([
      getAllJobs(['active']),
      getAllJobs(['waiting']),
      getAllJobs(['delayed']),
    ]);

    const allJobs = [...active, ...waiting, ...delayed];
    const seen = new Set<string>();
    const tasks: any[] = [];

    for (const job of allJobs) {
      const bullJobId = job.id;
      const data = job.data as any;
      const taskId = data.taskId || bullJobId || '';

      // 跳过已取消的任务
      if (cancelledJobIds.has(bullJobId)) {
        continue;
      }

      if (seen.has(taskId)) continue;
      seen.add(taskId);

      let progress: any = null;
      try { const p = await job.progress; if (p && typeof p === 'object' && 'phase' in p) progress = p; } catch {}

      tasks.push({
        taskId,
        platform: data.platform || 'unknown',
        userId: data.userId,
        windowId: data.windowId || data.fingerprintWindowId || 'unknown',
        status: await job.isActive() ? 'running' : 'queued',
        progress,
      });
    }

    // 按窗口分组
    const byWindow = new Map<string, any[]>();
    for (const t of tasks) {
      const k = t.windowId;
      if (!byWindow.has(k)) byWindow.set(k, []);
      byWindow.get(k)!.push(t);
    }

    const running = tasks.filter(t => t.status === 'running').length;
    res.json({
      success: true,
      data: {
        total: tasks.length, running, queued: tasks.length - running,
        windows: Array.from(byWindow.entries()).map(([windowId, windowTasks]) => ({ windowId, tasks: windowTasks })),
      },
    });
  } catch (err) {
    handleError(res, logger, err, '获取活跃任务失败');
  }
});

/** POST /api/v1/matrix/monitor/tasks/:taskId/cancel — 强制取消任务 */
router.post('/monitor/tasks/:taskId/cancel', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ taskId: z.string().min(1) });
    const { taskId } = paramsSchema.parse(req.params);

    // 查找任务 — 通过 data.taskId 查找
    const [active, waiting, delayed] = await Promise.all([
      getAllJobs(['active']),
      getAllJobs(['waiting']),
      getAllJobs(['delayed']),
    ]);

    const allJobs = [...active, ...waiting, ...delayed];
    const job = allJobs.find(j => (j.data as any)?.taskId === taskId);

    if (!job) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }

    const bullJobId = job.id;
    const isActive = await job.isActive();

    logger.info({ taskId, bullJobId, isActive }, '开始强制取消任务');

    // Step 1: 通知 worker 停止执行（最重要！）
    markJobCancelled(bullJobId);

    // Step 2: 标记任务为丢弃（不再重试）
    try {
      await job.discard();
    } catch {}

    // Step 2: 从 Redis 强制删除任务及其锁
    try {
      const redis = getRedis();
      const queueName = 'platform';

      // 删除任务相关的所有 Redis key
      const keysToDelete = [
        `bull:${queueName}:${bullJobId}`,
        `bull:${queueName}:${bullJobId}:logs`,
        `bull:${queueName}:${bullJobId}:lock`,
        `bull:${queueName}:lock:${bullJobId}`,
      ];

      // 从各种状态集合中移除
      const setsToRemove = [
        `bull:${queueName}:active`,
        `bull:${queueName}:wait`,
        `bull:${queueName}:waiting`,
        `bull:${queueName}:delayed`,
        `bull:${queueName}:completed`,
        `bull:${queueName}:failed`,
      ];

      // 批量删除 key
      if (keysToDelete.length > 0) {
        await redis.del(...keysToDelete);
      }

      // 从集合中移除
      for (const setName of setsToRemove) {
        await redis.srem(setName, bullJobId).catch(() => {});
        await redis.zrem(setName, bullJobId).catch(() => {});
      }

      // 清理可能的锁
      const lockKeys = await redis.keys(`bull:${queueName}:*:${bullJobId}:lock`);
      if (lockKeys.length > 0) {
        await redis.del(...lockKeys);
      }

      logger.info({ taskId, bullJobId, deletedKeys: keysToDelete }, '已从 Redis 强制删除任务');
    } catch (redisErr: any) {
      logger.warn({ taskId, bullJobId, error: redisErr.message }, 'Redis 清理部分失败');
    }

    // Step 3: 尝试标准移除（兜底）
    try {
      await job.remove();
    } catch {}

    res.json({
      success: true,
      message: `任务已强制取消${isActive ? '（运行中任务已中断）' : ''}`,
    });
  } catch (err) {
    handleError(res, logger, err, '强制取消任务失败');
  }
});

/** POST /api/v1/matrix/monitor/active-tasks/cancel-all — 强制取消所有任务 */
router.post('/monitor/active-tasks/cancel-all', async (_req: Request, res: Response) => {
  try {
    const [active, waiting, delayed] = await Promise.all([
      getAllJobs(['active']),
      getAllJobs(['waiting']),
      getAllJobs(['delayed']),
    ]);

    const allJobs = [...active, ...waiting, ...delayed];
    const redis = getRedis();
    const queueName = 'platform';
    let cancelled = 0;

    for (const job of allJobs) {
      try {
        const bullJobId = job.id;

        // Step 1: 通知 worker 停止执行（最重要！）
        markJobCancelled(bullJobId);

        // Step 2: 标记为丢弃
        await job.discard().catch(() => {});

        // Step 3: 从 Redis 强制删除
        const keysToDelete = [
          `bull:${queueName}:${bullJobId}`,
          `bull:${queueName}:${bullJobId}:logs`,
          `bull:${queueName}:${bullJobId}:lock`,
          `bull:${queueName}:lock:${bullJobId}`,
        ];

        await redis.del(...keysToDelete).catch(() => {});

        // Step 4: 从集合中移除（不同类型用不同命令）
        // active 是 LIST → 用 LREM
        await redis.lrem(`bull:${queueName}:active`, 1, bullJobId).catch(() => {});
        // wait/waiting/delayed 是 ZSET → 用 ZREM
        for (const setName of [
          `bull:${queueName}:wait`,
          `bull:${queueName}:waiting`,
          `bull:${queueName}:delayed`,
        ]) {
          await redis.zrem(setName, bullJobId).catch(() => {});
        }

        // Step 5: 清理锁
        const lockKeys = await redis.keys(`bull:${queueName}:*:${bullJobId}:lock`);
        if (lockKeys.length > 0) {
          await redis.del(...lockKeys).catch(() => {});
        }

        // Step 6: 标准移除
        await job.remove().catch(() => {});

        cancelled++;
      } catch {}
    }

    logger.info({ cancelled, total: allJobs.length }, '已强制取消所有任务');

    res.json({
      success: true,
      message: `已强制取消 ${cancelled} 个任务`,
    });
  } catch (err) {
    handleError(res, logger, err, '强制取消所有任务失败');
  }
});

// ============================================================
// 3. Monitor — Individual Accounts
// ============================================================

/** GET /api/v1/matrix/monitor/accounts — 独立监控用户列表 */
router.get('/monitor/accounts', async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { videos: true } },
        videos: {
          select: { id: true },
        },
      },
    });

    // 批量查询操作员信息（用于获取用户名称）
    const windowIds = [...new Set(users.map((u) => u.fingerprintWindowId))];
    const windows = await prisma.browserWindow.findMany({
      where: { externalId: { in: windowIds } },
      include: {
        operator: { select: { id: true, displayName: true, wechatUserId: true } },
      },
    });
    const windowMap = new Map(windows.map((w) => [w.externalId, w]));

    // For each user, get total comment count (sum of video.commentCount) and new comment count
    const enriched = await Promise.all(
      users.map(async (user) => {
        const [totalCommentsSum, newComments, lastMonitorTime] = await Promise.all([
          user._count.videos > 0
            ? prisma.video.aggregate({ where: { userId: user.id }, _sum: { commentCount: true } })
            : Promise.resolve({ _sum: { commentCount: 0 } }),
          prisma.comment.count({ where: { video: { userId: user.id }, isNew: 1 } }),
          prisma.monitorStatus.findFirst({
            where: { accountId: String(user.id), platform: user.platform },
            select: { lastCheckTime: true },
          }),
        ]);

        const window = windowMap.get(user.fingerprintWindowId);
        const operator = window?.operator;

        return {
          id: user.id,
          platform: user.platform,
          platformName: PLATFORM_DISPLAY_NAMES[user.platform] || user.platform,
          fingerprintWindowId: user.fingerprintWindowId,
          windowName: window?.windowName || '',
          operatorId: operator?.id || null,
          operatorName: operator?.displayName || '',
          wechatUserId: operator?.wechatUserId || user.wechatUserid,
          status: user.status,
          monitoringEnabled: user.monitoringEnabled,
          videoCount: user._count.videos,
          totalComments: totalCommentsSum._sum.commentCount ?? 0,
          newComments,
          lastCheckTime: lastMonitorTime?.lastCheckTime || null,
          cooldownUntil: user.cooldownUntil ? Number(user.cooldownUntil) : 0,
          createdAt: user.createdAt,
        };
      }),
    );

    res.json({ success: true, data: enriched });
  } catch (err) {
    handleError(res, logger, err, '获取监控用户列表失败');
  }
});

// ============================================================
// 3. Monitor — Users
// ============================================================

/** GET /api/v1/matrix/monitor/users — 监控目标按平台聚合 */
router.get('/monitor/users', async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany();

    // 按 platform 分组聚合
    const grouped = new Map<
      string,
      {
        platform: string;
        displayName: string;
        userCount: number;
        videoCount: number;
        commentCount: number;
        monitoringEnabled: boolean;
      }
    >();

    for (const user of users) {
      const p = user.platform;
      if (!grouped.has(p)) {
        grouped.set(p, {
          platform: p,
          displayName: PLATFORM_DISPLAY_NAMES[p] || p,
          userCount: 0,
          videoCount: 0,
          commentCount: 0,
          monitoringEnabled: user.monitoringEnabled,
        });
      }
      const entry = grouped.get(p)!;
      entry.userCount++;
      if (!user.monitoringEnabled) entry.monitoringEnabled = false;
    }

    // 并行查询每个平台的视频和评论数
    const platformEntries = Array.from(grouped.values());
    const enriched = await Promise.all(
      platformEntries.map(async (entry) => {
        const platformUsers = users.filter((u) => u.platform === entry.platform);
        const userIds = platformUsers.map((u) => u.id);

        const videoCount = userIds.length > 0
            ? await prisma.video.count({ where: { userId: { in: userIds } } })
            : 0;
        const commentSum = userIds.length > 0
            ? await prisma.video.aggregate({ where: { userId: { in: userIds } }, _sum: { commentCount: true } })
            : { _sum: { commentCount: 0 } };
        const commentCount = commentSum._sum.commentCount ?? 0;

        return { ...entry, videoCount, commentCount };
      }),
    );

    res.json({ success: true, data: enriched });
  } catch (err) {
    handleError(res, logger, err, '获取监控目标失败');
  }
});

// ============================================================
// 3. Monitor — Videos
// ============================================================

/** GET /api/v1/matrix/monitor/videos — 监控视频列表 */
router.get('/monitor/videos', async (req: Request, res: Response) => {
  try {
    const querySchema = z.object({
      platform: z.string().optional(),
      search: z.string().optional(),
      limit: z.coerce.number().int().positive().default(50),
    });
    const { platform, search, limit } = querySchema.parse(req.query);

    const where: any = {};
    if (platform) where.user = { platform };
    if (search) where.description = { contains: search, mode: 'insensitive' };

    const videos = await prisma.video.findMany({
      where,
      orderBy: { createTime: 'desc' },
      take: limit,
      include: {
        user: { select: { platform: true, fingerprintWindowId: true } },
        _count: { select: { comments: true } },
      },
    });

    res.json({
      success: true,
      data: videos.map((v) => ({
        id: v.id,
        userId: v.userId,
        description: v.description,
        createTime: Number(v.createTime),
        commentCount: v.commentCount,
        platform: v.user.platform,
        windowId: v.user.fingerprintWindowId,
        metrics: v.metrics ? JSON.parse(v.metrics) : null,
      })),
    });
  } catch (err) {
    handleError(res, logger, err, '获取监控视频失败');
  }
});

/** GET /api/v1/matrix/monitor/videos/:id/comments — 视频评论树（含层级关系） */
router.get('/monitor/videos/:id/comments', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const querySchema = z.object({ limit: z.coerce.number().int().positive().default(100) });

    const { id } = paramsSchema.parse(req.params);
    const { limit } = querySchema.parse(req.query);

    const comments = await prisma.comment.findMany({
      where: { videoId: id },
      orderBy: { createTime: 'desc' },
      take: limit,
    });

    // 构建评论树：根评论 + 子回复
    const roots = comments.filter((c) => c.level === 1);
    const replies = comments.filter((c) => c.level === 2);

    const replyMap = new Map<string, any[]>();
    for (const r of replies) {
      const root = r.rootId || 'orphan';
      if (!replyMap.has(root)) replyMap.set(root, []);
      replyMap.get(root)!.push({
        id: r.id, cid: r.cid, text: r.text,
        userNickname: r.userNickname,
        createTime: Number(r.createTime),
        diggCount: r.diggCount,
        replyToName: r.replyToName,
        isNew: r.isNew === 1,
        isAuthor: r.isAuthor,
        suggestedReply: r.suggestedReply,
        suggestionStatus: r.suggestionStatus,
        suggestionModel: r.suggestionModel,
        suggestionLatencyMs: r.suggestionLatencyMs,
        replyStatus: r.replyStatus,
      });
    }

    const tree = roots.map((root) => ({
      id: root.id, cid: root.cid, text: root.text,
      userNickname: root.userNickname,
      createTime: Number(root.createTime),
      diggCount: root.diggCount,
      isNew: root.isNew === 1,
      isAuthor: root.isAuthor,
      suggestedReply: root.suggestedReply,
      suggestionStatus: root.suggestionStatus,
      suggestionModel: root.suggestionModel,
      suggestionLatencyMs: root.suggestionLatencyMs,
      replyStatus: root.replyStatus,
      replies: replyMap.get(root.cid) || [],
    }));

    res.json({ success: true, data: tree, total: comments.length, rootCount: roots.length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取视频评论失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/matrix/monitor/videos/:id/read-all — 标记视频下所有评论已读 */
router.post('/monitor/videos/:id/read-all', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse(req.params);

    const result = await prisma.comment.updateMany({
      where: { videoId: id, isNew: 1 },
      data: { isNew: 0 },
    });

    await prisma.operationLog.create({
      data: {
        action: 'comment_mark_read_all',
        details: JSON.stringify({ videoId: id, count: result.count }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, count: result.count });
  } catch (err) {
    handleError(res, logger, err, '标记视频评论已读失败');
  }
});

// ============================================================
// 3. Monitor — Comments Operations
// ============================================================

/** POST /api/v1/matrix/monitor/comments/:id/read — 标记单条评论已读 */
router.post('/monitor/comments/:id/read', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const { id } = paramsSchema.parse(req.params);

    const existing = await prisma.comment.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: `评论不存在: ${id}` });
    }

    await prisma.comment.update({ where: { id }, data: { isNew: 0 } });

    await prisma.operationLog.create({
      data: {
        action: 'comment_mark_read',
        details: JSON.stringify({ commentId: id, videoId: existing.videoId }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, id });
  } catch (err) {
    handleError(res, logger, err, '标记评论已读失败');
  }
});

/** POST /api/v1/matrix/monitor/comments/read-all — 批量标记所有未读评论已读 */
router.post('/monitor/comments/read-all', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({ videoId: z.string().optional() });
    const { videoId } = bodySchema.parse(req.body);

    const where: any = { isNew: 1 };
    if (videoId) where.videoId = videoId;

    const result = await prisma.comment.updateMany({ where, data: { isNew: 0 } });

    await prisma.operationLog.create({
      data: {
        action: 'comment_mark_read_all',
        details: JSON.stringify({ videoId: videoId ?? null, count: result.count }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, count: result.count });
  } catch (err) {
    handleError(res, logger, err, '批量标记评论已读失败');
  }
});

/** POST /api/v1/matrix/monitor/comments/:id/reply — 回复评论（入队 BullMQ 执行） */
router.post('/monitor/comments/:id/reply', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const { id } = paramsSchema.parse(req.params);

    const bodySchema = z.object({
      text: z.string().min(1).max(500),
      viaWechatWork: z.boolean().default(false),
    });
    const { text } = bodySchema.parse(req.body);

    const comment = await prisma.comment.findUnique({
      where: { id },
      include: {
        video: { select: { userId: true } },
      },
    });
    if (!comment) {
      return res.status(404).json({ success: false, error: `评论不存在: ${id}` });
    }

    const user = await prisma.user.findUnique({
      where: { id: comment.video.userId },
      select: { id: true, platform: true, fingerprintWindowId: true },
    });
    if (!user) {
      return res.status(404).json({ success: false, error: '未找到关联用户' });
    }

    // 入队 BullMQ 回复任务（通过统一队列 helper，确保 taskType='reply'）
    const job = await enqueueReply({
      taskId: `reply_${Date.now()}_${comment.cid}`,
      userId: user.id,
      platform: user.platform as any,
      windowId: user.fingerprintWindowId,
      fingerprintWindowId: user.fingerprintWindowId,
      replyData: {
        videoId: comment.videoId,
        commentCid: comment.cid,
        text,
      },
    });

    // 更新回复状态
    await prisma.comment.update({
      where: { id },
      data: { replyStatus: 'pending' },
    });

    logger.info({ commentId: id, jobId: job.id, text }, '回复已入队 BullMQ');
    res.json({ success: true, commentId: id, jobId: job.id, replyStatus: 'pending' });
  } catch (err) {
    handleError(res, logger, err, '回复评论失败');
  }
});

/** POST /api/v1/matrix/monitor/comments/:id/accept-reply — 采纳 AI 建议并执行回复 */
router.post('/monitor/comments/:id/accept-reply', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const { id } = paramsSchema.parse(req.params);

    const bodySchema = z.object({
      text: z.string().min(1).max(500),
    });
    const { text } = bodySchema.parse(req.body);

    const comment = await prisma.comment.findUnique({
      where: { id },
      include: {
        video: { select: { userId: true } },
      },
    });
    if (!comment) {
      return res.status(404).json({ success: false, error: `评论不存在: ${id}` });
    }

    const user = await prisma.user.findUnique({
      where: { id: comment.video.userId },
      select: { id: true, platform: true, fingerprintWindowId: true },
    });
    if (!user) {
      return res.status(404).json({ success: false, error: '未找到关联用户' });
    }

    // 更新建议状态为 accepted
    await prisma.comment.update({
      where: { id },
      data: { suggestionStatus: 'accepted', replyStatus: 'pending' },
    });

    // 入队 BullMQ 回复任务（通过统一队列 helper，确保 taskType='reply'）
    const job = await enqueueReply({
      taskId: `reply_${Date.now()}_${comment.cid}`,
      userId: user.id,
      platform: user.platform as any,
      windowId: user.fingerprintWindowId,
      fingerprintWindowId: user.fingerprintWindowId,
      replyData: {
        videoId: comment.videoId,
        commentCid: comment.cid,
        text,
      },
    });

    logger.info({ commentId: id, jobId: job.id, text }, '采纳 AI 回复已入队');
    res.json({ success: true, commentId: id, jobId: job.id, replyStatus: 'pending' });
  } catch (err) {
    handleError(res, logger, err, '采纳 AI 回复失败');
  }
});

// ============================================================
// 3. Monitor — Account Detail & Actions
// ============================================================

/** GET /api/v1/matrix/monitor/accounts/:userId — 用户监控详情（按平台分组视频） */
router.get('/monitor/accounts/:userId', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ userId: z.coerce.number().int().positive() });
    const { userId } = paramsSchema.parse(req.params);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        videos: {
          orderBy: { createTime: 'desc' },
          include: {
            _count: { select: { comments: true } },
            comments: {
              where: { isNew: 1 },
              select: { id: true },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // Get monitor status
    const monitorStatus = await prisma.monitorStatus.findFirst({
      where: { accountId: String(user.id), platform: user.platform },
    });

    const videos = user.videos.map((v) => ({
      id: v.id,
      description: v.description,
      createTime: Number(v.createTime),
      commentCount: v.commentCount,
      newCommentCount: v.comments.length,
      metrics: v.metrics ? JSON.parse(v.metrics) : null,
      updatedAt: v.updatedAt,
    }));

    res.json({
      success: true,
      data: {
        id: user.id,
        platform: user.platform,
        platformName: PLATFORM_DISPLAY_NAMES[user.platform] || user.platform,
        fingerprintWindowId: user.fingerprintWindowId,
        status: user.status,
        monitoringEnabled: user.monitoringEnabled,
        cooldownUntil: user.cooldownUntil ? Number(user.cooldownUntil) : 0,
        lastCheckTime: monitorStatus?.lastCheckTime || null,
        lastVideoCount: monitorStatus?.lastVideoCount || 0,
        lastCommentCount: monitorStatus?.lastCommentCount || 0,
        videos,
      },
    });
  } catch (err) {
    handleError(res, logger, err, '获取用户监控详情失败');
  }
});

/** POST /api/v1/matrix/monitor/accounts/:userId/trigger — 手动触发一次监控 */
router.post('/monitor/accounts/:userId/trigger', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ userId: z.coerce.number().int().positive() });
    const { userId } = paramsSchema.parse(req.params);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    if (!user.monitoringEnabled) {
      return res.status(400).json({ success: false, error: '该用户监控已暂停' });
    }

    if (user.status === 'blocked') {
      return res.status(400).json({ success: false, error: '该用户处于封禁状态，无法触发监控' });
    }

    // 去重：检查是否已有同用户的 active/waiting 任务
    const existingJobs = await getAllJobs(['active', 'waiting']);
    const hasExisting = existingJobs.some((j: any) => (j.data as any)?.userId === user.id);
    if (hasExisting) {
      return res.json({
        success: true,
        message: '该用户已有任务在队列中，无需重复触发',
        deduplicated: true,
      });
    }

    // Add to BullMQ queue
    const job = await enqueueMonitor({
      taskId: `manual_${Date.now()}_${user.id}`,
      userId: user.id,
      platform: user.platform as PlatformName,
      windowId: user.fingerprintWindowId,
      fingerprintWindowId: user.fingerprintWindowId,
    });

    // 重置该 (窗口, 平台) 的调度器倒计时
    resetSchedulerTimer(user.fingerprintWindowId, user.platform);

    await prisma.operationLog.create({
      data: {
        action: 'monitor_manual_trigger',
        details: JSON.stringify({ userId: user.id, platform: user.platform, jobId: job.id }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, message: '监控任务已加入队列', jobId: job.id });
  } catch (err) {
    handleError(res, logger, err, '触发监控失败');
  }
});

/** GET /api/v1/matrix/monitor/scheduler-status — 获取每 (窗口, 平台) 调度器状态 */
router.get('/monitor/scheduler-status', (_req: Request, res: Response) => {
  try {
    const statuses = getAllSchedulerStatuses();
    res.json({ success: true, data: { statuses } });
  } catch (err) {
    handleError(res, logger, err, '获取调度器状态失败');
  }
});

/** POST /api/v1/matrix/monitor/trigger-all — 统一触发所有活跃用户的监控（按窗口排队） */
router.post('/monitor/trigger-all', async (_req: Request, res: Response) => {
  try {
    // 获取所有活跃监控用户
    const users = await prisma.user.findMany({
      where: {
        monitoringEnabled: true,
        status: { not: 'blocked' },
      },
    });

    if (users.length === 0) {
      return res.json({ success: true, message: '没有活跃的监控用户', jobIds: [], total: 0 });
    }

    // 按窗口分组，每个窗口内的任务串行执行
    const byWindow = new Map<string, typeof users>();
    for (const u of users) {
      const items = byWindow.get(u.fingerprintWindowId) || [];
      items.push(u);
      byWindow.set(u.fingerprintWindowId, items);
    }

    const jobIds: string[] = [];
    for (const [, userGroup] of byWindow) {
      for (const user of userGroup) {
        const job = await enqueueMonitor({
          taskId: `manual_all_${Date.now()}_${user.id}`,
          userId: user.id,
          platform: user.platform as PlatformName,
          windowId: user.fingerprintWindowId,
          fingerprintWindowId: user.fingerprintWindowId,
        });
        jobIds.push(job.id);
      }
    }

    await prisma.operationLog.create({
      data: {
        action: 'monitor_trigger_all',
        details: JSON.stringify({ total: users.length, windows: byWindow.size, jobIds }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    // 为每个唯一的 (窗口, 平台) 重置调度器
    const resetPairs = new Set<string>();
    for (const u of users) {
      const pairKey = `${u.fingerprintWindowId}_${u.platform}`;
      if (!resetPairs.has(pairKey)) {
        resetPairs.add(pairKey);
        resetSchedulerTimer(u.fingerprintWindowId, u.platform);
      }
    }

    res.json({
      success: true,
      message: `已为 ${users.length} 个用户创建监控任务（${byWindow.size} 个窗口）`,
      jobIds,
      total: users.length,
      windows: byWindow.size,
    });
  } catch (err) {
    handleError(res, logger, err, '统一触发监控失败');
  }
});

/** POST /api/v1/matrix/monitor/videos/clear — 清空视频及评论数据，同时清空队列并暂停所有平台 */
router.post('/monitor/videos/clear', async (_req: Request, res: Response) => {
  try {
    // 1. 清空执行队列（取消所有 active/waiting/delayed 任务）
    const [active, waiting, delayed] = await Promise.all([
      getAllJobs(['active']),
      getAllJobs(['waiting']),
      getAllJobs(['delayed']),
    ]);
    const allJobs = [...active, ...waiting, ...delayed];
    const redis = getRedis();
    const queueName = 'platform';
    for (const job of allJobs) {
      try {
        markJobCancelled(job.id);
        await job.discard().catch(() => {});
        const keysToDelete = [
          `bull:${queueName}:${job.id}`,
          `bull:${queueName}:${job.id}:logs`,
          `bull:${queueName}:${job.id}:lock`,
          `bull:${queueName}:lock:${job.id}`,
        ];
        await redis.del(...keysToDelete).catch(() => {});
        await redis.lrem(`bull:${queueName}:active`, 1, job.id).catch(() => {});
        for (const setName of [`bull:${queueName}:wait`, `bull:${queueName}:waiting`, `bull:${queueName}:delayed`]) {
          await redis.zrem(setName, job.id).catch(() => {});
        }
      } catch {}
    }
    logger.info({ cancelled: allJobs.length }, '清空数据时已取消所有队列任务');

    // 2. 暂停所有平台（禁用所有用户的监控）
    await prisma.user.updateMany({
      data: { monitoringEnabled: false },
    });
    logger.info('已暂停所有平台监控');

    // 3. 重启调度器（清除所有卡死的 scheduleAfterCompletion 状态）
    restartMonitorScheduler();
    logger.info('已重启调度器');

    // 4. 清空视频及评论数据
    await prisma.videoRootCommentCount.deleteMany();
    await prisma.videoCommentRecord.deleteMany();
    await prisma.videoCommentCount.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.video.deleteMany();
    await prisma.monitorStatus.deleteMany();

    // 4. 重置用户状态
    await prisma.user.updateMany({
      data: { consecutiveNoUpdate: 0, cooldownUntil: 0, status: 'init', platformAuthorId: null, platformAuthorName: null },
    });

    res.json({ success: true, message: '视频数据库已清空，队列已清空，所有平台已暂停' });
  } catch (err) {
    handleError(res, logger, err, '清空视频数据库失败');
  }
});

/** POST /api/v1/matrix/monitor/accounts/:userId/clear — 清空指定用户的视频及评论数据 */
router.post('/monitor/accounts/:userId/clear', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ userId: z.coerce.number().int().positive() });
    const { userId } = paramsSchema.parse(req.params);

    // 检查用户是否存在
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 获取该用户的所有视频 ID
    const videos = await prisma.video.findMany({
      where: { userId },
      select: { id: true },
    });
    const videoIds = videos.map(v => v.id);

    // 按顺序删除关联数据
    if (videoIds.length > 0) {
      await prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: videoIds } } });
      await prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: videoIds } } });
      await prisma.videoCommentCount.deleteMany({ where: { videoId: { in: videoIds } } });
      await prisma.comment.deleteMany({ where: { videoId: { in: videoIds } } });
    }
    await prisma.video.deleteMany({ where: { userId } });
    await prisma.monitorStatus.deleteMany({ where: { accountId: String(userId) } });

    // 重置用户状态
    await prisma.user.update({
      where: { id: userId },
      data: { consecutiveNoUpdate: 0, cooldownUntil: 0, status: 'init', platformAuthorId: null, platformAuthorName: null },
    });

    logger.info({ userId, platform: user.platform, videoCount: videoIds.length }, '已清空用户数据');
    res.json({
      success: true,
      message: `已清空用户 ${user.platform} 的 ${videoIds.length} 个视频及相关评论数据`,
    });
  } catch (err) {
    handleError(res, logger, err, '清空用户数据失败');
  }
});

/** POST /api/v1/matrix/monitor/accounts/enable-all — 一键恢复所有用户 */
router.post('/monitor/accounts/enable-all', async (_req: Request, res: Response) => {
  try {
    // 1. 查询所有已暂停的用户
    const pausedUsers = await prisma.user.findMany({
      where: { monitoringEnabled: false },
      select: { id: true, fingerprintWindowId: true, platform: true },
    });

    if (pausedUsers.length === 0) {
      return res.json({ success: true, data: { enabledCount: 0 } });
    }

    // 2. 批量启用
    await prisma.user.updateMany({
      where: { monitoringEnabled: false },
      data: { monitoringEnabled: true },
    });

    // 3. 重置调度器
    for (const user of pausedUsers) {
      resetSchedulerTimer(user.fingerprintWindowId, user.platform);
    }

    // 4. 写入操作日志
    await prisma.operationLog.create({
      data: {
        action: 'monitor_enable_all',
        details: JSON.stringify({ enabledCount: pausedUsers.length }),
        userId: 'system',
        userName: '一键恢复',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, data: { enabledCount: pausedUsers.length } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '一键恢复所有用户失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** PUT /api/v1/matrix/monitor/accounts/:userId/toggle — 切换监控开关 */
router.put('/monitor/accounts/:userId/toggle', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ userId: z.coerce.number().int().positive() });
    const bodySchema = z.object({ enabled: z.boolean() });
    const { userId } = paramsSchema.parse(req.params);
    const { enabled } = bodySchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { monitoringEnabled: enabled },
    });

    await prisma.operationLog.create({
      data: {
        action: enabled ? 'monitor_enable' : 'monitor_disable',
        details: JSON.stringify({ userId: user.id, platform: user.platform }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    // 同步该 (窗口, 平台) 的调度器状态（不重启全局调度器，避免影响其他平台）
    try {
      const { resetSchedulerTimer } = await import('../services/monitorService');
      if (enabled) {
        // 启用时：立即重置该 (窗口, 平台) 的调度器，触发即时调度
        resetSchedulerTimer(user.fingerprintWindowId, user.platform);
        logger.info({ userId, windowId: user.fingerprintWindowId, platform: user.platform }, '[toggle] 调度器已重置，等待即时调度');
      } else {
        // 禁用时：无需操作，getAllActiveUsers() 已过滤 monitoringEnabled=false 的用户
        logger.info({ userId, windowId: user.fingerprintWindowId, platform: user.platform }, '[toggle] 用户已禁用，调度器将在下次运行时自动跳过');
      }
    } catch (restartErr: any) {
      logger.warn({ err: restartErr.message }, '[toggle] 调度器重置失败（不影响 toggle 结果）');
    }

    res.json({ success: true, enabled });
  } catch (err) {
    handleError(res, logger, err, '切换监控状态失败');
  }
});

/** GET /api/v1/matrix/monitor/new-comments — 有新评论的视频概览 */
router.get('/monitor/new-comments', async (_req: Request, res: Response) => {
  try {
    // Find all videos that have at least one new comment
    const videosWithNewComments = await prisma.video.findMany({
      where: {
        comments: { some: { isNew: 1 } },
      },
      include: {
        user: { select: { id: true, platform: true, fingerprintWindowId: true } },
        _count: { select: { comments: true } },
        comments: {
          where: { isNew: 1 },
          select: {
            id: true,
            cid: true,
            text: true,
            userNickname: true,
            userUid: true,
            diggCount: true,
            createTime: true,
            replyId: true,
            rootId: true,
            parentId: true,
            level: true,
            isAuthor: true,
          },
          orderBy: { createTime: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    const data = videosWithNewComments.map((v) => ({
      id: v.id,
      description: v.description,
      platform: v.user.platform,
      platformName: PLATFORM_DISPLAY_NAMES[v.user.platform] || v.user.platform,
      userId: v.user.id,
      totalComments: v._count.comments,
      newCommentCount: v.comments.length,
      updatedAt: v.updatedAt,
      comments: v.comments.map((c) => ({
        ...c,
        isLightMode: typeof c.cid === 'string' && c.cid.startsWith('light_'),
      })),
    }));

    res.json({ success: true, data });
  } catch (err) {
    handleError(res, logger, err, '获取新评论概览失败');
  }
});

// ============================================================
// 3. Monitor — Crawl Settings
// ============================================================

/** GET /api/v1/matrix/monitor/crawl-settings — 获取所有平台的爬取模式配置 */
router.get('/monitor/crawl-settings', async (_req: Request, res: Response) => {
  try {
    const settings = await prisma.crawlSetting.findMany({
      orderBy: { platform: 'asc' },
    });

    // Return all monitor platforms with their settings (default to deep if not in DB)
    const monitorPlatforms = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'];
    const result = monitorPlatforms.map((platform) => {
      const setting = settings.find((s) => s.platform === platform);
      return {
        platform,
        platformName: PLATFORM_DISPLAY_NAMES[platform] || platform,
        mode: setting?.mode || 'deep',
        enabled: setting?.enabled ?? true,
        updatedAt: setting?.updatedAt || null,
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    handleError(res, logger, err, '获取爬取配置失败');
  }
});

/** PUT /api/v1/matrix/monitor/crawl-settings/:platform — 更新平台爬取模式 */
router.put('/monitor/crawl-settings/:platform', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ platform: z.string().min(1) });
    const bodySchema = z.object({
      mode: z.enum(['deep', 'simple']),
      enabled: z.boolean().optional(),
    });

    const { platform } = paramsSchema.parse(req.params);
    const { mode, enabled } = bodySchema.parse(req.body);

    const setting = await prisma.crawlSetting.upsert({
      where: { platform },
      update: { mode, ...(enabled !== undefined ? { enabled } : {}) },
      create: { platform, mode, enabled: enabled ?? true },
    });

    await prisma.operationLog.create({
      data: {
        action: 'crawl_setting_update',
        details: JSON.stringify({ platform, mode, enabled: setting.enabled }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({
      success: true,
      data: {
        platform,
        mode: setting.mode,
        enabled: setting.enabled,
        updatedAt: setting.updatedAt,
      },
    });
  } catch (err) {
    handleError(res, logger, err, '更新爬取配置失败');
  }
});

// ============================================================
// 平台能力元数据
// ============================================================

/** GET /api/v1/matrix/platforms/capabilities — 获取平台能力元数据 */
router.get('/platforms/capabilities', async (_req: Request, res: Response) => {
  try {
    const capabilities = [
      {
        platform: 'douyin',
        platformName: '抖音',
        canPublish: true,
        canMonitor: true,
        canDeepCrawl: true,
        canLightNotify: true,
      },
      {
        platform: 'kuaishou',
        platformName: '快手',
        canPublish: true,
        canMonitor: true,
        canDeepCrawl: true,
        canLightNotify: true,
      },
      {
        platform: 'xiaohongshu',
        platformName: '小红书',
        canPublish: true,
        canMonitor: true,
        canDeepCrawl: true,
        canLightNotify: true,
      },
      {
        platform: 'bilibili',
        platformName: 'B站',
        canPublish: true,
        canMonitor: false,
        canDeepCrawl: false,
        canLightNotify: false,
      },
      {
        platform: 'baijiahao',
        platformName: '百家号',
        canPublish: true,
        canMonitor: false,
        canDeepCrawl: false,
        canLightNotify: false,
      },
      {
        platform: 'tencent',
        platformName: '腾讯视频号',
        canPublish: true,
        canMonitor: true,
        canDeepCrawl: true,
        canLightNotify: true,
      },
      {
        platform: 'tiktok',
        platformName: 'TikTok',
        canPublish: true,
        canMonitor: false,
        canDeepCrawl: false,
        canLightNotify: false,
      },
    ];

    res.json({ success: true, data: capabilities });
  } catch (err) {
    handleError(res, logger, err, '获取平台能力失败');
  }
});

// ============================================================
// 4. BGM（新增）
// ============================================================

/** GET /api/v1/matrix/bgm — 可用 BGM 曲目列表 */
router.get('/bgm', async (_req: Request, res: Response) => {
  try {
    const tracks = [
      { id: 'bgm-001', name: '轻快阳光', url: 'https://example.com/bgm/upbeat.mp3', duration: 180 },
      { id: 'bgm-002', name: '温柔钢琴', url: 'https://example.com/bgm/piano.mp3', duration: 240 },
      { id: 'bgm-003', name: '电子律动', url: 'https://example.com/bgm/electronic.mp3', duration: 200 },
      { id: 'bgm-004', name: '民谣吉他', url: 'https://example.com/bgm/folk.mp3', duration: 210 },
      { id: 'bgm-005', name: '氛围感', url: 'https://example.com/bgm/ambient.mp3', duration: 300 },
      { id: 'bgm-006', name: '节奏感', url: 'https://example.com/bgm/rhythm.mp3', duration: 150 },
      { id: 'bgm-007', name: '复古蒸汽波', url: 'https://example.com/bgm/vaporwave.mp3', duration: 220 },
      { id: 'bgm-008', name: '中国风', url: 'https://example.com/bgm/chinese.mp3', duration: 260 },
    ];

    res.json({ success: true, data: tracks });
  } catch (err) {
    handleError(res, logger, err, '获取 BGM 列表失败');
  }
});

// ============================================================
// 执行队列 API
// ============================================================

/** 获取活跃任务列表（统一三种任务类型） */
router.get('/queue/active', async (_req: Request, res: Response) => {
  try {
    const [active, waiting, delayed] = await Promise.all([
      getAllJobs(['active']),
      getAllJobs(['waiting']),
      getAllJobs(['delayed']),
    ]);

    const allJobs = [...active, ...waiting, ...delayed];
    const seen = new Set<string>();
    const tasks: any[] = [];

    // 批量查询窗口名
    const windowIds = [...new Set(allJobs.map(j => (j.data as any)?.windowId).filter(Boolean))];
    const windows = await prisma.browserWindow.findMany({
      where: { externalId: { in: windowIds } },
      select: { externalId: true, windowName: true, operator: { select: { displayName: true } } },
    }).catch(() => []);
    const windowNameMap = new Map<string, string>();
    for (const w of windows) {
      const name = w.windowName || w.operator?.displayName || w.externalId.slice(0, 12);
      windowNameMap.set(w.externalId, name);
    }

    for (const job of allJobs) {
      const bullJobId = job.id;
      const data = job.data as any;
      const taskId = data.taskId || bullJobId || '';
      if (seen.has(taskId)) continue;
      seen.add(taskId);

      let progress: any = null;
      try {
        const p = await job.progress;
        if (p && typeof p === 'object' && 'phase' in p) progress = p;
      } catch {}

      // 尝试从 DB 读取 execution 记录
      let executionId: string | undefined;
      let phaseIndex: number | undefined;
      let totalPhases: number | undefined;
      try {
        const exec = await prisma.taskExecution.findFirst({
          where: { taskId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, phaseIndex: true, totalPhases: true },
        });
        if (exec) {
          executionId = exec.id;
          phaseIndex = exec.phaseIndex ?? undefined;
          totalPhases = exec.totalPhases ?? undefined;
        }
      } catch {}

      tasks.push({
        executionId,
        taskId,
        taskType: data.taskType || 'unknown',
        platform: data.platform || 'unknown',
        windowId: data.windowId || data.fingerprintWindowId || '',
        windowName: (data.windowId && windowNameMap.get(data.windowId)) || (data.fingerprintWindowId && windowNameMap.get(data.fingerprintWindowId)) || '',
        status: await job.isActive() ? 'running' : 'queued',
        phaseIndex,
        totalPhases,
        progress,
      });
    }

    const running = tasks.filter(t => t.status === 'running').length;
    res.json({
      success: true,
      data: { total: tasks.length, running, queued: tasks.length - running, tasks },
    });
  } catch (err) {
    handleError(res, logger, err, '获取队列活跃任务失败');
  }
});

/** 获取历史执行记录 */
router.get('/queue/history', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const taskType = req.query.taskType as string | undefined;
    const status = req.query.status as string | undefined;
    const windowId = req.query.windowId as string | undefined;

    const where: any = {};
    if (taskType) where.taskType = taskType;
    if (status) where.status = status;
    if (windowId) where.windowId = windowId;

    const [items, total] = await Promise.all([
      prisma.taskExecution.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, taskId: true, taskType: true, platform: true, userId: true,
          status: true, currentPhase: true, phaseIndex: true, totalPhases: true,
          progressPercent: true, startedAt: true, completedAt: true, durationMs: true,
          errorMessage: true, isDebugMode: true, createdAt: true, windowId: true,
        },
      }),
      prisma.taskExecution.count({ where }),
    ]);

    // 批量查询窗口名
    const histWindowIds = [...new Set(items.map((i: any) => i.windowId).filter(Boolean))];
    const histWindows = await prisma.browserWindow.findMany({
      where: { externalId: { in: histWindowIds } },
      select: { externalId: true, windowName: true, operator: { select: { displayName: true } } },
    }).catch(() => []);
    const histWindowMap = new Map<string, string>();
    for (const w of histWindows) {
      histWindowMap.set(w.externalId, w.windowName || w.operator?.displayName || w.externalId.slice(0, 12));
    }
    const itemsWithName = items.map((item: any) => ({
      ...item,
      windowName: item.windowId ? (histWindowMap.get(item.windowId) || '') : '',
    }));

    res.json({ success: true, data: { items: itemsWithName, total, page, limit } });
  } catch (err) {
    handleError(res, logger, err, '获取队列历史失败');
  }
});

/** 获取单个执行详情（含 steps） */
router.get('/queue/executions/:id', async (req: Request, res: Response) => {
  try {
    const execution = await prisma.taskExecution.findUnique({
      where: { id: req.params.id as string },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!execution) {
      res.status(404).json({ success: false, error: '执行记录不存在' });
      return;
    }
    res.json({ success: true, data: execution });
  } catch (err) {
    handleError(res, logger, err, '获取执行详情失败');
  }
});

/** 清空所有历史执行记录 */
router.delete('/queue/history', async (_req: Request, res: Response) => {
  try {
    const result = await prisma.taskExecution.deleteMany({});
    logger.info({ deletedCount: result.count }, '已清空所有执行历史');
    res.json({ success: true, data: { deletedCount: result.count } });
  } catch (err) {
    handleError(res, logger, err, '清空执行历史失败');
  }
});

export default router;
