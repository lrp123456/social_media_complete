// @ts-api-gateway/services/monitorDatabaseService.ts
// Prisma 数据库服务 — 封装视频评论监控需要的所有 DB 操作
// 供 crawler / scheduler 模块调用

import type { PlatformName } from '@social-media/shared-config';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { normalizeVideoId } from './videoIdUtils';

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
 * 批量 upsert 视频（仅更新基础信息，不更新 commentCount）
 * commentCount 仅在 Phase3 成功采集评论后才更新
 *
 * @deprecated 请使用 reconcileVideosForUser 替代
 */
export async function upsertVideosBatch(
  userId: number,
  platform: PlatformName,
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
        where: { id: normalizeVideoId(platform as any, v.aweme_id) },
        update: {
          description: v.description,
          // 不更新 commentCount — 仅在 Phase3 成功后更新
          metrics: JSON.stringify(v.metrics || {}),
        },
        create: {
          id: normalizeVideoId(platform as any, v.aweme_id),
          userId,
          description: v.description,
          createTime: BigInt(v.create_time),
          // 首次创建时记录初始 count（后续由 Phase3 更新）
          commentCount: v.comment_count ?? 0,
          metrics: JSON.stringify(v.metrics || {}),
        },
      }),
    ),
  );

  logger.debug(`批量 upsert 视频完成: userId=${userId}, count=${videos.length}`);
}

/**
 * Phase3 成功后更新指定视频的 commentCount（带 userId 过滤）
 */
export async function updateVideoCommentCount(
  userId: number,
  exportId: string,
  commentCount: number,
): Promise<void> {
  await prisma.video.updateMany({
    where: { id: exportId, userId },
    data: { commentCount },
  });
  logger.debug({ userId, exportId, commentCount }, '视频 commentCount 已更新');
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
    is_author?: boolean;
    imageUrls?: string;  // JSON 字符串数组
  },
): Promise<void> {
  await prisma.comment.upsert({
    where: { cid: comment.cid },
    update: {
      text: comment.text,
      diggCount: comment.digg_count,
      isAuthor: comment.is_author ?? false,
      imageUrls: comment.imageUrls ?? undefined,
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
      isAuthor: comment.is_author ?? false,
      isNew: 1,
      imageUrls: comment.imageUrls ?? undefined,
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
  await prisma.video.updateMany({
    where: { id: videoId },
    data: { commentCount: count },
  });
}

/**
 * 删除用户超出保留数量的最旧视频
 *
 * @deprecated 请使用 reconcileVideosForUser 替代
 */
export async function truncateVideosByUser(userId: number, maxVideos: number): Promise<void> {
  const excess = await prisma.video.findMany({
    where: { userId },
    orderBy: { createTime: 'desc' },
    skip: maxVideos,
    select: { id: true },
  });

  if (excess.length > 0) {
    const excessIds = excess.map((v) => v.id);
    // 先清理无 FK 关联的子表
    await prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: excessIds } } });
    await prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: excessIds } } });
    await prisma.videoCommentCount.deleteMany({ where: { videoId: { in: excessIds } } });
    // Video 删除 → 级联删除 Comment
    await prisma.video.deleteMany({
      where: { id: { in: excessIds } },
    });
    logger.debug(`清理用户 ${userId} 的旧视频: deleted=${excess.length}`);
  }
}

/**
 * 协调用户视频列表与 DB，统一处理生命周期（替代 upsertVideosBatch + truncateVideosByUser）
 *
 * 调用方负责传入【已过滤可监控的视频列表】（公开 + 未删除·前 N 条）
 * DB 中存在但不在输入列表中的视频 → 删除（场景 B/C/G 合并处理）
 *
 * 保护机制：若 visibleVideos 为空且 DB 有视频，跳过删除（避免 API 异常误删）
 */
