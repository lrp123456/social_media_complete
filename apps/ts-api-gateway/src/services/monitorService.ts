// @ts-api-gateway/services/monitorService.ts - 评论监控调度器 (BullMQ)
// 3-Phase crawler orchestration — ported from my_folder scheduler.ts

import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { WindowMutex } from '../lib/redlock';
import { HumanActions, BrowserManager, ExitStrategy } from '@social-media/browser-core';
import { getBrowserManager } from '../lib/browserManager';
import type { PlatformName } from '@social-media/shared-config';
import { DouyinCrawler } from '../crawlers/douyinCrawler';
import { KuaishouCrawler } from '../crawlers/kuaishouCrawler';
import { XiaohongshuCrawler } from '../crawlers/xiaohongshuCrawler';
import * as db from './monitorDatabaseService';
import { botManager } from './wechatBotService';
import type { CommentNode } from '../crawlers/douyinCrawler';

const logger = createLogger('monitor-service');

// ============================================================
// 企业微信通知辅助函数（模板卡片增强版）
// ============================================================

interface CommentNotificationData {
  newComments: number;
  commentGroups: Array<{
    awemeId: string;
    description: string;
    rootComment: {
      cid: string;
      text: string;
      userNickname: string;
    };
    subReplies: Array<{
      cid: string;
      text: string;
      userNickname: string;
      replyToName?: string;
    }>;
    newCids: Set<string>;
  }>;
}

async function sendMonitorNotification(
  userId: number,
  platform: string,
  type: 'new_comments' | 'risk_detected' | 'monitor_complete',
  data?: CommentNotificationData,
): Promise<void> {
  try {
    const status = botManager.getStatus();
    if (!status.connected) {
      logger.debug('企业微信机器人未连接，跳过通知');
      return;
    }

    const user = await prisma.user.findFirst({
      where: { id: userId },
      select: { wechatUserid: true },
    }).catch(() => null);

    const targets: string[] = [];
    if (user?.wechatUserid) {
      targets.push(user.wechatUserid);
    }
    if (targets.length === 0) {
      logger.warn({ userId, platform, type }, '未找到用户的企微ID，跳过通知');
      return;
    }

    if (type === 'risk_detected') {
      const content = `⚠️ **风控告警**\n> 平台: ${platform}\n> 用户ID: ${userId}`;
      await botManager.sendTextMessage(targets, content);
      return;
    }

    if (type === 'monitor_complete' || !data || data.commentGroups.length === 0) {
      if (type === 'monitor_complete') {
        const content = `✅ **监控完成**\n> 平台: ${platform}\n> 用户ID: ${userId}`;
        await botManager.sendTextMessage(targets, content);
      }
      return;
    }

    for (const group of data.commentGroups) {
      const newCount = group.newCids.size;

      const commentLines: string[] = [];
      const newMarker = (cid: string) => group.newCids.has(cid) ? ' 🆕' : '';

      commentLines.push(`${group.rootComment.userNickname}: ${group.rootComment.text}${newMarker(group.rootComment.cid)}`);
      for (const sub of group.subReplies) {
        const toName = sub.replyToName ? `@${sub.replyToName} ` : '';
        commentLines.push(`  └ ${sub.userNickname}: ${toName}${sub.text}${newMarker(sub.cid)}`);
      }

      const quoteText = commentLines.join('\n');
      const maxBytes = 3500;
      let truncated = quoteText;
      if (Buffer.byteLength(truncated, 'utf-8') > maxBytes) {
        let bytes = 0;
        const kept: string[] = [];
        for (const line of commentLines) {
          bytes += Buffer.byteLength(line + '\n', 'utf-8');
          if (bytes > maxBytes) {
            kept.push('  ...(更多内容省略)');
            break;
          }
          kept.push(line);
        }
        truncated = kept.join('\n');
      }

      const card = {
        card_type: 'text_notice',
        source: {
          icon_url: '',
          desc: `📊 ${platform === 'douyin' ? '抖音' : platform}评论更新`,
          desc_color: 0,
        },
        main_title: {
          title: group.description.slice(0, 50),
          desc: `新增 ${newCount} 条评论`,
        },
        emphasis_content: {
          title: String(newCount),
          desc: '条新评论',
        },
        sub_title_text: '',
        horizontal_content_list: [
          {
            keyname: '视频',
            value: group.description.slice(0, 30),
          },
        ],
        quote_area: {
          type: 0,
          title: '评论详情',
          quote_text: truncated,
        },
        jump_list: [
          {
            type: 3,
            title: '回复此评论',
            question: `回复 ${group.awemeId} ${group.rootComment.cid}`,
          },
        ],
        card_action: {
          type: 1,
          url: 'https://creator.douyin.com/creator-micro/interactive/comment',
        },
      };

      try {
        await botManager.sendTemplateCard(targets, card);
        logger.info({ userId, platform, awemeId: group.awemeId }, '已发送企业微信模板卡片通知');
      } catch (err) {
        logger.error({ userId, err }, '发送模板卡片失败，回退到纯文本');
        const fallback = `📊 **${platform}评论更新**\n> 视频: ${group.description}\n> 新增: ${newCount} 条\n\n${truncated}`;
        await botManager.sendTextMessage(targets, fallback);
      }
    }

    logger.info({ userId, platform, type, targets }, '已发送企业微信通知');
  } catch (err) {
    logger.error({ userId, platform, type, err }, '发送企业微信通知失败');
  }
}

