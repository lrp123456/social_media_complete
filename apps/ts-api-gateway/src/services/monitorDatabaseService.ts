// @ts-api-gateway/services/monitorDatabaseService.ts
// Prisma 数据库服务 — 封装视频评论监控需要的所有 DB 操作
// 供 crawler / scheduler 模块调用

import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('monitor-db');

// ============================================================
// Video 查询
// ============================================================

/**
 * 获取指定用户的所有视频（按创建时间降序）
 */
export function getVideosByUserId(userId: number) {
  return prisma.video.findMany({
    where: { userId },
    orderBy: { createTime: 'desc' },
  });
}

/**
 * 批量 upsert 视频
 */
export async function upsertVideosBatch(
  userId: number,
  videos: Array<{
    aweme_id: string;
    description: string;
    create_time: number;
    comment_count: number;
    metrics?: any;
  }>,
): Promise<void> {
  if (videos.length === 0) return;

  await prisma.$transaction(
    videos.map((v) =>
      prisma.video.upsert({
        where: { id: v.aweme_id },
        update: {
          description: v.description,
          commentCount: v.comment_count,
          metrics: JSON.stringify(v.metrics || {}),
        },
        create: {
          id: v.aweme_id,
          userId,
          description: v.description,
          createTime: BigInt(v.create_time),
          commentCount: v.comment_count,
          metrics: JSON.stringify(v.metrics || {}),
        },
      }),
    ),
  );

  logger.debug(`批量 upsert 视频完成: userId=${userId}, count=${videos.length}`);
}

// ============================================================
// Comment 操作
// ============================================================

/**
 * Upsert 单条评论（基于 cid 唯一键）
 */
export async function upsertComment(
  videoId: string,
  comment: {
    cid: string;
    text: string;
    user_nickname: string;
    user_uid: string;
    digg_count: number;
    create_time: number;
    reply_id: string;
  },
): Promise<void> {
  await prisma.comment.upsert({
    where: { cid: comment.cid },
    update: {
      text: comment.text,
      diggCount: comment.digg_count,
    },
    create: {
      videoId,
      cid: comment.cid,
      text: comment.text,
      userNickname: comment.user_nickname,
      userUid: comment.user_uid,
      diggCount: comment.digg_count,
      createTime: BigInt(comment.create_time),
      replyId: comment.reply_id,
      isNew: 1,
    },
  });
}

/**
 * 获取视频最新评论时间（Unix 毫秒时间戳，无评论返回 0）
 */
export async function getLastCommentTime(videoId: string): Promise<number> {
  const record = await prisma.comment.findFirst({
    where: { videoId },
    orderBy: { createTime: 'desc' },
    select: { createTime: true },
  });
  return record?.createTime ? Number(record.createTime) : 0;
}

/**
 * 更新视频的评论数
 */
export async function updateCommentCount(videoId: string, count: number): Promise<void> {
  await prisma.video.update({
    where: { id: videoId },
    data: { commentCount: count },
  });
}

/**
 * 删除用户超出保留数量的最旧视频
 */
export async function truncateVideosByUser(userId: number, maxVideos: number): Promise<void> {
  const excess = await prisma.video.findMany({
    where: { userId },
    orderBy: { createTime: 'desc' },
    skip: maxVideos,
    select: { id: true },
  });

  if (excess.length > 0) {
    await prisma.video.deleteMany({
      where: { id: { in: excess.map((v) => v.id) } },
    });
    logger.debug(`清理用户 ${userId} 的旧视频: deleted=${excess.length}`);
  }
}

/**
 * 将视频的所有评论标记为已通知
 */
export async function markCommentsAsNotified(videoId: string): Promise<void> {
  await prisma.comment.updateMany({
    where: { videoId },
    data: { isNew: 0 },
  });
}

/**
 * Light 模式专用：创建合成 Comment 记录，供前端 new-comments API 显示
 * 当 Light 模式检测到评论数增加但未获取具体评论时，使用此函数创建占位记录
 */