export async function reconcileVideosForUser(
  userId: number,
  platform: PlatformName,
  visibleVideos: Array<{
    aweme_id: string;
    description: string;
    create_time: number;
    comment_count: number;
    metrics?: any;
    isPinned?: boolean;
  }>,
  maxVideos: number,
): Promise<{
  newVideoIds: string[];
  removedVideoIds: string[];
  unchangedCount: number;
}> {
  const newVideoIds: string[] = [];
  const removedVideoIds: string[] = [];
  let unchangedCount = 0;

  // 1) 获取 DB 中该用户的全部视频 ID
  const dbVideos = await prisma.video.findMany({
    where: { userId },
    select: { id: true },
  });
  const dbIds = new Set(dbVideos.map((v) => v.id));

  // 2) 保护机制：源为空且 DB 有数据 → 跳过删除
  const sourceIds = new Set(visibleVideos.slice(0, maxVideos).map((v) => normalizeVideoId(platform as any, v.aweme_id)));
  if (sourceIds.size === 0 && dbIds.size > 0) {
    logger.warn(
      { userId, dbCount: dbIds.size },
      '[reconcileVideosForUser] visibleVideos is empty but DB has records — skipping deletion (protection)',
    );
    // 保护模式：跳过删除但仍记录日志
  } else {
    // 3) 找出需要删除的 ID（在 DB 中但不在 source 中）
    const toRemove = [...dbIds].filter((id) => !sourceIds.has(id));
    if (toRemove.length > 0) {
      // 先清理无 FK 关联的子表
      await prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: toRemove } } });
      await prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: toRemove } } });
      await prisma.videoCommentCount.deleteMany({ where: { videoId: { in: toRemove } } });
      // Video 删除 → 级联删除 Comment
      await prisma.video.deleteMany({
        where: { id: { in: toRemove } },
      });
      removedVideoIds.push(...toRemove);
      logger.debug({ userId, removed: toRemove.length }, '[reconcileVideosForUser] 删除已消失的视频');
    }
  }

  // 4) UPSERT 可见视频
  const upsertVideos = visibleVideos.slice(0, maxVideos);
  if (upsertVideos.length > 0) {
    await prisma.$transaction(
      upsertVideos.map((v) =>
        prisma.video.upsert({
          where: { id: normalizeVideoId(platform as any, v.aweme_id) },
          update: {
            description: v.description,
            metrics: JSON.stringify(v.metrics || {}),
            commentCount: v.comment_count ?? undefined,
            isPinned: v.isPinned ?? false,
          },
          create: {
            id: normalizeVideoId(platform as any, v.aweme_id),
            userId,
            description: v.description,
            createTime: BigInt(v.create_time),
            commentCount: v.comment_count ?? 0,
            metrics: JSON.stringify(v.metrics || {}),
            isPinned: v.isPinned ?? false,
          },
        }),
      ),
    );

    // 标记新增/不变
    for (const v of upsertVideos) {
      if (!dbIds.has(normalizeVideoId(platform as any, v.aweme_id))) {
        newVideoIds.push(normalizeVideoId(platform as any, v.aweme_id));
      } else {
        unchangedCount++;
      }
    }
  }

  logger.info(
    { userId, newCount: newVideoIds.length, removedCount: removedVideoIds.length, unchangedCount },
    '[reconcileVideosForUser] 视频生命周期协调完成',
  );

  return { newVideoIds, removedVideoIds, unchangedCount };
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
  const cid = `light_${videoId}`;
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
      isAuthor: false,
      isNew: 1,
    },
  });
}

// ============================================================
// User 管理
// ============================================================

/**
 * 设置用户冷却时间
 */
export async function setUserCooldown(userId: number, cooldownUntil: number): Promise<void> {
  await prisma.platformAccount.update({
    where: { id: userId },
    data: {
      cooldownUntil: BigInt(cooldownUntil),
    },
  });
}

/**
 * 更新用户状态
 */
export async function updateUserStatus(userId: number, status: string): Promise<void> {
  await prisma.platformAccount.update({
    where: { id: userId },
    data: { status },
  });
}

/**
 * 更新用户连续无更新次数
 */
export async function updateConsecutiveNoUpdate(userId: number, count: number): Promise<void> {
  await prisma.platformAccount.update({
    where: { id: userId },
    data: { consecutiveNoUpdate: count },
  });
}

/**
 * 判断用户是否被屏蔽
 */
export async function isUserBlocked(userId: number): Promise<boolean> {
  const user = await prisma.platformAccount.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  return user?.status === 'blocked';
}

/**
 * 判断用户是否在冷却期内
 */
export async function isUserInCooldown(userId: number): Promise<boolean> {
  const user = await prisma.platformAccount.findUnique({
    where: { id: userId },
    select: { cooldownUntil: true },
  });
  return user?.cooldownUntil ? Number(user.cooldownUntil) > Date.now() : false;
}

/**
 * 获取所有活跃用户（未屏蔽且启用了监控，且浏览器窗口未被删除）
 */