// ============================================================
// 监控任务接口
// ============================================================

interface MonitorTask {
  taskId: string;
  userId: number;
  platform: PlatformName;
  windowId: string;
  fingerprintWindowId: string;
}

// ============================================================
// 爬虫实例（按平台复用）
// ============================================================

const MAX_MONITOR_VIDEOS = 20;

const douyinCrawler = new DouyinCrawler(MAX_MONITOR_VIDEOS);
const kuaishouCrawler = new KuaishouCrawler(MAX_MONITOR_VIDEOS);
const xiaohongshuCrawler = new XiaohongshuCrawler(MAX_MONITOR_VIDEOS);

// ============================================================
// BullMQ 队列
// ============================================================

export const monitorQueue = new Queue<MonitorTask>('monitor', {
  connection: getRedis(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 300_000 }, // 5min 重试
    removeOnComplete: 50,
    removeOnFail: 100,
  },
});

// ============================================================
// BullMQ Worker
// ============================================================

export const monitorWorker = new Worker<MonitorTask>(
  'monitor',
  async (job: Job<MonitorTask>) => {
    const task = job.data;

    // 回复任务特殊处理
    if (job.name === 'execute_reply') {
      const replyData = (task as any).replyData;
      if (replyData) {
        await executeReplyAction(task, replyData);
      }
      return;
    }

    logger.info(`🔍 监控任务开始: ${task.taskId} → ${task.platform}:${task.userId}`);

    let lock: any = null;
    try {
      // 1. 获取窗口互斥锁
      lock = await WindowMutex.acquireWithBackoff(task.windowId);

      // 2. 连接指纹浏览器 + 执行3阶段爬取
      const result = await executeMonitorCheck(task);

      // 3. 记录结果
      await prisma.operationLog.create({
        data: {
          action: 'monitor_check',
          details: JSON.stringify({
            hasUpdate: result.hasUpdate,
            newComments: result.newComments,
            updatedVideos: result.updatedVideos,
            phase: result.phase,
          }),
          userId: String(task.userId),
          userName: task.platform,
          result: result.riskDetected ? 'failure' : 'success',
          level: result.riskDetected ? 'error' : 'info',
        },
      });

      // 3.5 更新 MonitorStatus — 供前端"上次检查"展示
      try {
        const videoCount = await prisma.video.count({ where: { userId: task.userId } });
        const totalComments = await prisma.video.aggregate({
          where: { userId: task.userId },
          _sum: { commentCount: true },
        });
        await db.updateMonitorStatus(
          task.userId,
          task.platform,
          videoCount,
          totalComments._sum.commentCount ?? 0,
          result.riskDetected ? 'failure' : 'success',
        );
      } catch (statusErr: any) {
        logger.warn({ err: statusErr.message }, '更新 MonitorStatus 失败（不影响主流程）');
      }

      if (result.hasUpdate) {
        logger.info(`✅ 监控: ${task.taskId} (${task.platform}) - ${result.newComments} 新评论, ${result.updatedVideos.length} 视频更新`);

        // 发送新评论通知（Deep 模式）
        if (result.newComments > 0) {
          const phase3Result = (result as any)._phase3Result;
          const queue = (result as any)._queue || [];
          const commentGroups = phase3Result?.results
            ?.filter((r: any) => r.success && r.commentGroups)
            ?.flatMap((r: any) =>
              r.commentGroups.map((g: any) => ({
                awemeId: r.awemeId,
                description: queue.find((q: any) => q.awemeId === r.awemeId)?.description || '',
                rootComment: g.rootComment,
                subReplies: g.subReplies,
                newCids: new Set(g.newInGroup.map((n: any) => n.cid)),
              }))
            ) || [];

          if (commentGroups.length > 0) {
            await sendMonitorNotification(task.userId, task.platform, 'new_comments', {
              newComments: result.newComments,
              commentGroups,
            });
          } else {
            // Light 模式或无评论群时回退到简单通知
            await sendMonitorNotification(task.userId, task.platform, 'new_comments', {
              newComments: result.newComments,
              commentGroups: [],
            });
          }
        }
      } else {
        logger.info(`✅ 监控: ${task.taskId} (${task.platform}) - 无更新`);
      }

      // 报告任务完成（用于动态调整调度频率）
      reportMonitorComplete(result.hasUpdate);

      // 发送监控完成通知（仅在有更新时）
      if (result.hasUpdate) {
        await sendMonitorNotification(task.userId, task.platform, 'monitor_complete');
      }
    } catch (err: any) {
      logger.error(`❌ 监控失败: ${task.taskId} - ${err.message}`);
      await prisma.operationLog.create({
        data: {
          action: 'monitor_check',
          details: JSON.stringify({ error: err.message }),
          userId: String(task.userId),
          result: 'failure',
          level: 'error',
        },
      }).catch(() => {}); // 忽略日志写入失败

      // 发送风控告警通知
      if (err.message?.includes('风控') || err.message?.includes('captcha') || err.message?.includes('验证码')) {
        await sendMonitorNotification(task.userId, task.platform, 'risk_detected').catch(() => {});
      }
    } finally {
      // 确保锁一定被释放（即使 lock 为 null 也不会报错）
      if (lock) {
        await WindowMutex.release(lock, task.windowId).catch((releaseErr) => {
          logger.warn({ taskId: task.taskId, windowId: task.windowId, error: releaseErr.message }, '锁释放异常（将由TTL自动过期）');
        });
      }
    }
  },
  {
    connection: getRedis(),
    concurrency: 3,
    limiter: { max: 10, duration: 60_000 },
  },
);