export async function upsertLightModeComment(
  videoId: string,
  info: { text: string; create_time: number },
): Promise<void> {
  const cid = `light_${videoId}_${info.create_time}`;
  await prisma.comment.upsert({
    where: { cid },
    update: { text: info.text },
    create: {
      videoId,
      cid,
      text: info.text,
      userNickname: '[增量通知]',
      userUid: '0',
      diggCount: 0,
      createTime: BigInt(info.create_time),
      replyId: '0',
      isNew: 1,
    },
  });
}

// ============================================================
// User 管理
// ============================================================

/**
 * 设置用户冷却时间（同时标记为 blocked）
 */
export async function setUserCooldown(userId: number, cooldownUntil: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      cooldownUntil: BigInt(cooldownUntil),
      status: 'blocked',
    },
  });
}

/**
 * 更新用户状态
 */
export async function updateUserStatus(userId: number, status: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { status },
  });
}

/**
 * 更新用户连续无更新次数
 */
export async function updateConsecutiveNoUpdate(userId: number, count: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { consecutiveNoUpdate: count },
  });
}

/**
 * 判断用户是否被屏蔽
 */
export async function isUserBlocked(userId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  return user?.status === 'blocked';
}

/**
 * 判断用户是否在冷却期内
 */
export async function isUserInCooldown(userId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { cooldownUntil: true },
  });
  return user?.cooldownUntil ? Number(user.cooldownUntil) > Date.now() : false;
}

/**
 * 获取所有活跃用户（未屏蔽且启用了监控）
 */
export function getAllActiveUsers() {
  return prisma.user.findMany({
    where: {
      status: { not: 'blocked' },
      monitoringEnabled: true,
    },
  });
}

/**
 * 根据 ID 获取用户
 */
export function getUserById(userId: number) {
  return prisma.user.findUnique({ where: { id: userId } });
}

// ============================================================
// MonitorStatus 调度状态
// ============================================================

/**
 * 记录监控检查完成 — 更新 lastCheckTime / lastVideoCount / lastCommentCount
 */
export async function updateMonitorStatus(
  userId: number,
  platform: string,
  videoCount: number,
  commentCount: number,
  status: 'running' | 'success' | 'failure' = 'success',
): Promise<void> {
  const accountId = String(userId);
  const existing = await prisma.monitorStatus.findFirst({
    where: { accountId, platform },
  });

  if (existing) {
    await prisma.monitorStatus.update({
      where: { id: existing.id },
      data: {
        lastCheckTime: new Date(),
        lastVideoCount: videoCount,
        lastCommentCount: commentCount,
        status,
      },
    });
  } else {
    await prisma.monitorStatus.create({
      data: {
        accountId,
        platform,
        lastCheckTime: new Date(),
        lastVideoCount: videoCount,
        lastCommentCount: commentCount,
        status,
      },
    });
  }
  logger.info({ userId, platform, videoCount, commentCount, status }, '监控状态已更新');
}

// ============================================================
// 平台配置
// ============================================================

/**
 * 获取指定平台的爬取模式（默认 deep）
 */
export async function getCrawlMode(platform: string): Promise<string> {
  const setting = await prisma.crawlSetting.findUnique({
    where: { platform },
    select: { mode: true },
  });
  return setting?.mode || 'deep';
}

// ============================================================
// 风控 / 日志
// ============================================================

/**
 * 记录风险场景到 operation_logs
 */
export async function logRiskScene(
  userId: number,
  platform: string,
  riskType: string,
  evidence: string,
): Promise<void> {
  await prisma.operationLog.create({
    data: {
      action: 'risk_control_detected',
      details: JSON.stringify({ riskType, evidence, platform }),
      userId: String(userId),
      userName: 'monitor',
      result: 'failure',
      level: 'error',
    },
  });
  logger.warn(`风控记录: userId=${userId}, platform=${platform}, riskType=${riskType}`);
}

/**
 * Upsert 评论（含层级字段）
 */
