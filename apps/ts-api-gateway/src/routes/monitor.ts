// @ts-api-gateway/routes/monitor.ts - 监控数据 API

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:monitor');

const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  baijiahao: '百家号',
  tencent: '腾讯视频号',
  tiktok: 'TikTok',
};

/** GET /api/v1/monitor/targets - 监控目标列表（按 platform 聚合） */
router.get('/targets', async (_req: Request, res: Response) => {
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
      // monitoringEnabled is true only if ALL users in this platform have it enabled
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
    logger.error({ err: (err as Error).message }, '获取监控目标失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/monitor/videos?platform=&search=&limit= - 监控视频列表 */
router.get('/videos', async (req: Request, res: Response) => {
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
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取监控视频失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/monitor/videos/:id/comments?limit= - 视频评论树（含层级关系） */
router.get('/videos/:id/comments', async (req: Request, res: Response) => {
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
        id: r.id,
        cid: r.cid,
        text: r.text,
        userNickname: r.userNickname,
        createTime: r.createTime,
        diggCount: r.diggCount,
        replyToName: r.replyToName,
        isNew: r.isNew === 1,
      });
    }

    const tree = roots.map((root) => ({
      id: root.id,
      cid: root.cid,
      text: root.text,
      userNickname: root.userNickname,
      createTime: root.createTime,
      diggCount: root.diggCount,
      isNew: root.isNew === 1,
      replies: replyMap.get(root.cid) || [],
    }));

    res.json({
      success: true,
      data: tree,
      total: comments.length,
      rootCount: roots.length,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取视频评论失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 评论操作端点
// ============================================================

/** POST /api/v1/monitor/comments/:id/read — 标记单条评论为已读 */
router.post('/comments/:id/read', async (req: Request, res: Response) => {
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
        userName: 'Monitor API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '标记评论已读失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/monitor/comments/read-all — 标记所有未读评论为已读（可按 videoId 过滤） */
router.post('/comments/read-all', async (req: Request, res: Response) => {
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
        userName: 'Monitor API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, count: result.count });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '批量标记评论已读失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/monitor/comments/:id/reply — 回复评论（模拟） */
router.post('/comments/:id/reply', async (req: Request, res: Response) => {
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
        userName: 'Monitor API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, commentId: id, channel, repliedAt });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '回复评论失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/monitor/videos/:id/read-all — 标记某视频下的所有评论为已读 */
router.post('/videos/:id/read-all', async (req: Request, res: Response) => {
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
        userName: 'Monitor API',
        result: 'success',
        level: 'info',
      },
    });

    res.json({ success: true, count: result.count });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '标记视频评论已读失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