export async function getAllActiveUsers() {
  // ★ 自动恢复 login_required（30分钟后重试登录）和 risk_control（10分钟后重试）
  // 防止会话过期或临时风控后监控永久停止
  const LOGIN_REQUIRED_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟
  const RISK_CONTROL_COOLDOWN_MS = 10 * 60 * 1000;   // 10 分钟（风控通常是临时的）

  // 恢复过期的 risk_control 状态
  const riskControlThreshold = new Date(Date.now() - RISK_CONTROL_COOLDOWN_MS);
  const staleRiskControl = await prisma.platformAccount.findMany({
    where: {
      status: 'risk_control',
      monitoringEnabled: true,
      updatedAt: { lt: riskControlThreshold },
    },
    select: { id: true, platform: true },
  });
  if (staleRiskControl.length > 0) {
    const ids = staleRiskControl.map(u => u.id);
    logger.info({ ids, platforms: staleRiskControl.map(u => u.platform) }, '[MonitorDB] 自动恢复 risk_control 状态');
    await prisma.platformAccount.updateMany({
      where: { id: { in: ids } },
      data: { status: 'active' },
    });
  }

  // ★ 过期 login_required/login_probe 用户触发 probe（数据库驱动恢复）
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
  const staleLoginRequired = await prisma.platformAccount.findMany({
    where: {
      status: { in: ['login_required', 'login_probe'] },
      monitoringEnabled: true,
      updatedAt: { lt: staleThreshold },
    },
    select: { id: true, platform: true, windowId: true },
  });
  if (staleLoginRequired.length > 0) {
    for (const user of staleLoginRequired) {
      const { triggerLoginProbe } = await import('../services/monitorService');
      triggerLoginProbe(user.id, user.platform, String(user.windowId)).catch(() => {});
    }
  }
  // 不再执行 prisma.platformAccount.updateMany 自动恢复为 init

  const users = await prisma.platformAccount.findMany({
    where: {
      status: { notIn: ['blocked', 'login_required', 'risk_control', 'login_probe'] },
      monitoringEnabled: true,
    },
  });

  if (users.length === 0) return [];

  // 过滤：只保留 BrowserWindow 仍存在的用户（窗口解绑/删除后不再监控）
  const windowExternalIds = [...new Set(users.map(u => u.windowId))];
  const activeWindows = await prisma.browserWindow.findMany({
    where: {
      externalId: { in: windowExternalIds },
      status: { not: 'error' },
    },
    select: { externalId: true },
  });
  const activeIds = new Set(activeWindows.map((w: any) => w.externalId));

  return users.filter(u => activeIds.has(u.windowId));
}

/**
 * 根据 ID 获取用户
 */
export function getUserById(userId: number) {
  return prisma.platformAccount.findUnique({ where: { id: userId } });
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
  const mode = setting?.mode || 'simple';
  // normalize legacy 'light' mode
  if (mode === 'light') return 'simple';
  return mode;
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
    is_author?: boolean;
    imageUrls?: string;  // JSON 字符串数组
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
      isAuthor: comment.is_author ?? false,
      imageUrls: comment.imageUrls ?? undefined,
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
      isAuthor: comment.is_author ?? false,
      isNew: 1,
      imageUrls: comment.imageUrls ?? undefined,
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
    is_author?: boolean;
    imageUrls?: string;  // JSON 字符串数组
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
          isAuthor: c.is_author ?? false,
          imageUrls: c.imageUrls ?? undefined,
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
          isAuthor: c.is_author ?? false,
          isNew: 1,
          imageUrls: c.imageUrls ?? undefined,
        },
      });
    }
  });
}

/**
 * 批量 upsert 腾讯视频号评论
 */
export async function batchUpsertComments(
  platform: string,
  comments: Array<{
    comment_id: string;
    content: string;
    nickname: string;
    head_img_url: string;
    user_uid?: string;
    create_time: number;
    like_count: number;
    reply_count: number;
    export_id: string;
    is_author: boolean;
    level: 1 | 2;
    root_id?: string;
    parent_id?: string;
    reply_to_name?: string;
    imageUrls?: string;  // JSON 字符串数组
  }>,
  userId: number,
): Promise<void> {
  if (comments.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const c of comments) {
      await tx.comment.upsert({
        where: { cid: c.comment_id },
        update: {
          text: c.content,
          diggCount: c.like_count,
          level: c.level,
          rootId: c.root_id || null,
          parentId: c.parent_id || null,
          replyToName: c.reply_to_name || null,
          isAuthor: c.is_author,
          imageUrls: c.imageUrls ?? undefined,
        },
        create: {
          videoId: c.export_id,
          cid: c.comment_id,
          text: c.content,
          userNickname: c.nickname,
          userUid: c.user_uid || c.head_img_url || '',
          diggCount: c.like_count,
          createTime: BigInt(c.create_time),
          replyId: c.parent_id || '0',
          rootId: c.root_id || null,
          parentId: c.parent_id || null,
          level: c.level,
          replyToName: c.reply_to_name || null,
          isAuthor: c.is_author,
          isNew: 1,
          imageUrls: c.imageUrls ?? undefined,
        },
      });
    }
  });

  logger.info({ platform, count: comments.length }, '批量写入评论完成');
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
 * 删除指定视频中不在 cid 集合里的根评论计数记录（根评论被删除时清理）
 * @returns 删除的记录数
 */