// ============================================================
// 核心爬取逻辑 — 3阶段流水线 (Phase 1 → Phase 2 → Phase 3)
// ============================================================

interface MonitorResult {
  hasUpdate: boolean;
  newComments: number;
  updatedVideos: Array<{
    awemeId: string;
    description: string;
    oldCount: number;
    newCount: number;
  }>;
  phase: 'Phase1' | 'Phase2' | 'Phase3';
  riskDetected: boolean;
}

async function executeMonitorCheck(task: MonitorTask): Promise<MonitorResult> {
  const bm = getBrowserManager();
  const { browser, page } = await bm.connect(String(task.windowId), '', task.platform);

  try {
    switch (task.platform) {
      case 'douyin':
        return await runDouyinCheck(page, task);
      case 'kuaishou':
        return await runKuaishouCheck(page, task);
      case 'xiaohongshu':
        return await runXiaohongshuCheck(page, task);
      default:
        throw new Error(`不支持的监控平台: ${task.platform}`);
    }
  } catch (err: any) {
    // 错误恢复：尝试执行退出策略，避免页面处于可疑状态
    if (page) {
      try {
        if (task.platform === 'douyin') {
          const source = ExitStrategy.getQuerySource();
          await douyinCrawler.executeExitStrategy(
            page,
            source === 'work_list' ? 'content_management' : 'data_center',
          );
        }
      } catch { /* exit strategy failure is non-critical */ }
    }

    // 断开 CDP 会话（保留浏览器窗口）
    if (err.message?.includes('Frame was detached') ||
        err.message?.includes('Target closed') ||
        err.message?.includes('Session closed')) {
      logger.info({ userId: task.userId, windowId: task.windowId }, 'Detached frame — clearing session, will reconnect next cycle');
    }

    throw err;
  }
}

// ============================================================
// 抖音监控 — 3阶段流程
// ============================================================

