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
import { TencentCrawler } from '../crawlers/tencentCrawler';
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
      createTime?: number;
    };
    subReplies: Array<{
      cid: string;
      text: string;
      userNickname: string;
      replyToName?: string;
      createTime?: number;
    }>;
    newCids: Set<string>;
  }>;
}

// ── 工具函数 ──

/** 格式化相对时间 */
function formatRelativeTime(ts?: number): string {
  if (!ts || ts <= 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

/** 按字节数截断文本（UTF-8 安全） */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  let bytes = 0;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    bytes += Buffer.byteLength(line + '\n', 'utf-8');
    if (bytes > maxBytes) {
      kept.push('  ...(更多内容省略)');
      break;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** 格式化评论树（⭐ 标记新增） */
function formatCommentTree(group: CommentNotificationData['commentGroups'][number]): string {
  const newMarker = (cid: string): string => group.newCids.has(cid) ? '⭐ ' : '  ';
  const lines: string[] = [];

  // ── 根评论 ──
  const rootTime = formatRelativeTime(group.rootComment.createTime);
  const rootTimeStr = rootTime ? ` (${rootTime})` : '';
  lines.push(`${newMarker(group.rootComment.cid)}${group.rootComment.userNickname}: ${group.rootComment.text}${rootTimeStr}`);

  // ── 子回复（新增在前，已有在后） ──
  const sortedSubs = [...group.subReplies].sort((a, b) => {
    const aIsNew = group.newCids.has(a.cid) ? 1 : 0;
    const bIsNew = group.newCids.has(b.cid) ? 1 : 0;
    return bIsNew - aIsNew || (a.createTime || 0) - (b.createTime || 0);
  });

  for (const sub of sortedSubs) {
    const subTime = formatRelativeTime(sub.createTime);
    const subTimeStr = subTime ? ` (${subTime})` : '';
    const toName = sub.replyToName ? `回复 ${sub.replyToName}: ` : '';
    lines.push(`${newMarker(sub.cid)}  └ ${sub.userNickname}: ${toName}${sub.text}${subTimeStr}`);
  }

  return lines.join('\n');
}

/** 获取平台相关信息 */
function getPlatformInfo(platform: string): {
  label: string;
  cardActionUrl: string;
} {
  switch (platform) {
    case 'douyin':
      return { label: '抖音', cardActionUrl: 'https://creator.douyin.com/creator-micro/interactive/comment' };
    case 'kuaishou':
      return { label: '快手', cardActionUrl: 'https://cp.kuaishou.com/content/commentManage' };
    case 'xiaohongshu':
      return { label: '小红书', cardActionUrl: 'https://creator.xiaohongshu.com/notebook-manager/comment' };
    case 'tencent':
      return { label: '视频号', cardActionUrl: 'https://channels.weixin.qq.com/platform/comment' };
    default:
      return { label: platform, cardActionUrl: '' };
  }
}

async function sendMonitorNotification(
  userId: number,
  platform: string,
  type: 'new_comments' | 'risk_detected',
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

    if (!data || data.commentGroups.length === 0) {
      return;
    }

    const pinfo = getPlatformInfo(platform);

    for (const group of data.commentGroups) {
      const newCount = group.newCids.size;

      // 格式化评论树
      const commentTree = formatCommentTree(group);
      const truncated = truncateUtf8(commentTree, 3500);

      // 视频描述截断
      const videoTitle = group.description.slice(0, 40);
      const videoShort = group.description.slice(0, 25);

      // 评论摘要行（展示新评论简要信息）
      const newCommentNames = group.subReplies
        .filter(s => group.newCids.has(s.cid))
        .map(s => s.userNickname)
        .slice(0, 3);
      const rootIsNew = group.newCids.has(group.rootComment.cid);
      const summaryParts: string[] = [];
      if (rootIsNew) summaryParts.push(group.rootComment.userNickname);
      summaryParts.push(...newCommentNames.slice(0, rootIsNew ? 2 : 3));
      const peopleStr = summaryParts.join('、');
      const subTitleText = peopleStr
        ? `${peopleStr} 等发表了新评论（⭐=新增）`
        : `评论树中有 ${newCount} 条新增评论（⭐标记）`;

      const card = {
        card_type: 'text_notice' as const,
        source: {
          icon_url: '',
          desc: `📊 ${pinfo.label}评论监控`,
          desc_color: 0,
        },
        main_title: {
          title: `「${videoTitle}」`,
          desc: `${pinfo.label} · ${newCount} 条新评论`,
        },
        emphasis_content: {
          title: String(newCount),
          desc: '条新评论',
        },
        sub_title_text: subTitleText.slice(0, 200),
        horizontal_content_list: [
          { keyname: '平台', value: pinfo.label },
          { keyname: '视频', value: videoShort },
          { keyname: '总数', value: `${group.subReplies.length + 1} 条` },
        ],
        quote_area: {
          type: 0,
          title: '💬 评论树（⭐=新增）',
          quote_text: truncated,
        },
        jump_list: [
          {
            type: 3,
            title: '回复评论',
            question: `回复 ${group.awemeId} ${group.rootComment.cid}`,
          },
          ...(pinfo.cardActionUrl ? [{
            type: 1 as const,
            title: '查看管理页',
            url: pinfo.cardActionUrl,
          }] : []),
        ],
        card_action: {
          type: 1,
          url: pinfo.cardActionUrl || 'https://creator.douyin.com/creator-micro/interactive/comment',
        },
      };

      try {
        await botManager.sendTemplateCard(targets, card);
        logger.info({ userId, platform, awemeId: group.awemeId }, '已发送企业微信模板卡片通知');
      } catch (err) {
        logger.error({ userId, err }, '发送模板卡片失败，回退到纯文本');
        const fallback = `📊 **${pinfo.label}评论更新**\n> 视频: ${group.description}\n> 新增: ${newCount} 条\n\n${truncated}`;
        await botManager.sendTextMessage(targets, fallback);
      }
    }

    // 跟踪通知，用户后续任意交互将标记这些视频的评论为已读
    if (type === 'new_comments' && data && targets.length > 0) {
      const videoIds = data.commentGroups.map((g) => g.awemeId);
      botManager.trackNotification(targets[0], videoIds);
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

/**
 * 截图二维码并通过 sendLoginAlert 发送给企微用户
 * 优先截取二维码元素（带边距），找不到则截全页
 */
async function captureAndSendQR(page: any, userId: number, platform: string, wechatUserid: string): Promise<void> {
  try {
    // 平台特定的二维码选择器（优先级从高到低）
    const platformSelectors: Record<string, string[]> = {
      douyin: [
        'img[aria-label="二维码"]',
        'img[src*="qrcode"]',
        'canvas',
      ],
      kuaishou: [
        'img[alt="qrcode"]',
        'img[src*="data:image/"]',
        'img[src*="qrcode"]',
        'canvas',
      ],
    };

    // 通用兜底选择器
    const fallbackSelectors = [
      'img[src*="qrcode"]',
      'img[src*="qr"]',
      'img[class*="qrcode"]',
      'canvas',
      '[class*="qrcode"] img',
    ];

    const selectors = [...(platformSelectors[platform] || []), ...fallbackSelectors];

    let buf: Buffer | undefined;
    const PADDING = 40; // 二维码周围留白

    // 尝试找二维码元素并截图（带边距）
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.waitForElementState('visible', { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);

          const box = await el.boundingBox();
          if (box && box.width > 50 && box.height > 50) {
            // 扩大截图区域，确保二维码完整
            const clip = {
              x: Math.max(0, box.x - PADDING),
              y: Math.max(0, box.y - PADDING),
              width: box.width + PADDING * 2,
              height: box.height + PADDING * 2,
            };
            buf = await page.screenshot({ type: 'png', clip });
            logger.info({ platform, userId, selector: sel, width: clip.width, height: clip.height }, '截取二维码区域');
            break;
          }
        }
      } catch {}
    }

    // 没找到则截全页
    if (!buf) {
      buf = await page.screenshot({ type: 'png' });
      logger.info({ platform, userId }, '未找到二维码元素，截取全页');
    }

    await botManager.sendLoginAlert(wechatUserid, platform, userId, buf).catch(() => {});
  } catch (err) {
    // screenshot failed — still send text-only alert
    await botManager.sendLoginAlert(wechatUserid, platform, userId).catch(() => {});
  }
}

const douyinCrawler = new DouyinCrawler(MAX_MONITOR_VIDEOS);
const kuaishouCrawler = new KuaishouCrawler(MAX_MONITOR_VIDEOS);
const xiaohongshuCrawler = new XiaohongshuCrawler(MAX_MONITOR_VIDEOS);
const tencentCrawler = new TencentCrawler(MAX_MONITOR_VIDEOS);

// ============================================================
// BullMQ 队列
// ============================================================

// 任务超时时间：5分钟（防止卡死的任务无限占用资源）
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

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
      await job.updateProgress({ phase: '等待', step: '正在获取窗口锁', percent: 5 });
      lock = await WindowMutex.acquireWithBackoff(task.windowId);

      // 2. 连接指纹浏览器 + 执行3阶段爬取（带超时保护）
      const onProgress = (p: { phase: string; step: string; percent: number; detail?: string }) => {
        job.updateProgress(p).catch(() => {});
      };

      const result = await Promise.race([
        executeMonitorCheck(task, onProgress),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`任务超时: 超过 ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS),
        ),
      ]);

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

          // 查询平台作者 ID 以过滤作者自己的评论
          const user = await prisma.user.findUnique({ where: { id: task.userId } });
          const platformAuthorId = user?.platformAuthorId;

          const commentGroups = phase3Result?.results
            ?.filter((r: any) => r.success && r.commentGroups)
            ?.flatMap((r: any) =>
              r.commentGroups
                .map((g: any) => {
                  // 从 newInGroup 中提取子回复（level=2），并补充到 subReplies
                  const newSubReplies = g.newInGroup
                    .filter((n: any) => n.level === 2 && n.userUid !== platformAuthorId)
                    .map((n: any) => ({
                      cid: n.cid,
                      text: n.text,
                      userNickname: n.userNickname,
                      replyToName: n.replyToName,
                      createTime: n.createTime,
                    }));
                  // 合并 crawler 返回的 subReplies 和从 newInGroup 提取的子回复
                  const allSubReplies = [
                    ...g.subReplies.filter((s: any) => s.userUid !== platformAuthorId),
                    ...newSubReplies,
                  ];
                  // 去重（按 cid）
                  const seenCids = new Set<string>();
                  const dedupedSubReplies = allSubReplies.filter((s: any) => {
                    if (seenCids.has(s.cid)) return false;
                    seenCids.add(s.cid);
                    return true;
                  });

                  return {
                    awemeId: r.awemeId,
                    description: queue.find((q: any) => q.awemeId === r.awemeId)?.description || '',
                    rootComment: g.rootComment,
                    subReplies: dedupedSubReplies,
                    newCids: new Set(
                      g.newInGroup
                        .filter((n: any) => n.userUid !== platformAuthorId)
                        .map((n: any) => n.cid)
                    ),
                  };
                })
                .filter((g: any) => g.newCids.size > 0) // 过滤后无新增的组跳过
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

      // 报告任务完成（失败也算完成，否则调度器会卡死）
      reportMonitorComplete(false);

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
    stalledInterval: 120_000, // 2分钟内无心跳则标记为stalled
  },
);

// Worker 事件处理：确保 stalled/failed 任务也触发 reportMonitorComplete
monitorWorker.on('stalled', (jobId: string) => {
  logger.warn({ jobId }, '⚠️ 任务被标记为stalled（worker可能崩溃），触发调度恢复');
  reportMonitorComplete(false);
});
monitorWorker.on('failed', (job: Job<MonitorTask> | undefined, err: Error) => {
  if (job && job.name !== 'execute_reply') {
    logger.warn({ jobId: job.id, task: job.data.taskId, err: err.message }, 'Worker failed event');
    // 注意：catch 块中已调用 reportMonitorComplete，这里仅作为双保险
  }
});

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

async function executeMonitorCheck(task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
  const bm = getBrowserManager();
  onProgress?.({ phase: '连接', step: '正在连接指纹浏览器', percent: 10 });

  // 连接指纹浏览器（带超时，60 秒）
  const CONNECT_TIMEOUT_MS = 60_000;
  let connectResult: { browser: any; page: any };
  try {
    connectResult = await Promise.race([
      bm.connect(String(task.windowId), '', task.platform),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('连接指纹浏览器超时 (60s)')), CONNECT_TIMEOUT_MS)
      ),
    ]);
  } catch (connectErr: any) {
    logger.error({ userId: task.userId, windowId: task.windowId, err: connectErr.message }, '连接指纹浏览器失败');
    onProgress?.({ phase: '连接', step: '连接失败，60秒后重试', percent: 0, detail: connectErr.message });
    // 清理残留连接
    try { bm.disconnectSession(String(task.windowId), task.platform as any).catch(() => {}); } catch {}
    // 直接返回失败，让 worker 处理重试
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const { page } = connectResult;

  try {
    switch (task.platform) {
      case 'douyin':
        return await runDouyinCheck(page, task, onProgress);
      case 'kuaishou':
        return await runKuaishouCheck(page, task, onProgress);
      case 'xiaohongshu':
        return await runXiaohongshuCheck(page, task, onProgress);
      case 'tencent':
        return await runTencentCheck(page, task, onProgress);
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

async function runDouyinCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
  const crawlMode = await db.getCrawlMode('douyin');

  // 注册 API 拦截器
  await douyinCrawler.registerListener(page, ['/work_list', '/item/list', '/comment/list/select']);

  const currentUrl = page.url();
  if (!currentUrl.includes('creator.douyin.com')) {
    await douyinCrawler.navigateToCreatorHome(page);
  }

  // Phase 1: 发现新评论（视频列表扫描 + 对比数据库）
  onProgress?.({ phase: 'Phase1', step: '扫描视频列表', percent: 20, detail: '正在获取视频列表并对比评论数' });
  const source = ExitStrategy.getQuerySource();
  const phase1Result = await douyinCrawler.checkForUpdates(page, task.userId, task.windowId, source as 'work_list' | 'item_list');

  douyinCrawler.unregisterListener();

  // 风控检测
  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    logger.error({ userId: task.userId, platform: 'douyin', riskType }, '抖音风控触发');
    await db.logRiskScene(task.userId, 'douyin', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) await captureAndSendQR(page, task.userId, 'douyin', user.wechatUserid);
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
  onProgress?.({ phase: 'Phase2', step: '导航到评论管理', percent: 40, detail: `发现 ${queue.length} 个视频有新评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '抖音 Phase 2: 导航到评论管理');
  // 在导航到评论管理页面前注册评论API拦截器（页面加载时会触发初始API调用）
  await douyinCrawler.registerCommentListener(page);
  const navSuccess = await douyinCrawler.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '抖音 Phase 2 失败 — 退出策略');
    await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase2', riskDetected: false };
  }

  // Phase 3: 逐视频打开抽屉 → 点击 → 拦截评论 API → 解析 + 存储
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '抖音 Phase 3: 处理评论队列');
  const phase3Result = await douyinCrawler.processCommentsQueue(page, queue);

  if (phase3Result.riskDetected) {
    const riskType = phase3Result.riskInfo?.type || 'unknown';
    logger.error({ userId: task.userId }, '抖音 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'douyin', riskType, phase3Result.riskInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) await captureAndSendQR(page, task.userId, 'douyin', user.wechatUserid);
    douyinCrawler.unregisterCommentListener();
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase3', riskDetected: true };
  }

  // 执行退出策略
  const successful = phase3Result.results.filter(r => r.success);
  const failed = phase3Result.results.filter(r => !r.success);
  const updates = queue
    .filter(q => successful.some(r => r.awemeId === q.awemeId))
    .map(q => ({
      awemeId: q.awemeId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  logger.info({
    userId: task.userId,
    platform: 'douyin',
    queueLength: queue.length,
    successCount: successful.length,
    failCount: failed.length,
    failedDetails: failed.map(r => ({ awemeId: r.awemeId, error: r.error })),
  }, '[Result] 抖音 Phase3 done: %d/%d succeeded, %d failed', successful.length, queue.length, failed.length);

  onProgress?.({ phase: '退出', step: '执行退出策略', percent: 90, detail: `${successful.length}/${queue.length} 个视频采集成功` });
  await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
  douyinCrawler.unregisterCommentListener();

  logger.info({ userId: task.userId, processed: phase3Result.results.length, successful: successful.length }, '抖音 Phase 3 完成');

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
    _phase3Result: phase3Result,
    _queue: queue,
  };
}

// ============================================================
// 快手监控 — 3阶段流程
// ============================================================

async function runKuaishouCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
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

  // Phase 1 — 随机选择数据源
  onProgress?.({ phase: 'Phase1', step: '扫描视频列表', percent: 20, detail: '正在获取视频列表并对比评论数' });
  const source: 'work_list' | 'photo_analysis' = Math.random() < 0.5 ? 'work_list' : 'photo_analysis';
  const phase1Result = await kuaishouCrawler.checkForUpdates(page, task.userId, source);

  kuaishouCrawler.unregisterListener();

  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    logger.error({ userId: task.userId, platform: 'kuaishou', riskType }, '快手风控触发');
    await db.logRiskScene(task.userId, 'kuaishou', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) await captureAndSendQR(page, task.userId, 'kuaishou', user.wechatUserid);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  if (phase1Result.commentsQueue.length === 0) {
    const exitPage = source === 'work_list' ? 'kuaishou_content' : 'kuaishou_data_center';
    await kuaishouCrawler.executeExitStrategy(page, exitPage as any);
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
  onProgress?.({ phase: 'Phase2', step: '导航到评论管理', percent: 40, detail: `发现 ${queue.length} 个视频有新评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '快手 Phase 2: 导航到评论管理');

  // 在导航到评论管理页面前注册评论API拦截器（页面加载时会触发初始API调用，
  // 必须在 navigation 之前注册才能捕获该响应）
  await kuaishouCrawler.registerCommentListener(page);
  const navSuccess = await kuaishouCrawler.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '快手 Phase 2 失败');
    await kuaishouCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase2', riskDetected: false };
  }

  // Phase 3
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '快手 Phase 3: 处理评论队列');
  const phase3Result = await kuaishouCrawler.processCommentsQueue(page, queue);

  if (phase3Result.riskDetected) {
    const riskType = phase3Result.riskInfo?.type || 'unknown';
    logger.error({ userId: task.userId }, '快手 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'kuaishou', riskType, phase3Result.riskInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) await captureAndSendQR(page, task.userId, 'kuaishou', user.wechatUserid);
    kuaishouCrawler.unregisterCommentListener();
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase3', riskDetected: true };
  }

  const successful = phase3Result.results.filter(r => r.success);
  const failed = phase3Result.results.filter(r => !r.success);
  const updates = queue
    .filter(q => successful.some(r => r.awemeId === q.awemeId))
    .map(q => ({
      awemeId: q.awemeId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  onProgress?.({ phase: '退出', step: '执行退出策略', percent: 90, detail: `${successful.length}/${queue.length} 个视频采集成功` });
  await kuaishouCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
  kuaishouCrawler.unregisterCommentListener();

  logger.info({
    userId: task.userId,
    platform: 'kuaishou',
    queueLength: queue.length,
    successCount: successful.length,
    failCount: failed.length,
    failedDetails: failed.map(r => ({ awemeId: r.awemeId, error: r.error })),
    processed: phase3Result.results.length,
  }, '[Result] 快手 Phase3 done: %d/%d succeeded, %d failed', successful.length, queue.length, failed.length);

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
    _phase3Result: phase3Result,
    _queue: queue,
  };
}

// ============================================================
// 小红书监控 — Light 模式（不支持 Deep 模式）
// ============================================================

async function runXiaohongshuCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
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
// 视频号监控 — 3阶段流程
// ============================================================

async function runTencentCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
  // Phase 0: 登录检测
  onProgress?.({ phase: 'Phase0', step: '检测登录状态', percent: 10, detail: '正在检测视频号登录状态' });
  const loggedIn = await tencentCrawler.handleLogin(page, task.userId);
  if (!loggedIn) {
    logger.error({ userId: task.userId }, '视频号登录失败');
    await db.updateUserStatus(task.userId, 'login_required');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  let crawlMode = await db.getCrawlMode('tencent');

  // Phase 1: 检测更新（视频列表扫描 + 对比数据库）
  onProgress?.({ phase: 'Phase1', step: '扫描视频列表', percent: 20, detail: '正在获取视频列表并对比评论数' });
  const phase1Result = await tencentCrawler.checkForUpdates(page, task.userId);

  tencentCrawler.unregisterListener();

  // 风控检测
  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    logger.error({ userId: task.userId, platform: 'tencent', riskType }, '视频号风控触发');
    await db.logRiskScene(task.userId, 'tencent', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) await captureAndSendQR(page, task.userId, 'tencent', user.wechatUserid);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  // 无新评论 → 执行退出策略并返回
  if (phase1Result.commentsQueue.length === 0) {
    await tencentCrawler.executeExitStrategy(page);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const queue = phase1Result.commentsQueue;

  // Light 模式：仅通知评论数变化，不获取具体内容
  if (crawlMode === 'light') {
    logger.info({ userId: task.userId, queueLength: queue.length }, '视频号 Light 模式 — 跳过 Phase 2/3');
    await tencentCrawler.executeExitStrategy(page);
    const updates = queue.map(q => ({
      awemeId: q.exportId,
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

  // Phase 2: 导航评论管理
  onProgress?.({ phase: 'Phase2', step: '导航到评论管理', percent: 40, detail: `发现 ${queue.length} 个视频有新评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '视频号 Phase 2: 导航到评论管理');
  const navSuccess = await tencentCrawler.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '视频号 Phase 2 失败（可能未实现）— 回退到 Light 模式');
    // Phase 2 未实现时回退到 Light 模式
    await tencentCrawler.executeExitStrategy(page);
    const updates = queue.map(q => ({
      awemeId: q.exportId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));
    return { hasUpdate: true, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase2', riskDetected: false };
  }

  // Phase 3: 逐视频采集评论详情
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '视频号 Phase 3: 处理评论队列');
  const phase3Result = await tencentCrawler.processCommentsQueue(page, queue, task.userId);

  if (phase3Result.some(r => r.error?.includes('风险') || r.error?.includes('captcha'))) {
    const riskType = 'phase3_risk';
    logger.error({ userId: task.userId }, '视频号 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'tencent', riskType, JSON.stringify(phase3Result.filter(r => r.error)));
    await db.updateUserStatus(task.userId, 'login_required');
    const user = await prisma.user.findUnique({ where: { id: task.userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) await captureAndSendQR(page, task.userId, 'tencent', user.wechatUserid);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase3', riskDetected: true };
  }

  // 执行退出策略
  const successful = phase3Result.filter(r => r.success);
  const failed = phase3Result.filter(r => !r.success);
  const updates = queue
    .filter(q => successful.some(r => r.exportId === q.exportId))
    .map(q => ({
      awemeId: q.exportId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  logger.info({
    userId: task.userId,
    platform: 'tencent',
    queueLength: queue.length,
    successCount: successful.length,
    failCount: failed.length,
  }, '[Result] 视频号 Phase3 done: %d/%d succeeded, %d failed', successful.length, queue.length, failed.length);

  onProgress?.({ phase: '退出', step: '执行退出策略', percent: 90, detail: `${successful.length}/${queue.length} 个视频采集成功` });
  await tencentCrawler.executeExitStrategy(page);

  logger.info({ userId: task.userId, processed: phase3Result.length, successful: successful.length }, '视频号 Phase 3 完成');

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
    _phase3Result: { results: phase3Result },
    _queue: queue.map(q => ({ awemeId: q.exportId, description: q.description })),
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
let pendingTaskCount = 0;
let scheduleAfterCompletion = false;

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

    // 去重：查询当前队列中是否已有同用户任务
    const existingJobs = await monitorQueue.getJobs(['active', 'waiting']);
    const activeUserIds = new Set(
      existingJobs.map((j) => j.data.userId).filter(Boolean),
    );
    if (activeUserIds.size > 0) {
      logger.info({ activeUserIds: [...activeUserIds] }, '已有运行中的用户任务，跳过');
    }

    // 入队（跳过已有任务的用户）
    let queued = 0;
    for (const [, userGroup] of byWindow) {
      for (const u of userGroup) {
        if (activeUserIds.has(u.id)) {
          logger.debug({ userId: u.id, platform: u.platform }, '跳过：已有运行中的任务');
          continue;
        }
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

    if (queued === 0 && activeUserIds.size > 0) {
      // 全部被去重，不设置 pendingTaskCount，等当前任务完成后由 reportMonitorComplete 触发下一轮
      logger.info(`📊 监控调度: 全部用户已有任务运行中，跳过入队`);
      return;
    }

    logger.info(`📊 监控调度完成: ${queued} 任务入队 (跳过 ${activeUserIds.size} 个已运行, ${byWindow.size} 窗口)`);
    pendingTaskCount = queued;
    scheduleAfterCompletion = true;
    // 不再立即 scheduleNext，等待所有任务完成后 reportMonitorComplete 触发
  } catch (err) {
    logger.error('监控调度异常:', (err as Error).message);
    scheduleNext();
  }
}

/**
 * 报告一次监控完成（Worker 调用）— 用于动态调整调度频率
 */
export function reportMonitorComplete(hadUpdate: boolean): void {
  if (hadUpdate) {
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
  pendingTaskCount = Math.max(0, pendingTaskCount - 1);
  if (pendingTaskCount === 0 && scheduleAfterCompletion) {
    scheduleAfterCompletion = false;
    scheduleNext();
  }
}

/**
 * 重置调度器计时器——将倒计时置为 0，立即排队执行下一轮监控
 */
export function resetSchedulerTimer(): void {
  // 防止在任务执行期间重复入队
  if (pendingTaskCount > 0) {
    logger.info(`🔄 调度器重置请求被延迟: 当前仍有 ${pendingTaskCount} 个任务执行中`);
    scheduleAfterCompletion = true;
    return;
  }

  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  logger.info('🔄 调度器已重置，立即排队执行');
  scheduleNext(0);
}

/** 根据当前模式计算下次运行间隔并调度 */
function scheduleNext(forceInterval?: number): void {
  lastSchedulerRunAt = Date.now();
  const nextInterval = forceInterval ?? getRandomIntervalForMode(schedulerMode);
  schedulerIntervalMs = nextInterval;
  nextScheduledRunAt = Date.now() + nextInterval;
  schedulerTimer = setTimeout(runOneSchedule, nextInterval);
  const cfg = getMonitorConfig();
  logger.info(`⏰ 下次: ${Math.round(nextInterval / 1000)}秒 (${schedulerMode}, 无更新${consecutiveNoUpdates}/${cfg.idleThreshold})`);
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
    // ── 抖音回复 ──
    if (task.platform === 'douyin') {
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
    }

    // ── 视频号（Tencent）回复 ──
    if (task.platform === 'tencent') {
      const loggedIn = await tencentCrawler.handleLogin(page, task.userId);
      if (!loggedIn) {
        logger.error('回复失败：视频号登录失败');
        return;
      }

      const navSuccess = await tencentCrawler.navigateToCommentManage(page);
      if (!navSuccess) {
        logger.error('回复失败：无法导航到评论管理');
        return;
      }

      const replied = await tencentCrawler.replyToComment(page, replyData.commentCid, replyData.text);
      if (replied) {
        logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '视频号回复执行成功');
      }

      await tencentCrawler.executeExitStrategy(page);
      return;
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '回复执行失败');
  } finally {
    if (task.platform === 'douyin') {
      try {
        await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
      } catch {}
    }
  }
}

export function startMonitorScheduler(): void {
  const cfg = getMonitorConfig();
  schedulerMode = 'active';
  const initialInterval = getRandomIntervalForMode(schedulerMode);
  nextScheduledRunAt = Date.now() + initialInterval;
  schedulerTimer = setTimeout(runOneSchedule, initialInterval);
  logger.info(`⏰ 调度器启动: ${Math.round(initialInterval / 1000)}秒后首次运行 (${schedulerMode}, 无更新${consecutiveNoUpdates}/${cfg.idleThreshold})`);
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