export async function deleteStaleRootCounts(
  videoId: string,
  activeCids: string[],
): Promise<number> {
  if (activeCids.length === 0) {
    // 没有活跃根评论 → 删光所有记录
    const result = await prisma.videoRootCommentCount.deleteMany({
      where: { videoId },
    });
    return result.count;
  }
  const result = await prisma.videoRootCommentCount.deleteMany({
    where: {
      videoId,
      cid: { notIn: activeCids },
    },
  });
  return result.count;
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

// ============================================================
// AI 客服建议
// ============================================================

/**
 * 查询需要 AI 生成回复建议的评论
 * 条件：isNew=1, suggestionStatus='none', 非作者本人, 非轻量模式占位
 */
export async function getCommentsNeedingSuggestion(
  userId: number,
  limit = 50,
): Promise<Array<{
  id: number;
  cid: string;
  text: string;
  userNickname: string;
  videoId: string;
  level: number;
  rootId: string | null;
  parentId: string | null;
  imageUrls: string | null;
}>> {
  return prisma.comment.findMany({
    where: {
      video: { userId },
      isNew: 1,
      suggestionStatus: 'none',
      userUid: { not: '' },  // 非空 uid
      cid: { not: { startsWith: 'light_' } },  // 排除轻量模式占位
    },
    select: {
      id: true,
      cid: true,
      text: true,
      userNickname: true,
      videoId: true,
      level: true,
      rootId: true,
      parentId: true,
      imageUrls: true,
    },
    take: limit,
    orderBy: { createTime: 'desc' },
  });
}

/**
 * 更新评论的 AI 建议状态
 */
export async function updateCommentSuggestion(
  commentId: number,
  data: {
    suggestedReply: string;
    suggestionStatus: string;
    suggestionModel?: string;
    suggestionLatencyMs?: number;
  },
): Promise<void> {
  await prisma.comment.update({
    where: { id: commentId },
    data: {
      suggestedReply: data.suggestedReply,
      suggestionStatus: data.suggestionStatus,
      suggestionModel: data.suggestionModel || null,
      suggestionLatencyMs: data.suggestionLatencyMs || null,
      suggestionAt: new Date(),
    },
  });
}

/**
 * 标记 AI 建议生成失败
 */
export async function markSuggestionError(commentId: number, error: string): Promise<void> {
  await prisma.comment.update({
    where: { id: commentId },
    data: {
      suggestionStatus: 'error',
      suggestedReply: `[生成失败] ${error.slice(0, 100)}`,
      suggestionAt: new Date(),
    },
  });
}

/**
 * 更新评论的实际回复状态
 */
export async function updateReplyStatus(
  commentId: number,
  status: 'pending' | 'sent' | 'failed',
): Promise<void> {
  await prisma.comment.update({
    where: { id: commentId },
    data: {
      replyStatus: status,
      ...(status === 'sent' ? { repliedAt: new Date() } : {}),
    },
  });
}

/**
 * 同步平台作者 ID（首次绑定 + 自愈检测）
 * - 数据库中无 platformAuthorId → 写入新值
 * - 数据库中已有但与新值不一致 → 更新并记录告警
 * - 已一致 → 跳过（零开销）
 */
export async function syncPlatformAuthorId(
  userId: number,
  newAuthorId: string | number | undefined | null,
  newAuthorName?: string | null,
): Promise<void> {
  if (newAuthorId === undefined || newAuthorId === null || newAuthorId === '') {
    return;
  }

  const newAuthorIdStr = String(newAuthorId);

  const user = await prisma.platformAccount.findUnique({
    where: { id: userId },
    select: { platformAuthorId: true, platform: true },
  });
  if (!user) return;

  const currentId = user.platformAuthorId ?? null;

  if (currentId === null) {
    await prisma.platformAccount.update({
      where: { id: userId },
      data: {
        platformAuthorId: newAuthorIdStr,
        platformAuthorName: newAuthorName || '',
      },
    });
    logger.info(
      { userId, platform: user.platform, authorId: newAuthorIdStr },
      '[AuthorSync] 首次绑定平台作者 ID',
    );
    return;
  }

  if (currentId !== newAuthorIdStr) {
    await prisma.platformAccount.update({
      where: { id: userId },
      data: {
        platformAuthorId: newAuthorIdStr,
        platformAuthorName: newAuthorName || '',
      },
    });
    logger.warn(
      { userId, platform: user.platform, oldAuthorId: currentId, newAuthorId: newAuthorIdStr },
      '[AuthorSync] 平台作者 ID 变更，已更新',
    );
  }
}