async function runDouyinCheck(page: any, task: MonitorTask): Promise<MonitorResult> {
  const crawlMode = await db.getCrawlMode('douyin');

  // 注册 API 拦截器
  await douyinCrawler.registerListener(page, ['/work_list', '/item/list', '/comment/list/select']);

  const currentUrl = page.url();
  if (!currentUrl.includes('creator.douyin.com')) {
    await douyinCrawler.navigateToCreatorHome(page);
  }

  // Phase 1: 发现新评论（视频列表扫描 + 对比数据库）
  const source = ExitStrategy.getQuerySource();
  const phase1Result = await douyinCrawler.checkForUpdates(page, task.userId, task.windowId, source as 'work_list' | 'item_list');

  douyinCrawler.unregisterListener();

  // 风控检测
  if (phase1Result.riskControlDetected) {
    logger.error({ userId: task.userId, platform: 'douyin', riskType: phase1Result.riskControlInfo?.type }, '抖音风控触发');
    await db.logRiskScene(task.userId, 'douyin', phase1Result.riskControlInfo?.type || 'unknown', phase1Result.riskControlInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  // 无新评论 → 执行退出策略并返回
  if (phase1Result.commentsQueue.length === 0) {
    const exitPage = source === 'work_list' ? 'content_management' : 'data_center';
    await douyinCrawler.executeExitStrategy(page, exitPage as any);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const queue = phase1Result.commentsQueue;

  // Light mode: 仅通知评论数变化，不获取具体内容
  if (crawlMode === 'light') {
    logger.info({ userId: task.userId, queueLength: queue.length }, '抖音 Light 模式 — 跳过 Phase 2/3');
    await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    const updates = queue.map(q => ({
      awemeId: q.awemeId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));
    // Light 模式：创建合成 Comment 记录，供前端 new-comments API 显示
    for (const u of updates) {
      const diff = u.newCount - u.oldCount;
      if (diff > 0) {
        await db.upsertLightModeComment(u.awemeId, {
          text: `[轻量模式] ${diff} 条新评论`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }
    return { hasUpdate: true, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase1', riskDetected: false };
  }

  // Phase 2: 导航到评论管理页
  logger.info({ userId: task.userId, queueLength: queue.length }, '抖音 Phase 2: 导航到评论管理');
  const navSuccess = await douyinCrawler.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '抖音 Phase 2 失败 — 退出策略');
    await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase2', riskDetected: false };
  }

  // Phase 3: 逐视频打开抽屉 → 点击 → 拦截评论 API → 解析 + 存储
  logger.info({ userId: task.userId, queueLength: queue.length }, '抖音 Phase 3: 处理评论队列');
  const phase3Result = await douyinCrawler.processCommentsQueue(page, queue);

  if (phase3Result.riskDetected) {
    logger.error({ userId: task.userId }, '抖音 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'douyin', phase3Result.riskInfo?.type || 'unknown', phase3Result.riskInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase3', riskDetected: true };
  }

  // 执行退出策略
  await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');

  const successful = phase3Result.results.filter(r => r.success);
  const updates = queue
    .filter(q => successful.some(r => r.awemeId === q.awemeId))
    .map(q => ({
      awemeId: q.awemeId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  logger.info({ userId: task.userId, processed: phase3Result.results.length, successful: successful.length }, '抖音 Phase 3 完成');

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
  };
}

// ============================================================
// 快手监控 — 3阶段流程
// ============================================================

async function runKuaishouCheck(page: any, task: MonitorTask): Promise<MonitorResult> {
  const crawlMode = await db.getCrawlMode('kuaishou');

  // 注册 API 拦截器
  await kuaishouCrawler.registerListener(page, [
    '/rest/cp/works/v2/video/pc/photo/list',
    '/rest/cp/creator/analysis/pc/photo/list',
    '/rest/cp/comment/pc/list',
  ]);

  const currentUrl = page.url();
  if (!currentUrl.includes('cp.kuaishou.com')) {
    await kuaishouCrawler.navigateToHome(page);
  }

  // Phase 1
  const source: 'work_list' | 'photo_analysis' = 'photo_analysis';
  const phase1Result = await kuaishouCrawler.checkForUpdates(page, task.userId, source);

  kuaishouCrawler.unregisterListener();

  if (phase1Result.riskControlDetected) {
    logger.error({ userId: task.userId, platform: 'kuaishou', riskType: phase1Result.riskControlInfo?.type }, '快手风控触发');
    await db.logRiskScene(task.userId, 'kuaishou', phase1Result.riskControlInfo?.type || 'unknown', phase1Result.riskControlInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  if (phase1Result.commentsQueue.length === 0) {
    await kuaishouCrawler.executeExitStrategy(page, 'kuaishou_content' as any);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const queue = phase1Result.commentsQueue;

  if (crawlMode === 'light') {
    logger.info({ userId: task.userId, queueLength: queue.length }, '快手 Light 模式 — 跳过 Phase 2/3');
    await kuaishouCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    const updates = queue.map(q => ({
      awemeId: q.awemeId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));
    // Light 模式：创建合成 Comment 记录
    for (const u of updates) {
      const diff = u.newCount - u.oldCount;
      if (diff > 0) {
        await db.upsertLightModeComment(u.awemeId, {
          text: `[轻量模式] ${diff} 条新评论`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }
    return { hasUpdate: true, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase1', riskDetected: false };
  }

  // Phase 2
  logger.info({ userId: task.userId, queueLength: queue.length }, '快手 Phase 2: 导航到评论管理');
  const navSuccess = await kuaishouCrawler.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '快手 Phase 2 失败');
    await kuaishouCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase2', riskDetected: false };
  }

  // Phase 3
  logger.info({ userId: task.userId, queueLength: queue.length }, '快手 Phase 3: 处理评论队列');
  const phase3Result = await kuaishouCrawler.processCommentsQueue(page, queue);

  if (phase3Result.riskDetected) {
    logger.error({ userId: task.userId }, '快手 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'kuaishou', phase3Result.riskInfo?.type || 'unknown', phase3Result.riskInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase3', riskDetected: true };
  }

  await kuaishouCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');

  const successful = phase3Result.results.filter(r => r.success);
  const updates = queue
    .filter(q => successful.some(r => r.awemeId === q.awemeId))
    .map(q => ({
      awemeId: q.awemeId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  logger.info({ userId: task.userId, processed: phase3Result.results.length, successful: successful.length }, '快手 Phase 3 完成');

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
  };
}

// ============================================================
// 小红书监控 — Light 模式（不支持 Deep 模式）
// ============================================================

async function runXiaohongshuCheck(page: any, task: MonitorTask): Promise<MonitorResult> {
  // 小红书强制 Light 模式
  let crawlMode = await db.getCrawlMode('xiaohongshu');
  if (crawlMode === 'deep') {
    logger.warn({ userId: task.userId }, '小红书不支持 Deep 模式，强制使用 Light 模式');
    crawlMode = 'light';
  }

  logger.info({ userId: task.userId, windowId: task.windowId }, '[XHS-monitor] Starting xiaohongshu check');

  await xiaohongshuCrawler.registerListener(page, ['/api/galaxy/v2/creator/note/user/posted']);

  const currentUrl = page.url();
  logger.info({ currentUrl, isOnCreator: currentUrl.includes('creator.xiaohongshu.com') }, '[XHS-monitor] Current page state');
  if (!currentUrl.includes('creator.xiaohongshu.com')) {
    logger.info('[XHS-monitor] Not on creator page, navigating...');
    await xiaohongshuCrawler.navigateToCreatorHome(page);
  }

  // Phase 1 (唯一阶段)
  logger.info({ userId: task.userId }, '[XHS-monitor] Starting checkForUpdates');
  const result = await xiaohongshuCrawler.checkForUpdates(page, task.userId);

  xiaohongshuCrawler.unregisterListener();

  if (result.riskControlDetected) {
    logger.error({ userId: task.userId, platform: 'xiaohongshu', riskType: result.riskControlInfo?.type }, '小红书风控触发');
    await db.logRiskScene(task.userId, 'xiaohongshu', result.riskControlInfo?.type || 'unknown', result.riskControlInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  await xiaohongshuCrawler.executeExitStrategy(page);

  const updates = result.updatedVideos.map(v => ({
    awemeId: v.awemeId,
    description: v.description,
    oldCount: v.oldCount,
    newCount: v.newCount,
  }));

  return {
    hasUpdate: result.hasUpdate,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase1',
    riskDetected: false,
  };
}

// ============================================================
// 定时调度：轮询排期规则 + 自动入队
// 支持高频/空闲两种模式自动切换
// ============================================================

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerIntervalMs = 900_000;
let lastSchedulerRunAt = 0;
let nextScheduledRunAt = 0;

// 动态频率控制
let schedulerMode: 'active' | 'idle' = 'active';
let consecutiveNoUpdates = 0;

/** 从 AUTOMATION 配置读取参数（所有值单位：秒） */
function getMonitorConfig() {
  try {
    const { getAutomationConfig } = require('../routes/config-automation');
    const config = getAutomationConfig();
    return {
      activeMin: config.monitor?.interval_active_min ?? 180,
      activeMax: config.monitor?.interval_active_max ?? 300,
      idleMin: config.monitor?.interval_idle_min ?? 900,
      idleMax: config.monitor?.interval_idle_max ?? 1200,
      idleThreshold: config.monitor?.idle_threshold ?? 4,
    };
  } catch {
    return {
      activeMin: 180, activeMax: 300,
      idleMin: 900, idleMax: 1200,
      idleThreshold: 4,
    };
  }
}

/** 根据模式计算随机间隔（秒→毫秒） */
function getRandomIntervalForMode(mode: 'active' | 'idle'): number {
  const cfg = getMonitorConfig();
  const min = mode === 'active' ? cfg.activeMin : cfg.idleMin;
  const max = mode === 'active' ? cfg.activeMax : cfg.idleMax;
  const seconds = Math.floor(Math.random() * (max - min + 1)) + min;
  return seconds * 1000;
}

/**
 * 获取调度器状态（供前端展示倒计时）
 */
export function getSchedulerStatus() {
  const now = Date.now();
  const remaining = Math.max(0, nextScheduledRunAt - now);
  return {
    intervalMs: schedulerIntervalMs,
    lastRunAt: lastSchedulerRunAt,
    nextRunAt: nextScheduledRunAt,
    remainingMs: remaining,
    isRunning: schedulerTimer !== null,
    mode: schedulerMode,
    consecutiveNoUpdates,
  };
}

/**
 * 调度一次监控检查，等待所有任务完成后根据结果决定下一次间隔
 */
async function runOneSchedule(): Promise<void> {
  const startTime = Date.now();
  try {
    const rules = await prisma.scheduleRule.findMany({ where: { enabled: true } });
    const canRun = rules.length === 0 || evaluateRules(rules);

    if (!canRun) {
      logger.debug('排期规则限制，跳过本轮监控');
      return;
    }

    const users = await db.getAllActiveUsers();

    // 按 window_id 分组
    const byWindow = new Map<string, typeof users>();
    for (const u of users) {
      const items = byWindow.get(u.fingerprintWindowId) || [];
      items.push(u);
      byWindow.set(u.fingerprintWindowId, items);
    }

    // 入队
    let queued = 0;
    for (const [, userGroup] of byWindow) {
      for (const u of userGroup) {
        await monitorQueue.add(u.platform, {
          taskId: `mon_${Date.now()}_${u.id}`,
          userId: u.id,
          platform: u.platform as PlatformName,
          windowId: u.fingerprintWindowId,
          fingerprintWindowId: u.fingerprintWindowId,
        });
        queued++;
      }
    }

    logger.info(`📊 监控调度完成: ${queued} 任务入队 (${byWindow.size} 窗口)`);
  } catch (err) {
    logger.error('监控调度异常:', (err as Error).message);
  }

  scheduleNext();
}

/** 根据当前模式计算下次运行间隔并调度 */
function scheduleNext(): void {
  lastSchedulerRunAt = Date.now();
  const nextInterval = getRandomIntervalForMode(schedulerMode);
  schedulerIntervalMs = nextInterval;
  nextScheduledRunAt = Date.now() + nextInterval;
  schedulerTimer = setTimeout(runOneSchedule, nextInterval);

  const cfg = getMonitorConfig();
  logger.info(`⏰ 下次: ${Math.round(nextInterval / 1000)}秒 (${schedulerMode}, 无更新${consecutiveNoUpdates}/${cfg.idleThreshold})`);
}

/**
 * 报告一次监控完成（Worker 调用）— 用于动态调整调度频率
 */
export function reportMonitorComplete(hadUpdate: boolean): void {
  if (hadUpdate) {
    if (schedulerMode !== 'active') {
      logger.info('🔄 检测到评论更新，切换为高频模式');
    }
    schedulerMode = 'active';
    consecutiveNoUpdates = 0;
  } else {
    consecutiveNoUpdates++;
    const cfg = getMonitorConfig();
    if (consecutiveNoUpdates >= cfg.idleThreshold && schedulerMode === 'active') {
      schedulerMode = 'idle';
      logger.info(`💤 连续 ${consecutiveNoUpdates} 次无更新，切换为空闲模式`);
    }
  }
}

export function startMonitorScheduler(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);

  // 从活跃模式开始
  schedulerMode = 'active';
  consecutiveNoUpdates = 0;

  lastSchedulerRunAt = Date.now();
  const initialInterval = getRandomIntervalForMode('active');
  schedulerIntervalMs = initialInterval;
  nextScheduledRunAt = Date.now() + initialInterval;

  logger.info(`⏰ 监控调度器已启动 — 高频模式 (间隔约 ${Math.round(initialInterval / 1000)}秒)`);

  // 使用 setTimeout 开始（支持动态间隔）
  schedulerTimer = setTimeout(runOneSchedule, initialInterval);
}

/**
 * 重启调度器 — 当 AUTOMATION 配置更新时调用
 */
export function restartMonitorScheduler(): void {
  const cfg = getMonitorConfig();
  logger.info(`🔄 重启监控调度器 (高频: ${cfg.activeMin}-${cfg.activeMax}秒, 空闲: ${cfg.idleMin}-${cfg.idleMax}秒, 阈值: ${cfg.idleThreshold})`);
  startMonitorScheduler();
}

// ============================================================
// 回复执行
// ============================================================

async function executeReplyAction(
  task: MonitorTask,
  replyData: { videoId: string; commentCid: string; text: string },
): Promise<void> {
  const bm = getBrowserManager();
  const { page } = await bm.connect(String(task.windowId), '', task.platform);

  try {
    const currentUrl = page.url();
    if (!currentUrl.includes('creator.douyin.com')) {
      await douyinCrawler.navigateToCreatorHome(page);
    }

    const navSuccess = await douyinCrawler.navigateToCommentManage(page);
    if (!navSuccess) {
      logger.error('回复失败：无法导航到评论管理');
      return;
    }

    const drawerOpened = await (douyinCrawler as any).openSelectWorkDrawer(page);
    if (!drawerOpened) {
      logger.error('回复失败：无法打开作品选择抽屉');
      return;
    }

    await (douyinCrawler as any).findAndClickVideoInDrawer(page, replyData.videoId, '');
    await HumanActions.wait(page, 1500, 3000);

    const containerCss = '[class*="container-sXKyMs"]';
    const containers = await HumanActions.queryElementsWithInfo(page, containerCss);
    let targetNodeId: number | null = null;

    for (const c of containers) {
      if (c.text && c.text.includes(replyData.commentCid)) {
        targetNodeId = c.nodeId;
        break;
      }
    }

    if (!targetNodeId) {
      logger.warn({ commentCid: replyData.commentCid }, '回复：未精确匹配目标评论，尝试用第一个评论容器');
      if (containers.length > 0) targetNodeId = containers[0].nodeId;
      else {
        logger.error('回复失败：未找到任何评论容器');
        return;
      }
    }

    const replyBtnClicked = await HumanActions.cdpClickByText(page, '回复', { timeout: 5000 });
    if (!replyBtnClicked) {
      logger.error('回复失败：无法点击回复按钮');
      return;
    }
    await HumanActions.wait(page, 500, 1000);

    const inputCss = 'div[contenteditable="true"]';
    const inputClicked = await HumanActions.cdpClick(page, inputCss, { timeout: 5000 });
    if (!inputClicked) {
      logger.error('回复失败：无法定位输入框');
      return;
    }
    await HumanActions.wait(page, 300, 500);

    for (const char of replyData.text) {
      await HumanActions.cdpKeyPress(page, char, char, char.charCodeAt(0));
      await HumanActions.wait(page, 50, 150);
    }

    await HumanActions.cdpClick(page, '[class*="submit"]', { timeout: 5000 });
    await HumanActions.wait(page, 1000, 2000);

    logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '回复执行成功');
  } catch (err: any) {
    logger.error({ err: err.message }, '回复执行失败');
  } finally {
    try {
      await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    } catch {}
  }
}

function evaluateRules(rules: any[]): boolean {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  for (const rule of rules) {
    switch (rule.ruleType) {
      case 'all_day': return true;
      case 'weekday':
        if (rule.daysOfWeek.split(',').includes(String(dayOfWeek))) {
          return timeStr >= rule.startTime && timeStr <= rule.endTime;
        }
        return false;
      case 'date':
        const today = now.toISOString().slice(0, 10);
        if (rule.specificDate === today) return true;
        return false;
    }
  }

  return true;
}