export async function upsertCommentWithHierarchy(
  videoId: string,
  comment: {
    cid: string;
    text: string;
    user_nickname: string;
    user_uid: string;
    digg_count: number;
    create_time: number;
    reply_id: string;
    rootId?: string;
    parentId?: string;
    level: number;
    replyToName?: string;
  },
): Promise<void> {
  await prisma.comment.upsert({
    where: { cid: comment.cid },
    update: {
      text: comment.text,
      diggCount: comment.digg_count,
      rootId: comment.rootId ?? null,
      parentId: comment.parentId ?? null,
      level: comment.level,
      replyToName: comment.replyToName ?? null,
    },
    create: {
      videoId,
      cid: comment.cid,
      text: comment.text,
      userNickname: comment.user_nickname,
      userUid: comment.user_uid,
      diggCount: comment.digg_count,
      createTime: BigInt(comment.create_time),
      replyId: comment.reply_id,
      rootId: comment.rootId ?? null,
      parentId: comment.parentId ?? null,
      level: comment.level,
      replyToName: comment.replyToName ?? null,
      isNew: 1,
    },
  });
}

/**
 * 批量 upsert 评论树（一个视频的所有评论）
 */
export async function upsertCommentTree(
  videoId: string,
  comments: Array<{
    cid: string;
    text: string;
    user_nickname: string;
    user_uid: string;
    digg_count: number;
    create_time: number;
    reply_id: string;
    rootId?: string;
    parentId?: string;
    level: number;
    replyToName?: string;
  }>,
): Promise<void> {
  if (comments.length === 0) return;
  await prisma.$transaction(async (tx) => {
    for (const c of comments) {
      await tx.comment.upsert({
        where: { cid: c.cid },
        update: {
          text: c.text,
          diggCount: c.digg_count,
          rootId: c.rootId ?? null,
          parentId: c.parentId ?? null,
          level: c.level,
          replyToName: c.replyToName ?? null,
        },
        create: {
          videoId,
          cid: c.cid,
          text: c.text,
          userNickname: c.user_nickname,
          userUid: c.user_uid,
          diggCount: c.digg_count,
          createTime: BigInt(c.create_time),
          replyId: c.reply_id,
          rootId: c.rootId ?? null,
          parentId: c.parentId ?? null,
          level: c.level,
          replyToName: c.replyToName ?? null,
          isNew: 1,
        },
      });
    }
  });
}

/**
 * 获取视频下所有根评论的回复计数
 */
export async function getRootCommentCounts(
  videoId: string,
): Promise<Map<string, number>> {
  const rows = await prisma.videoRootCommentCount.findMany({
    where: { videoId },
    select: { cid: true, replyCount: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.cid, row.replyCount);
  }
  return map;
}

/**
 * Upsert 单个根评论的回复计数
 */
export async function upsertRootCommentCount(
  videoId: string,
  cid: string,
  replyCount: number,
): Promise<void> {
  await prisma.videoRootCommentCount.upsert({
    where: { videoId_cid: { videoId, cid } },
    update: { replyCount },
    create: { videoId, cid, replyCount },
  });
}

/**
 * 批量更新根评论回复计数
 */
export async function upsertRootCommentCounts(
  videoId: string,
  counts: Array<{ cid: string; replyCount: number }>,
): Promise<void> {
  if (counts.length === 0) return;
  await prisma.$transaction(
    counts.map((c) =>
      prisma.videoRootCommentCount.upsert({
        where: { videoId_cid: { videoId, cid: c.cid } },
        update: { replyCount: c.replyCount },
        create: { videoId, cid: c.cid, replyCount: c.replyCount },
      }),
    ),
  );
}

/**
 * 获取视频所有已有评论的 cid 集合（用于差集增量检测）
 */
export async function getExistingCids(videoId: string): Promise<Set<string>> {
  const rows = await prisma.comment.findMany({
    where: { videoId },
    select: { cid: true },
  });
  return new Set(rows.map((r) => r.cid));
}
