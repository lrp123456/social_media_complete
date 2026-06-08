// @ts-api-gateway/routes/matrix.ts - 社媒矩阵统一 API
// 收拢发布、账号、监控、评论于 /api/v1/matrix/ 命名空间下

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { submitPublishTask, publishQueue } from '../services/publishService';
import type { PublishTask } from '../platforms/types';
import type { PlatformName } from '@social-media/shared-config';
import { monitorQueue, getSchedulerStatus } from '../services/monitorService';

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
          const job = await publishQueue.getJob(taskId);
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

          return {
            taskId,
            status,
            platform: (details.platform as string) ?? (job?.data as any)?.platform ?? 'unknown',
            userName: log?.userName ?? ((job?.data as any)?.credentials?.username as string) ?? '',
            error,
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
          const job = await monitorQueue.getJob(taskId);
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

          return {
            taskId,
            status,
            platform: (details.platform as string) ?? (job?.data as any)?.platform ?? 'unknown',
            userId: (job?.data as any)?.userId ?? 0,
            error,
            details,
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

        return {
          id: user.id,
          platform: user.platform,
          platformName: PLATFORM_DISPLAY_NAMES[user.platform] || user.platform,
          fingerprintWindowId: user.fingerprintWindowId,
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
        createTime: v.createTime,
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
      });
    }

    const tree = roots.map((root) => ({
      id: root.id, cid: root.cid, text: root.text,
      userNickname: root.userNickname,
      createTime: Number(root.createTime),
      diggCount: root.diggCount,
      isNew: root.isNew === 1,
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

/** POST /api/v1/matrix/monitor/comments/:id/reply — 回复评论（模拟） */
router.post('/monitor/comments/:id/reply', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const { id } = paramsSchema.parse(req.params);

    const bodySchema = z.object({
      text: z.string().min(1).max(500),
      viaWechatWork: z.boolean().default(false),
    });
    const { text, viaWechatWork } = bodySchema.parse(req.body);

    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) {
      return res.status(404).json({ success: false, error: `评论不存在: ${id}` });
    }

    const channel = viaWechatWork ? 'wechat_work' : 'direct';
    const repliedAt = new Date().toISOString();

    // 模拟回复（不对接真实 API）
    logger.info({ commentId: id, text, channel }, `模拟回复评论 (${channel})`);

    await prisma.operationLog.create({
      data: {
        action: 'comment_reply',
        details: JSON.stringify({ commentId: id, text, channel, videoId: comment.videoId }),
        userId: 'system',
        userName: 'Matrix API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, commentId: id, channel, repliedAt });
  } catch (err) {
    handleError(res, logger, err, '回复评论失败');
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

    // Add to BullMQ queue
    const job = await (monitorQueue.add as any)(user.platform, {
      taskId: `manual_${Date.now()}_${user.id}`,
      userId: user.id,
      platform: user.platform as PlatformName,
      windowId: user.fingerprintWindowId,
      fingerprintWindowId: user.fingerprintWindowId,
    });

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

/** GET /api/v1/matrix/monitor/scheduler-status — 获取调度器状态（下次检查倒计时） */
router.get('/monitor/scheduler-status', (_req: Request, res: Response) => {
  try {
    const status = getSchedulerStatus();
    res.json({ success: true, data: status });
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
        const job = await (monitorQueue.add as any)(user.platform, {
          taskId: `manual_all_${Date.now()}_${user.id}`,
          userId: user.id,
          platform: user.platform as PlatformName,
          windowId: user.fingerprintWindowId,
          fingerprintWindowId: user.fingerprintWindowId,
        }, {
          // 同一窗口的任务使用相同的 group id，BullMQ 会保证它们串行执行
          // 通过 opts.group.id 实现（需要 BullMQ Pro 或使用 job dependencies）
          // 这里利用 WindowMutex 锁来保证串行
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
          select: { id: true },
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
    const monitorPlatforms = ['douyin', 'kuaishou', 'xiaohongshu'];
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
      mode: z.enum(['deep', 'light']),
      enabled: z.boolean().optional(),
    });

    const { platform } = paramsSchema.parse(req.params);
    const { mode, enabled } = bodySchema.parse(req.body);

    // 小红书强制light模式
    if (platform === 'xiaohongshu' && mode === 'deep') {
      return res.status(400).json({
        success: false,
        error: '小红书不支持深度爬取模式，仅支持轻量通知',
      });
    }

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
        canDeepCrawl: false, // 强制light
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
        canMonitor: false,
        canDeepCrawl: false,
        canLightNotify: false,
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

export default router;
