// @ts-api-gateway/services/monitorService.ts - 评论监控调度器 (BullMQ)
// 3-Phase crawler orchestration — ported from my_folder scheduler.ts

import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { WindowMutex } from '../lib/redlock';
import { HumanActions, BrowserManager, ExitStrategy } from '@social-media/browser-core';
import { getBrowserManager } from '../lib/browserManager';
import {
  monitorQueue,
  enqueueMonitor,
  cancelledJobIds,
  markJobCancelled,
  isJobCancelled,
  cleanupCancelledJob,
} from './unifiedQueue';
import type { PlatformName } from '@social-media/shared-config';
import { DouyinCrawler, ReplyTarget } from '../crawlers/douyinCrawler';
import { KuaishouCrawler } from '../crawlers/kuaishouCrawler';
import { XiaohongshuCrawler } from '../crawlers/xiaohongshuCrawler';
import { TencentCrawler, TencentReplyTarget } from '../crawlers/tencentCrawler';
import * as db from './monitorDatabaseService';
import { botManager } from './wechatBotService';
import type { CommentNode } from '../crawlers/douyinCrawler';
import { updatePhase } from '../lib/taskExecutionRecorder';

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

export async function sendMonitorNotification(
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
      logger.info({ userId, platform, type, newComments: data?.newComments }, '评论通知跳过：commentGroups 为空（可能是首次爬取尚未采集到评论详情）');
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
            title: '🤖 AI 生成回复',
            question: `ai生成 ${platform} ${group.rootComment.cid}`,
          },
          {
            type: 3,
            title: '📤 发送 AI 回复',
            question: `ai发送 ${platform} ${group.rootComment.cid}`,
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
// AI 客服建议生成
// ============================================================

import { replyGenerator } from './llmService';
import type { CommentContext } from './llmService';

/**
 * 为新评论生成 AI 回复建议（fire-and-forget）
 * 查询 suggestionStatus='none' 的新评论，批量调用 LLM 生成建议
 */
export async function generateSuggestionsForNewComments(userId: number, platform: string): Promise<void> {
  const comments = await db.getCommentsNeedingSuggestion(userId, 30);
  if (comments.length === 0) return;

  logger.info({ userId, platform, count: comments.length }, '开始为新评论生成 AI 回复建议');

  // 获取视频描述用于上下文
  const videoIds = [...new Set(comments.map((c) => c.videoId))];
  const videos = await prisma.video.findMany({
    where: { id: { in: videoIds } },
    select: { id: true, description: true },
  });
  const videoMap = new Map(videos.map((v) => [v.id, v.description]));

  // 获取父评论文本（level 2 评论）
  const parentCids = comments
    .filter((c) => c.level === 2 && c.parentId)
    .map((c) => c.parentId!);
  const parents = parentCids.length > 0
    ? await prisma.comment.findMany({ where: { cid: { in: parentCids } }, select: { cid: true, text: true } })
    : [];
  const parentMap = new Map(parents.map((p) => [p.cid, p.text]));

  // 构建 LLM 上下文
  const batchInput = comments.map((c) => ({
    id: c.id,
    ctx: {
      text: c.text,
      commenterName: c.userNickname,
      platform,
      videoDescription: videoMap.get(c.videoId) || '',
      parentCommentText: c.level === 2 && c.parentId ? parentMap.get(c.parentId) : undefined,
    } as CommentContext,
  }));

  // 批量生成
  const results = await replyGenerator.batchGenerate(batchInput);

  // 更新数据库
  let successCount = 0;
  let errorCount = 0;
  for (const { id, result } of results) {
    if (result.success && result.reply) {
      await db.updateCommentSuggestion(id, {
        suggestedReply: result.reply,
        suggestionStatus: 'ready',
        suggestionModel: result.model,
        suggestionLatencyMs: result.latencyMs,
      });
      successCount++;
    } else {
      await db.markSuggestionError(id, result.error || '未知错误');
      errorCount++;
    }
  }

  logger.info({ userId, total: comments.length, successCount, errorCount }, 'AI 回复建议生成完成');
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
 * 优先使用 LoginTabRegistry 的登录流配置，fallback 到旧版逻辑
 */
export async function captureAndSendQR(page: any, userId: number, platform: string, wechatUserid: string): Promise<void> {
  try {
    const { loginTabRegistry, loadLoginFlowConfig } = await import('./loginFlowHelpers');

    const flowConfigs = loadLoginFlowConfig(platform);
    if (flowConfigs.length === 0) {
      await captureAndSendQRLegacy(page, userId, platform, wechatUserid);
      return;
    }

    const config = flowConfigs[0]; // 使用第一个 flow 的 QR 选择器
    const buf = await loginTabRegistry.captureQR(page, config);
    if (!buf) {
      const { botManager } = await import('../services/wechatBotService');
      await botManager.sendLoginAlert(wechatUserid, platform, userId);
      return;
    }

    const { botManager } = await import('../services/wechatBotService');
    await botManager.sendLoginAlert(wechatUserid, platform, userId, buf);
  } catch (err) {
    const { botManager } = await import('../services/wechatBotService');
    await botManager.sendLoginAlert(wechatUserid, platform, userId).catch(() => {});
  }
}

/**
 * 统一的登录二维码发送函数（所有平台共用）。
 * 1. 检查当前页面是否已在登录页（风控重定向）→ 直接用当前页截图
 * 2. 否则 find 已有登录标签页（避免重复创建）
 * 3. 未找到则 openLoginTab 打开新登录页
 * 4. captureQR 截取二维码 → sendLoginAlert 发送企微通知
 * 5. 若 openLoginTab 失败，fallback 到 captureAndSendQR（当前页面截图）
 */
async function sendLoginQR(page: any, userId: number, platform: string, flowId: string = 'creator'): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { wechatUserid: true, fingerprintWindowId: true },
    });
    if (!user?.wechatUserid) {
      logger.warn({ userId }, `[${platform}] 用户无 wechatUserid，无法发送登录二维码`);
      return;
    }

    const { loginTabRegistry, getLoginFlowConfig } = await import('./loginFlowHelpers');
    const config = getLoginFlowConfig(platform, flowId);

    if (!config || !user.fingerprintWindowId) {
      // 无配置或无 windowId → 使用当前页面截图
      logger.info({ userId, platform }, `[${platform}] 无 loginFlow 配置或 fingerprintWindowId，使用 fallback`);
      await captureAndSendQR(page, userId, platform, user.wechatUserid);
      return;
    }

    // 0. 检查当前页面是否已被重定向到登录页（风控场景常见）
    const currentUrl = page.url();
    const isOnLoginPage = currentUrl.includes('login') || currentUrl.includes('passport') || currentUrl === config.loginUrl;
    if (isOnLoginPage) {
      logger.info({ userId, platform, url: currentUrl }, `[${platform}] 当前页面已在登录域，直接用当前页截图`);
      const qrBuf = await loginTabRegistry.captureQR(page, config);
      if (qrBuf) {
        const { botManager } = await import('./wechatBotService');
        await botManager.sendLoginAlert(user.wechatUserid, platform, userId, qrBuf, flowId);
        logger.info({ userId, platform, flowId }, `[${platform}] 登录二维码已发送（当前页面）`);
        return;
      }
      logger.warn({ userId, platform }, `[${platform}] 当前页面 captureQR 失败，尝试 openLoginTab`);
    }

    const windowId = String(user.fingerprintWindowId);
    const { ensureLoginTab } = await import('./loginFlowHelpers');
    const record = await ensureLoginTab(windowId, userId, platform, flowId);
    if (!record) {
      logger.warn({ userId, platform }, `[${platform}] ensureLoginTab 返回 null，使用 fallback`);
      await captureAndSendQR(page, userId, platform, user.wechatUserid);
      return;
    }

    // 3. 截取二维码
    const qrBuf = await loginTabRegistry.captureQR(record.page, config);
    if (!qrBuf) {
      logger.warn({ userId, platform }, `[${platform}] captureQR 返回 null`);
      await captureAndSendQR(page, userId, platform, user.wechatUserid);
      return;
    }

    // 4. 发送企微通知
    const { botManager } = await import('./wechatBotService');
    await botManager.sendLoginAlert(user.wechatUserid, platform, userId, qrBuf, flowId);
    logger.info({ userId, platform, flowId }, `[${platform}] 登录二维码已发送`);
  } catch (err: any) {
    logger.error({ userId, platform, err: err.message }, `[${platform}] sendLoginQR 异常`);
    // 最终 fallback：当前页面截图
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { wechatUserid: true } });
      if (user?.wechatUserid) await captureAndSendQR(page, userId, platform, user.wechatUserid);
    } catch { /* give up */ }
  }
}

/** 旧版 QR 截取逻辑作为 fallback */
async function captureAndSendQRLegacy(page: any, userId: number, platform: string, wechatUserid: string): Promise<void> {
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
      tencent: [
        'iframe[src*="login-for-iframe"]',
        'img[src*="qrcode"]',
        'img[src*="qr"]',
        'canvas',
        '[class*="qrcode"] img',
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

    // 视频号（tencent）登录页：先等待登录页加载完成，再找二维码
    if (platform === 'tencent') {
      try {
        // 从 /platform 重定向到登录页需要时间，等待 URL 变为 login 或出现二维码元素
        const loginStart = Date.now();
        const LOGIN_TIMEOUT = 15000;
        let loginPageReady = false;

        while (Date.now() - loginStart < LOGIN_TIMEOUT) {
          const url = page.url();
          if (url.includes('/login')) {
            loginPageReady = true;
            break;
          }
          // 检查是否有登录二维码元素（含 iframe）
          const iframeEl = await page.$('iframe[src*="login-for-iframe"]').catch(() => null);
          if (iframeEl) {
            loginPageReady = true;
            break;
          }
          for (const sel of selectors) {
            const el = await page.$(sel).catch(() => null);
            if (el) {
              const box = await el.boundingBox().catch(() => null);
              if (box && box.width > 50 && box.height > 50) {
                loginPageReady = true;
                break;
              }
            }
          }
          if (loginPageReady) break;
          await page.waitForTimeout(500);
        }

        if (!loginPageReady) {
          logger.warn({ userId }, '[QR] Tencent login page did not render within 15s, trying fallback');
        }
      } catch {}
    }

    // ── 穿透 iframe 获取 QR 码（视频号登录页 iframe 结构）──
    // 仅在二维码过期时点击刷新，避免无条件刷新导致二维码进入异常状态
    if (platform === 'tencent') {
      try {
        const iframeEl = await page.$('iframe[src*="login-for-iframe"]').catch(() => null)
          ?? await page.$('iframe.display').catch(() => null);
        if (iframeEl) {
          const frame = await iframeEl.contentFrame();
          if (frame) {
            await frame.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1500);

            // ── 仅在二维码过期时点击刷新（避免无条件刷新导致二维码进入异常状态）──
            try {
              const isExpired = await frame.evaluate(() => {
                const bodyText = document.body?.innerText || '';
                return bodyText.includes('已过期') || bodyText.includes('已失效') || bodyText.includes('已退出')
                  || bodyText.includes('二维码已过期') || bodyText.includes('请刷新');
              }).catch(() => false);

              if (isExpired) {
                logger.info({ platform, userId }, '[QR] QR code expired, clicking refresh');
                // 方式1: 查找刷新按钮
                const refreshSelectors = ['.qrcode-refresh-btn', '[class*="refresh"]', '[class*="Refresh"]'];
                let refreshed = false;
                for (const sel of refreshSelectors) {
                  const btn = await frame.$(sel).catch(() => null);
                  if (btn) {
                    await btn.click().catch(() => {});
                    await page.waitForTimeout(3000);
                    logger.info({ platform, userId, selector: sel }, '已点击 iframe 内二维码刷新按钮');
                    refreshed = true;
                    break;
                  }
                }
                // 方式2: 查找包含"刷新"/"重新生成"文字的元素
                if (!refreshed) {
                  refreshed = await frame.evaluate(() => {
                    const els = document.querySelectorAll('a, button, span, div, p');
                    for (const el of els) {
                      const text = el.textContent?.trim() || '';
                      if (text === '刷新' || text === '重新生成' || text === '点击刷新' || text === '重新获取') {
                        (el as HTMLElement).click();
                        return true;
                      }
                    }
                    return false;
                  }).catch(() => false);
                  if (refreshed) {
                    await page.waitForTimeout(3000);
                    logger.info({ platform, userId }, '已通过文字点击刷新二维码');
                  }
                }
                // 方式3: 点击 QR 区域本身
                if (!refreshed) {
                  const qrEl = await frame.$('img[src*="qr"], img[src*="qrcode"], canvas, [class*="qr"] img').catch(() => null);
                  if (qrEl) {
                    await qrEl.click().catch(() => {});
                    await page.waitForTimeout(3000);
                    logger.info({ platform, userId }, '已点击二维码区域刷新');
                  }
                }
              } else {
                logger.info({ platform, userId }, '[QR] QR code not expired, skipping refresh');
              }
            } catch {}

            // ── 在 iframe 内部用 evaluate 找最大方形 img/canvas ──
            const qrInfo = await frame.evaluate(() => {
              const candidates: Array<{ x: number; y: number; w: number; h: number }> = [];
              const els = document.querySelectorAll('img, canvas, [class*="qr"], [class*="Qr"], [class*="QR"]');
              els.forEach((el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 60 || r.height < 60) return;
                const ratio = Math.min(r.width, r.height) / Math.max(r.width, r.height);
                if (ratio < 0.5) return;
                candidates.push({ x: r.left, y: r.top, w: r.width, h: r.height });
              });
              candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h));
              return candidates[0] || null;
            }).catch(() => null);

            if (qrInfo) {
              const iframeBox = await iframeEl.boundingBox();
              if (iframeBox) {
                const absX = iframeBox.x + qrInfo.x;
                const absY = iframeBox.y + qrInfo.y;
                const maxDim = Math.max(qrInfo.w, qrInfo.h);
                const PAD = Math.round(maxDim * 0.15);
                const side = maxDim + PAD * 2;
                const cx = absX + qrInfo.w / 2;
                const cy = absY + qrInfo.h / 2;
                const clip = {
                  x: Math.max(0, cx - side / 2),
                  y: Math.max(0, cy - side / 2),
                  width: side,
                  height: side,
                };
                buf = await page.screenshot({ type: 'png', clip });
                logger.info({ platform, userId, qrW: qrInfo.w, qrH: qrInfo.h, clipSide: side }, '截取 iframe 内二维码 (方形+padding)');
              }
            }

            // iframe 内未找到 → 截取 iframe 元素 + padding
            if (!buf) {
              const iframeBox = await iframeEl.boundingBox();
              if (iframeBox && iframeBox.width > 100 && iframeBox.height > 100) {
                const PAD = 40;
                const clip = {
                  x: Math.max(0, iframeBox.x - PAD),
                  y: Math.max(0, iframeBox.y - PAD),
                  width: iframeBox.width + PAD * 2,
                  height: iframeBox.height + PAD * 2,
                };
                buf = await page.screenshot({ type: 'png', clip });
                logger.info({ platform, userId, width: clip.width, height: clip.height }, '截取 iframe 元素 + padding');
              }
            }
          }
        }
      } catch {}
    }

    // 非 iframe 结构：尝试找二维码元素并截图（带边距，正方形）
    if (!buf) {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.waitForElementState('visible', { timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(500);

            const box = await el.boundingBox();
            if (box && box.width > 50 && box.height > 50) {
              // 正方形裁剪 + 四周扩大 padding
              const maxDim = Math.max(box.width, box.height);
              const cx = box.x + box.width / 2;
              const cy = box.y + box.height / 2;
              const side = maxDim + PADDING * 2;
              const clip = {
                x: Math.max(0, cx - side / 2),
                y: Math.max(0, cy - side / 2),
                width: side,
                height: side,
              };
              buf = await page.screenshot({ type: 'png', clip });
              logger.info({ platform, userId, selector: sel, clipSide: side }, '截取二维码区域 (方形+padding)');
              break;
            }
          }
        } catch {}
      }
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

// ============================================================
// per-flowId Redis 状态管理（login_required / login_probe）
// ============================================================

interface LoginFlowState {
  status: 'login_required' | 'login_probe';
  cooldownLevel: number;
  cooldownUntil: number;
  lastProbeAt: number;
}

const FLOW_STATE_KEY_PREFIX = 'login_flow_state';

function getFlowStateKey(userId: number, flowId: string): string {
  return `${FLOW_STATE_KEY_PREFIX}:${userId}:${flowId}`;
}

export async function setFlowState(userId: number, flowId: string, state: LoginFlowState): Promise<void> {
  const redis = getRedis();
  await redis.set(getFlowStateKey(userId, flowId), JSON.stringify(state));
}

export async function getFlowState(userId: number, flowId: string): Promise<LoginFlowState | null> {
  const redis = getRedis();
  const raw = await redis.get(getFlowStateKey(userId, flowId));
  return raw ? JSON.parse(raw) : null;
}

export async function delFlowState(userId: number, flowId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(getFlowStateKey(userId, flowId));
}

// ============================================================
// login probe 恢复（数据库驱动 + per-flowId 冷却）
// ============================================================

export async function triggerLoginProbe(userId: number, platform: string, windowId: string, flowId?: string): Promise<void> {
  const { loginTabRegistry, getLoginFlowConfig, getFlowIdsForPlatform } = await import('./loginFlowHelpers');
  const bm = getBrowserManager();

  const flowIds = flowId ? [flowId] : getFlowIdsForPlatform(platform);
  for (const fid of flowIds) {
    const config = getLoginFlowConfig(platform, fid);
    if (!config) continue;
    const state = await getFlowState(userId, fid);
    if (!state || state.cooldownUntil > Date.now()) continue;

    setTimeout(async () => {
      try {
        const browser = await bm.getBrowser(windowId);
        if (!browser) return;

        const record = await loginTabRegistry.find(windowId, fid, browser, config.domain);
        if (!record) {
          await delFlowState(userId, fid);
          return;
        }

        const result = await loginTabRegistry.checkLoginState(record.page, config);
        if (result === 'logged_in') {
          if (config.closeOnLoginSuccess) {
            await loginTabRegistry.closeLoginTab(windowId, fid);
          } else {
            await loginTabRegistry.unregister(windowId, fid);
          }
          await delFlowState(userId, fid);

          const allStates = await getAllFlowStates(userId, platform);
          if (allStates.size === 0) {
            const { prisma } = await import('../lib/prisma');
            await prisma.user.update({
              where: { id: userId },
              data: { status: 'active', cooldownUntil: BigInt(0) },
            });
          }
        } else {
          const newLevel = Math.min((state.cooldownLevel || 0) + 1, 4);
          const cooldownsMs = [30, 60, 120, 240, 240];
          const cooldownMs = cooldownsMs[newLevel] * 60 * 1000;
          await setFlowState(userId, fid, {
            status: 'login_required',
            cooldownLevel: newLevel,
            cooldownUntil: Date.now() + cooldownMs,
            lastProbeAt: Date.now(),
          });

          const next = setTimeout(() => {
            triggerLoginProbe(userId, platform, windowId, fid).catch(() => {});
          }, cooldownMs);
          next.unref();
        }
      } catch { /* probe 失败不阻塞 */ }
    }, 100);
  }
}

async function getAllFlowStates(userId: number, platform: string): Promise<Map<string, LoginFlowState>> {
  const { getFlowIdsForPlatform } = await import('./loginFlowHelpers');
  const flowIds = getFlowIdsForPlatform(platform);
  const result = new Map<string, LoginFlowState>();
  for (const fid of flowIds) {
    const state = await getFlowState(userId, fid);
    if (state) result.set(fid, state);
  }
  return result;
}

// Crawler 按窗口实例化，避免 interceptor/listener 跨窗口串扰
const crawlerCache = {
  douyin: new Map<string, DouyinCrawler>(),
  kuaishou: new Map<string, KuaishouCrawler>(),
  xiaohongshu: new Map<string, XiaohongshuCrawler>(),
  tencent: new Map<string, TencentCrawler>(),
};

function getDouyinCrawler(windowId: string): DouyinCrawler {
  if (!crawlerCache.douyin.has(windowId)) {
    crawlerCache.douyin.set(windowId, new DouyinCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.douyin.get(windowId)!;
}

function getKuaishouCrawler(windowId: string): KuaishouCrawler {
  if (!crawlerCache.kuaishou.has(windowId)) {
    crawlerCache.kuaishou.set(windowId, new KuaishouCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.kuaishou.get(windowId)!;
}

function getXiaohongshuCrawler(windowId: string): XiaohongshuCrawler {
  if (!crawlerCache.xiaohongshu.has(windowId)) {
    crawlerCache.xiaohongshu.set(windowId, new XiaohongshuCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.xiaohongshu.get(windowId)!;
}

function getTencentCrawler(windowId: string): TencentCrawler {
  if (!crawlerCache.tencent.has(windowId)) {
    crawlerCache.tencent.set(windowId, new TencentCrawler(MAX_MONITOR_VIDEOS));
  }
  return crawlerCache.tencent.get(windowId)!;
}

function releaseCrawler(platform: string, windowId: string): void {
  const cache = crawlerCache[platform as keyof typeof crawlerCache];
  if (!cache) return;
  const crawler = cache.get(windowId);
  if (!crawler) return;
  try { (crawler as any).unregisterListener?.(); } catch {}
  try { (crawler as any).unregisterCommentListener?.(); } catch {}
  // 清理小红书的独立评论拦截器
  try {
    if ((crawler as any).commentInterceptor) {
      (crawler as any).commentInterceptor.unregisterAll?.();
      (crawler as any).commentInterceptor = null;
    }
    if ((crawler as any).commentListenerId) {
      (crawler as any).commentListenerId = null;
    }
  } catch {}
  cache.delete(windowId);
}

// ============================================================
// BullMQ 队列
// ============================================================

// 任务超时时间：10分钟（评论采集需要处理多个视频的抽屉点击+滚动+展开）
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================
// 向后兼容：从 unifiedQueue 导入并重新导出
// cancelledJobIds, markJobCancelled, isJobCancelled, cleanupCancelledJob, monitorQueue
// ============================================================

export { cancelledJobIds, markJobCancelled, isJobCancelled, cleanupCancelledJob, monitorQueue };

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

export async function executeMonitorCheck(
  task: MonitorTask,
  onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void,
  checkCancelled?: () => void,
): Promise<MonitorResult> {
  const bm = getBrowserManager();
  checkCancelled?.();
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
          await getDouyinCrawler(task.windowId).executeExitStrategy(
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
  const dy = getDouyinCrawler(task.windowId);
  const crawlMode = await db.getCrawlMode('douyin');

  // 注册 API 拦截器
  await dy.registerListener(page, ['/work_list', '/item/list', '/comment/list/select']);

  const currentUrl = page.url();
  if (!currentUrl.includes('creator.douyin.com')) {
    await dy.navigateToCreatorHome(page);
  }

  // Phase 1: 发现新评论（视频列表扫描 + 对比数据库）
  onProgress?.({ phase: 'Phase1', step: '扫描视频列表', percent: 20, detail: '正在获取视频列表并对比评论数' });
  const source = ExitStrategy.getQuerySource();
  const phase1Result = await dy.checkForUpdates(page, task.userId, task.windowId, source as 'work_list' | 'item_list');

  dy.unregisterListener();

  // 风控检测
  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    logger.error({ userId: task.userId, platform: 'douyin', riskType }, '抖音风控触发');
    await db.logRiskScene(task.userId, 'douyin', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    await sendLoginQR(page, task.userId, 'douyin');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  // 无新评论 → 执行退出策略并返回
  if (phase1Result.commentsQueue.length === 0) {
    const exitPage = source === 'work_list' ? 'content_management' : 'data_center';
    await dy.executeExitStrategy(page, exitPage as any);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const queue = phase1Result.commentsQueue;

  // Light mode: 仅通知评论数变化，不获取具体内容
  if (crawlMode === 'light') {
    logger.info({ userId: task.userId, queueLength: queue.length }, '抖音 Light 模式 — 跳过 Phase 2/3');
    await dy.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
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
  await dy.registerCommentListener(page);
  const navSuccess = await dy.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '抖音 Phase 2 失败 — 退出策略');
    await dy.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase2', riskDetected: false };
  }

  // Phase 3: 逐视频打开抽屉 → 点击 → 拦截评论 API → 解析 + 存储
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '抖音 Phase 3: 处理评论队列');
  const phase3Result = await dy.processCommentsQueue(page, queue);

  if (phase3Result.riskDetected) {
    const riskType = phase3Result.riskInfo?.type || 'unknown';
    logger.error({ userId: task.userId }, '抖音 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'douyin', riskType, phase3Result.riskInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    await sendLoginQR(page, task.userId, 'douyin');
    dy.unregisterCommentListener();
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
  await dy.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
  dy.unregisterCommentListener();

  logger.info({ userId: task.userId, processed: phase3Result.results.length, successful: successful.length }, '抖音 Phase 3 完成');

  releaseCrawler('douyin', task.windowId);

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
  const ks = getKuaishouCrawler(task.windowId);
  const crawlMode = await db.getCrawlMode('kuaishou');

  // Phase 0: 登录检测
  onProgress?.({ phase: 'Phase0', step: '检测登录状态', percent: 5, detail: '正在检测快手登录状态' });

  // 先导航到快手创作者中心
  const currentUrl = page.url();
  if (!currentUrl.includes('cp.kuaishou.com')) {
    await ks.navigateToHome(page);
  }

  // 检测登录状态（支持扫码等待）
  const loginSuccess = await ks.handleLogin(page, task.userId, onProgress);
  if (!loginSuccess) {
    logger.error({ userId: task.userId }, '快手登录失败');
    await db.updateUserStatus(task.userId, 'login_required');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  // 注册 API 拦截器
  await ks.registerListener(page, [
    '/rest/cp/works/v2/video/pc/photo/list',
    '/rest/cp/creator/analysis/pc/photo/list',
    '/rest/cp/comment/pc/list',
  ]);

  // Phase 1 — 统一使用 work_list 数据源（photo_analysis 返回数量少且 ID 体系不同，
  // 交替使用会导致 reconcile 误删视频，见 issue: 两源交替循环删除）
  onProgress?.({ phase: 'Phase1', step: '扫描视频列表', percent: 20, detail: '正在获取视频列表并对比评论数' });
  const source = 'work_list' as const;
  const phase1Result = await ks.checkForUpdates(page, task.userId, task.windowId, source);

  ks.unregisterListener();

  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    logger.error({ userId: task.userId, platform: 'kuaishou', riskType }, '快手风控触发');
    await db.logRiskScene(task.userId, 'kuaishou', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    await sendLoginQR(page, task.userId, 'kuaishou');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  if (phase1Result.commentsQueue.length === 0) {
    await ks.executeExitStrategy(page, 'kuaishou_content' as any);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const queue = phase1Result.commentsQueue;

  if (crawlMode === 'light') {
    logger.info({ userId: task.userId, queueLength: queue.length }, '快手 Light 模式 — 跳过 Phase 2/3');
    await ks.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
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
  await ks.registerCommentListener(page);
  const navSuccess = await ks.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '快手 Phase 2 失败');
    await ks.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase2', riskDetected: false };
  }

  // Phase 3
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '快手 Phase 3: 处理评论队列');
  const phase3Result = await ks.processCommentsQueue(page, queue);

  if (phase3Result.riskDetected) {
    const riskType = phase3Result.riskInfo?.type || 'unknown';
    logger.error({ userId: task.userId }, '快手 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'kuaishou', riskType, phase3Result.riskInfo?.evidence || '');
    await db.updateUserStatus(task.userId, 'login_required');
    await sendLoginQR(page, task.userId, 'kuaishou');
    ks.unregisterCommentListener();
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
  await ks.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
  ks.unregisterCommentListener();

  logger.info({
    userId: task.userId,
    platform: 'kuaishou',
    queueLength: queue.length,
    successCount: successful.length,
    failCount: failed.length,
    failedDetails: failed.map(r => ({ awemeId: r.awemeId, error: r.error })),
    processed: phase3Result.results.length,
  }, '[Result] 快手 Phase3 done: %d/%d succeeded, %d failed', successful.length, queue.length, failed.length);

  releaseCrawler('kuaishou', task.windowId);

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
// 小红书监控（支持 Light / Deep 模式）
// ============================================================

async function runXiaohongshuCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
  const xhs = getXiaohongshuCrawler(task.windowId);
  const crawlMode = await db.getCrawlMode('xiaohongshu');
  const redis = getRedis();

  logger.info({ userId: task.userId, crawlMode }, '[XHS-monitor] Starting xiaohongshu check');

  // 登录态恢复标记检测（仅日志，实际验证在 Phase 3 内联完成）
  const loginRecheckKey = `xhs:login_recheck:${task.userId}`;
  const needsLoginRecheck = await redis.get(loginRecheckKey);
  if (needsLoginRecheck) {
    logger.info({ userId: task.userId }, '[XHS-monitor] 检测到登录态恢复标记，将在 Phase 3 内联验证');
  }

  await xhs.registerListener(page, ['/api/galaxy/v2/creator/note/user/posted']);

  const currentUrl = page.url();
  if (!currentUrl.includes('creator.xiaohongshu.com')) {
    await xhs.navigateToCreatorHome(page);
  }

  // Phase 1: 笔记列表扫描 + 非公开过滤
  onProgress?.({ phase: 'Phase1', step: '扫描笔记列表', percent: 20, detail: '正在获取笔记列表并对比评论数' });
  const phase1Result = await xhs.checkForUpdates(page, task.userId);
  xhs.unregisterListener();

  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    logger.error({ userId: task.userId, platform: 'xiaohongshu', riskType }, '小红书风控触发');
    await db.logRiskScene(task.userId, 'xiaohongshu', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    // 登录失效时发送 QR 码到企微
    if (['login_redirect', 'session_expired', 'url_redirect'].includes(riskType)) {
      await db.updateUserStatus(task.userId, 'login_required');
      await sendLoginQR(page, task.userId, 'xiaohongshu');
    }
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  const queue = phase1Result.commentsQueue || [];

  // 无新评论或 Light 模式 → 正常退出
  if (crawlMode === 'light' || queue.length === 0) {
    // recheck 标记清理：无新评论说明登录态不影响，清除标记
    if (needsLoginRecheck && queue.length === 0) {
      await redis.del(loginRecheckKey);
      logger.info({ userId: task.userId }, '[XHS-monitor] 无评论变化，清除登录态恢复标记');
    }
    await xhs.executeExitStrategy(page);
    const updates = (phase1Result.updatedVideos || []).map((v: any) => ({
      awemeId: v.awemeId,
      description: v.description,
      oldCount: v.oldCount,
      newCount: v.newCount,
    }));

    // Light 模式：更新评论数和标记已通知（Phase3 不会运行）
    for (const u of updates) {
      const diff = u.newCount - u.oldCount;
      if (diff > 0) {
        await db.updateCommentCount(u.awemeId, u.newCount);
        await db.markCommentsAsNotified(u.awemeId);
        // 创建轻量模式合成评论，供前端 new-comments API 显示
        await db.upsertLightModeComment(u.awemeId, {
          text: `[轻量模式] ${diff} 条新评论`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }

    return { hasUpdate: phase1Result.hasUpdate, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase1', riskDetected: false };
  }

  // Phase 3: 评论树采集（有新评论 + Deep 模式）
  // 登录检测已内联到 processOneNoteComments（点击缩略图时）
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '[XHS-Phase3] Processing comments queue');

  const phase3Result = await xhs.processCommentsQueue(page, queue, task.userId);

  // 退出策略
  await xhs.executeExitStrategy(page);

  // 处理登录失效（Phase 3 内联检测到的）
  const hasLoginRequired = phase3Result.some((r: any) => r.loginRequired);
  if (hasLoginRequired) {
    logger.info({ userId: task.userId }, '[XHS-monitor] 主站未登录 — 暂停监控，等待扫码恢复');
    await db.updateUserStatus(task.userId, 'login_required');
    await redis.set(loginRecheckKey, '1', 'EX', 86400); // 24h TTL

    // Light 模式合成 Comment
    const updates = (phase1Result.updatedVideos || []).map((v: any) => ({
      awemeId: v.awemeId,
      description: v.description,
      oldCount: v.oldCount,
      newCount: v.newCount,
    }));
    for (const u of updates) {
      const diff = u.newCount - u.oldCount;
      if (diff > 0) {
        await db.upsertLightModeComment(u.awemeId, {
          text: `[轻量模式] ${diff} 条新评论（主站未登录）`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }
    return { hasUpdate: updates.length > 0, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase3', riskDetected: false };
  }

  // 登录正常 → 清除 recheck 标记
  if (needsLoginRecheck) {
    await redis.del(loginRecheckKey);
    logger.info({ userId: task.userId }, '[XHS-monitor] 主站登录已恢复 — 清除恢复标记');
  }

  const successful = phase3Result.filter((r: any) => r.success);
  const failed = phase3Result.filter((r: any) => !r.success);
  const updates = queue
    .filter((q: any) => successful.some((r: any) => r.awemeId === q.exportId))
    .map((q: any) => ({
      awemeId: q.exportId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  // Phase3 成功后更新评论数和标记已通知（之前在 Phase1 中做，现在移到 Phase3 之后）
  for (const u of updates) {
    await db.updateCommentCount(u.awemeId, u.newCount);
    await db.markCommentsAsNotified(u.awemeId);
  }

  // Phase3 失败的视频：如果 Phase3 没有成功采集评论树，仍然更新评论数（使用 API 返回的轻量计数）
  // 这样至少能保证数据库中的评论数是最新的，即使没有详细的评论树
  const failedUpdates = queue
    .filter((q: any) => failed.some((r: any) => r.awemeId === q.exportId))
    .map((q: any) => ({
      awemeId: q.exportId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));
  for (const u of failedUpdates) {
    const diff = u.newCount - u.oldCount;
    if (diff > 0) {
      await db.updateCommentCount(u.awemeId, u.newCount);
      await db.markCommentsAsNotified(u.awemeId);
      // 创建轻量模式合成评论，供前端 new-comments API 显示
      await db.upsertLightModeComment(u.awemeId, {
        text: `[轻量模式] ${diff} 条新评论（Phase3 采集失败）`,
        create_time: Math.floor(Date.now() / 1000),
      });
    }
  }

  logger.info({
    userId: task.userId,
    platform: 'xiaohongshu',
    queueLength: queue.length,
    successCount: successful.length,
    failCount: failed.length,
  }, '[Result] 小红书 Phase3 done');

  releaseCrawler('xiaohongshu', task.windowId);

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
  };
}

// ============================================================
// 视频号监控 — 3阶段流程
// ============================================================

async function runTencentCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
  const tc = getTencentCrawler(task.windowId);
  // Phase 0: 登录检测
  onProgress?.({ phase: 'Phase0', step: '检测登录状态', percent: 10, detail: '正在检测视频号登录状态' });
  const loggedIn = await tc.handleLogin(page, task.userId);
  if (!loggedIn) {
    logger.error({ userId: task.userId }, '视频号登录失败');
    await db.updateUserStatus(task.userId, 'login_required');
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  let crawlMode = await db.getCrawlMode('tencent');

  // Phase 1: 检测更新（视频列表扫描 + 对比数据库）
  onProgress?.({ phase: 'Phase1', step: '扫描视频列表', percent: 20, detail: '正在获取视频列表并对比评论数' });
  const phase1Result = await tc.checkForUpdates(page, task.userId);

  tc.unregisterListener();

  // 风控检测
  if (phase1Result.riskControlDetected) {
    const riskType = phase1Result.riskControlInfo?.type || 'unknown';
    // 区分风控与登录过期：只有 session_expired/url_redirect 才需要重新登录
    // risk_keyword/captcha 是临时风控，用 risk_control 状态（短冷却自动恢复）
    const isLoginExpired = ['session_expired', 'login_redirect', 'url_redirect'].includes(riskType);
    logger.error({ userId: task.userId, platform: 'tencent', riskType, isLoginExpired }, '视频号风控触发');
    await db.logRiskScene(task.userId, 'tencent', riskType, phase1Result.riskControlInfo?.evidence || '');
    await db.updateUserStatus(task.userId, isLoginExpired ? 'login_required' : 'risk_control');
    if (isLoginExpired) {
      await sendLoginQR(page, task.userId, 'tencent');
    }
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  // 无新评论 → 执行退出策略并返回
  if (phase1Result.commentsQueue.length === 0) {
    await tc.executeExitStrategy(page);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: false };
  }

  const queue = phase1Result.commentsQueue;

  // Light 模式：仅通知评论数变化，不获取具体内容
  if (crawlMode === 'light') {
    logger.info({ userId: task.userId, queueLength: queue.length }, '视频号 Light 模式 — 跳过 Phase 2/3');
    await tc.executeExitStrategy(page);
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
  const navSuccess = await tc.navigateToCommentManage(page);
  if (!navSuccess) {
    logger.warn({ userId: task.userId }, '视频号 Phase 2 失败（可能未实现）— 回退到 Light 模式');
    // Phase 2 未实现时回退到 Light 模式
    await tc.executeExitStrategy(page);
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
  const phase3Result = await tc.processCommentsQueue(page, queue, task.userId);

  if (phase3Result.some(r => r.error?.includes('风险') || r.error?.includes('captcha') || r.error?.includes('Risk control'))) {
    const riskType = 'phase3_risk';
    logger.error({ userId: task.userId }, '视频号 Phase 3 风控触发');
    await db.logRiskScene(task.userId, 'tencent', riskType, JSON.stringify(phase3Result.filter(r => r.error)));
    // Phase 3 风控通常是临时性的，用 risk_control 状态（短冷却自动恢复），不强制重新登录
    await db.updateUserStatus(task.userId, 'risk_control');
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
  await tc.executeExitStrategy(page);

  logger.info({ userId: task.userId, processed: phase3Result.length, successful: successful.length }, '视频号 Phase 3 完成');

  releaseCrawler('tencent', task.windowId);

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
// 定时调度：每 (窗口, 平台) 独立计时 + 空闲/活跃模式自动切换
// ============================================================

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  intervalMs: number;
  nextRunAt: number;
  lastRunAt: number;
  mode: 'active' | 'idle';
  consecutiveNoUpdates: number;
  pendingTaskCount: number;
  scheduleAfterCompletion: boolean;
}

/** key = `${windowId}_${platform}`，每 (窗口, 平台) 独立调度 */
const schedulerStates = new Map<string, SchedulerState>();

function stateKey(windowId: string, platform: string): string {
  return `${windowId}_${platform}`;
}

function getOrCreateSchedulerState(windowId: string, platform: string): SchedulerState {
  const key = stateKey(windowId, platform);
  let st = schedulerStates.get(key);
  if (!st) {
    st = {
      timer: null,
      intervalMs: getRandomIntervalForMode('active', platform),
      nextRunAt: 0,
      lastRunAt: 0,
      mode: 'active',
      consecutiveNoUpdates: 0,
      pendingTaskCount: 0,
      scheduleAfterCompletion: false,
    };
    schedulerStates.set(key, st);
  }
  return st;
}

/** 从 AUTOMATION 配置读取参数（所有值单位：秒） */
function getMonitorConfig(platform?: string) {
  try {
    const { getAutomationConfig } = require('../routes/config-automation');
    const config = getAutomationConfig();
    const overrides = platform ? config.monitor?.platformOverrides?.[platform] : undefined;
    return {
      activeMin: overrides?.interval_active_min ?? config.monitor?.interval_active_min ?? 180,
      activeMax: overrides?.interval_active_max ?? config.monitor?.interval_active_max ?? 300,
      idleMin: overrides?.interval_idle_min ?? config.monitor?.interval_idle_min ?? 900,
      idleMax: overrides?.interval_idle_max ?? config.monitor?.interval_idle_max ?? 1200,
      idleThreshold: overrides?.idle_threshold ?? config.monitor?.idle_threshold ?? 4,
      sleepStartHour: config.monitor?.sleep_start_hour ?? 2,
      sleepEndHour: config.monitor?.sleep_end_hour ?? 8,
    };
  } catch {
    return {
      activeMin: 180, activeMax: 300,
      idleMin: 900, idleMax: 1200,
      idleThreshold: 4,
      sleepStartHour: 2, sleepEndHour: 8,
    };
  }
}

/** 根据模式计算随机间隔（秒→毫秒） */
function getRandomIntervalForMode(mode: 'active' | 'idle', platform?: string): number {
  const cfg = getMonitorConfig(platform);
  const min = mode === 'active' ? cfg.activeMin : cfg.idleMin;
  const max = mode === 'active' ? cfg.activeMax : cfg.idleMax;
  const seconds = Math.floor(Math.random() * (max - min + 1)) + min;
  return seconds * 1000;
}

/** 调度器状态（供前端展示每 (窗口, 平台) 倒计时） */
export interface PlatformSchedulerStatus {
  windowId: string;
  platform: string;
  intervalMs: number;
  lastRunAt: number;
  nextRunAt: number;
  remainingMs: number;
  mode: 'active' | 'idle';
  consecutiveNoUpdates: number;
}

/**
 * 获取所有调度器状态（供前端展示多平台倒计时）
 */
export function getAllSchedulerStatuses(): PlatformSchedulerStatus[] {
  const now = Date.now();
  const results: PlatformSchedulerStatus[] = [];
  for (const [key, st] of schedulerStates.entries()) {
    // key = "windowId_platform"，platform 是最后一节（may contain underscores in windowId）
    const lastUnderscore = key.lastIndexOf('_');
    const windowId = key.substring(0, lastUnderscore);
    const platform = key.substring(lastUnderscore + 1);
    results.push({
      windowId,
      platform,
      intervalMs: st.intervalMs,
      lastRunAt: st.lastRunAt,
      nextRunAt: st.nextRunAt,
      remainingMs: Math.max(0, st.nextRunAt - now),
      mode: st.mode,
      consecutiveNoUpdates: st.consecutiveNoUpdates,
    });
  }
  // 按 nextRunAt 升序排列
  results.sort((a, b) => a.nextRunAt - b.nextRunAt);
  return results;
}

/**
 * 调度一次监控检查 — 只入队指定 (windowId, platform) 的用户
 */
async function runOneSchedule(windowId: string, platform: string): Promise<void> {
  const st = getOrCreateSchedulerState(windowId, platform);
  st.lastRunAt = Date.now();
  try {
    const rules = await prisma.scheduleRule.findMany({ where: { enabled: true } });
    const canRun = rules.length === 0 || evaluateRules(rules);

    if (!canRun) {
      logger.debug({ windowId, platform }, '[调度] 排期规则限制，跳过本轮');
      scheduleNext(windowId, platform);
      return;
    }

    const users = await db.getAllActiveUsers();

    // 只保留匹配该 (windowId, platform) 的用户
    const matched = users.filter(
      (u: any) => u.fingerprintWindowId === windowId && u.platform === platform,
    );

    if (matched.length === 0) {
      logger.debug({ windowId, platform }, '[调度] 无匹配用户，跳过');
      scheduleNext(windowId, platform);
      return;
    }

    // 去重：查询当前队列中是否有真正在执行的同用户任务
    // 关键：BullMQ 的 getJobs(['active']) 会返回 stalled jobs（worker 重启后残留）
    // 通过检查 Redis 中的 BullMQ 任务锁来判断 job 是否真正活跃
    const [activeJobs, waitingJobs] = await Promise.all([
      monitorQueue.getJobs(['active']),
      monitorQueue.getJobs(['waiting']),
    ]);
    const redis = getRedis();
    const activeUserIds = new Set<number>();
    for (const j of [...activeJobs, ...waitingJobs]) {
      const data = j.data as any;
      if (!data?.userId) continue;
      // waiting jobs 一定不是 stalled，直接加入
      if (!await j.isActive()) {
        activeUserIds.add(data.userId);
        continue;
      }
      // active jobs：检查 BullMQ 任务锁是否存在
      // 锁不存在 = worker 已停止续约 = stale job
      const lockKey = `bull:platform:${j.id}:lock`;
      const hasLock = await redis.exists(lockKey);
      if (hasLock) {
        activeUserIds.add(data.userId);
      } else {
        logger.debug({ jobId: j.id, userId: data.userId }, '[调度] 跳过无锁 active job（疑似 stale）');
      }
    }

    // 入队（跳过已有任务的用户）
    let queued = 0;
    for (const u of matched) {
      if (activeUserIds.has(u.id)) {
        logger.debug({ userId: u.id, platform: u.platform }, '[调度] 跳过：已有运行中的任务');
        continue;
      }
      await enqueueMonitor({
        taskId: `mon_${Date.now()}_${u.id}`,
        userId: u.id,
        platform: u.platform as PlatformName,
        windowId: u.fingerprintWindowId,
        fingerprintWindowId: u.fingerprintWindowId,
      });
      queued++;
    }

    if (queued === 0 && activeUserIds.size > 0) {
      // 全部用户已有任务运行中（外部手动触发入队的任务）
      // 设 scheduleAfterCompletion，等任务完成后 reportMonitorComplete 触发下一轮
      st.scheduleAfterCompletion = true;
      logger.info({ windowId, platform }, '[调度] 全部用户已有任务运行中，等待完成');
      return;
    }

    logger.info({ windowId, platform, queued, skipped: activeUserIds.size }, '[调度] 完成任务入队');
    st.pendingTaskCount = queued;
    st.scheduleAfterCompletion = true;
    // 不立即 scheduleNext，等待所有任务完成后 reportMonitorComplete 触发
  } catch (err) {
    logger.error({ windowId, platform, err: (err as Error).message }, '[调度] 异常');
    scheduleNext(windowId, platform);
  }
}

/**
 * 报告一次监控完成（Worker 调用）— 更新该 (windowId, platform) 的空闲/活跃模式
 */
export function reportMonitorComplete(windowId: string, platform: string, hadUpdate: boolean): void {
  const st = getOrCreateSchedulerState(windowId, platform);

  if (hadUpdate) {
    st.mode = 'active';
    st.consecutiveNoUpdates = 0;
  } else {
    st.consecutiveNoUpdates++;
    const cfg = getMonitorConfig();
    if (st.consecutiveNoUpdates >= cfg.idleThreshold && st.mode === 'active') {
      st.mode = 'idle';
      logger.info({ windowId, platform, consecutive: st.consecutiveNoUpdates }, '💤 切换为空闲模式');
    }
  }

  st.pendingTaskCount = Math.max(0, st.pendingTaskCount - 1);
  if (st.pendingTaskCount === 0 && st.scheduleAfterCompletion) {
    st.scheduleAfterCompletion = false;
    scheduleNext(windowId, platform);
  }
}

/**
 * 手动触发后重置倒计时
 * - 如果当前无任务运行中（pendingTaskCount === 0），立即调度下一轮
 * - 如果有任务运行中，设置标志由 reportMonitorComplete 触发下一轮
 */
export function resetSchedulerTimer(windowId: string, platform: string): void {
  const st = getOrCreateSchedulerState(windowId, platform);

  // 清除旧定时器（如果有）
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }

  if (st.pendingTaskCount === 0) {
    // 无任务运行中，立即调度下一轮
    scheduleNext(windowId, platform, 3000); // 3秒后立即执行
    logger.info({ windowId, platform }, '🔄 调度器手动重置，3秒后立即执行');
  } else {
    // 有任务运行中，设置标志由 reportMonitorComplete 触发下一轮
    st.scheduleAfterCompletion = true;
    logger.info({ windowId, platform }, '🔄 调度器手动重置，等待任务完成后重新计时');
  }
}

/** 为该 (windowId, platform) 设置下一次调度定时器 */
function scheduleNext(windowId: string, platform: string, forceInterval?: number): void {
  const st = getOrCreateSchedulerState(windowId, platform);

  // 清除旧定时器
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }

  st.lastRunAt = Date.now();
  const nextInterval = forceInterval ?? getRandomIntervalForMode(st.mode, platform);
  st.intervalMs = nextInterval;
  st.nextRunAt = Date.now() + nextInterval;
  st.timer = setTimeout(() => runOneSchedule(windowId, platform), nextInterval);

  const cfg = getMonitorConfig();
  logger.info({ windowId, platform, seconds: Math.round(nextInterval / 1000), mode: st.mode, noUpdate: st.consecutiveNoUpdates }, '⏰ 下次调度');
}

// ============================================================
// 回复执行
// ============================================================

export async function executeReplyAction(
  task: MonitorTask,
  replyData: { videoId: string; commentCid: string; text: string },
  executionId?: string,
): Promise<void> {
  const bm = getBrowserManager();
  const { page } = await bm.connect(String(task.windowId), '', task.platform);
  if (executionId) await updatePhase(executionId, 1, '准备', 5, '连接浏览器');

  const dy = getDouyinCrawler(task.windowId);
  const ks = getKuaishouCrawler(task.windowId);
  const xhs = getXiaohongshuCrawler(task.windowId);
  const tc = getTencentCrawler(task.windowId);

  // 查找评论的数字 ID 以便更新回复状态
  const { prisma } = await import('../lib/prisma');
  const commentRow = await prisma.comment.findFirst({
    where: { cid: replyData.commentCid },
    select: {
      id: true,
      cid: true,
      text: true,
      createTime: true,
      level: true,
      rootId: true,
      userNickname: true,
      videoId: true,
      video: { select: { description: true, createTime: true } },
    },
  });
  const commentDbId = commentRow?.id;
  const commentText = commentRow?.text || replyData.commentCid;
  const videoDescription = commentRow?.video?.description || '';
  const videoCreateTime = Number(commentRow?.video?.createTime) || 0;
  const commentCreateTime = Number(commentRow?.createTime) || 0;
  const commentLevel = (commentRow?.level as 1 | 2) || 1;
  const commentRootId = commentRow?.rootId || undefined;
  const commentUsername = commentRow?.userNickname || '';
  const commentVideoId = commentRow?.videoId || '';

  // 根评论的子评论数（用于构建 ReplyTarget）
  let rootSubReplyCount: number | undefined;
  let rootCommentText: string | undefined;
  let rootUsername: string | undefined;

  if (commentLevel === 2 && commentRootId) {
    // 查询根评论的 text + userNickname
    const rootRow = await prisma.comment.findFirst({
      where: { cid: commentRootId },
      select: { text: true, userNickname: true },
    });
    rootCommentText = rootRow?.text || undefined;
    rootUsername = rootRow?.userNickname || undefined;

    // 从 VideoRootCommentCount 表读根评论的子评论数
    if (commentVideoId) {
      const rootCountRow = await prisma.videoRootCommentCount.findFirst({
        where: { videoId: commentVideoId, cid: commentRootId },
        select: { replyCount: true },
      });
      rootSubReplyCount = rootCountRow?.replyCount ?? undefined;
    }
  } else if (commentLevel === 1) {
    // 根评论自身：查询其子评论数
    if (commentVideoId && commentRow?.cid) {
      const rootCountRow = await prisma.videoRootCommentCount.findFirst({
        where: { videoId: commentVideoId, cid: commentRow.cid },
        select: { replyCount: true },
      });
      rootSubReplyCount = rootCountRow?.replyCount ?? undefined;
    }
  }

  try {
    // ── 抖音回复：委托给 dy.replyToComment ──
    if (task.platform === 'douyin') {
      const currentUrl = page.url();
      if (!currentUrl.includes('creator.douyin.com')) {
        await dy.navigateToCreatorHome(page);
      }

      // 导航到评论管理页面
      const navSuccess = await dy.navigateToCommentManage(page);
      if (executionId) await updatePhase(executionId, 2, '导航', 20, '已导航到评论管理页');
      if (!navSuccess) {
        logger.error('回复失败：无法导航到评论管理');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('无法导航到评论管理');
      }

      // 等待评论管理页面加载完成（评论列表应该默认显示）
      await HumanActions.wait(page, 3000, 5000);

      // 打开抽屉选择目标视频
      const drawerOpened = await (dy as any).openSelectWorkDrawer(page);
      if (drawerOpened) {
        const videoClicked = await (dy as any).findAndClickVideoInDrawer(page, replyData.videoId, videoDescription);
        if (executionId) await updatePhase(executionId, 3, '定位视频', 35, '已选择目标视频');
        if (!videoClicked) {
          logger.warn({ videoId: replyData.videoId }, '[Reply] 无法在抽屉中点击目标视频');
        }
        // 等待抽屉自动关闭
        await HumanActions.wait(page, 2500, 4000);
        const drawerStillOpen = await (dy as any).isDrawerVisible(page);
        if (drawerStillOpen) {
          logger.info('[Reply] 抽屉仍然打开，手动关闭');
          await (dy as any).closeDrawer(page);
          await HumanActions.wait(page, 1000, 2000);
        }
      } else {
        logger.warn('[Reply] 无法打开选择作品抽屉，尝试在当前页面搜索评论');
      }

      // 等待评论列表加载（最多 20 秒）
      if (executionId) await updatePhase(executionId, 4, '等待评论', 50, '等待评论列表加载');
      let commentListLoaded = false;
      for (let w = 0; w < 10; w++) {
        await HumanActions.wait(page, 1500, 2500);
        const pageInfo = await page.evaluate(function() {
          var el = document.querySelector('.douyin-creator-interactive-tabs-content');
          var bodyLen = (document.body.innerText || '').length;
          var dataCids = document.querySelectorAll('[data-cid]').length;
          var commentTexts = document.querySelectorAll('[class*="comment-content-text"]');
          var commentTextContents = [];
          for (var i = 0; i < Math.min(commentTexts.length, 5); i++) {
            commentTextContents.push((commentTexts[i].innerText || '').slice(0, 50));
          }
          // 检查所有可能包含评论的容器
          var allContainers = document.querySelectorAll('[class*="comment"], [class*="reply"], [class*="item-"]');
          var containerInfo = [];
          for (var j = 0; j < Math.min(allContainers.length, 10); j++) {
            var c = allContainers[j];
            var t = (c.innerText || '').slice(0, 80);
            if (t.length > 2) containerInfo.push({ cls: (c.className || '').toString().slice(0, 40), text: t });
          }
          return {
            hasContainer: !!el,
            scrollDiff: el ? el.scrollHeight - el.clientHeight : 0,
            bodyLen: bodyLen,
            dataCids: dataCids,
            commentTexts: commentTexts.length,
            commentTextContents: commentTextContents,
            containerInfo: containerInfo,
            url: window.location.href,
          };
        });
        logger.info({ pageInfo, attempt: w + 1 }, '[Reply] 页面状态检查');
        if (pageInfo.dataCids > 0 || pageInfo.commentTexts > 0 || pageInfo.bodyLen > 500) {
          commentListLoaded = true;
          logger.info({ waitedMs: (w + 1) * 2000 }, '[Reply] 评论列表已加载');
          break;
        }
      }
      if (!commentListLoaded) {
        logger.warn('[Reply] 评论列表未加载，尝试在当前页面搜索');
      }

      const replyTarget: ReplyTarget = {
        text: commentText,
        level: commentLevel,
        username: commentUsername,
        subReplyCount: commentLevel === 1 ? rootSubReplyCount : undefined,
        rootText: rootCommentText,
        rootUsername: commentLevel === 2 ? rootUsername : undefined,
        rootSubReplyCount: commentLevel === 2 ? rootSubReplyCount : undefined,
        createTime: commentCreateTime,
      };
      if (executionId) await updatePhase(executionId, 5, '执行回复', 80, '正在执行回复操作');
      const replied = await dy.replyToComment(page, replyTarget, replyData.text, executionId);
      if (replied) {
        logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '抖音回复执行成功');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'sent');
        if (executionId) await updatePhase(executionId, 6, '完成', 100, '回复执行完成');
      } else {
        logger.error({ commentCid: replyData.commentCid }, '抖音回复执行失败');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('抖音回复执行失败');
      }
    }

    // ── 快手回复：选择视频 → 导航到评论页 → 委托给 ks.replyToComment ──
    if (task.platform === 'kuaishou') {
      const currentUrl = page.url();
      if (!currentUrl.includes('cp.kuaishou.com')) {
        await ks.navigateToHome(page);
      }

      const navSuccess = await ks.navigateToCommentPageDirect(page);
      if (executionId) await updatePhase(executionId, 2, '导航', 20, '已导航到评论管理页');
      if (!navSuccess) {
        logger.error('回复失败：无法导航到评论管理页面');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('无法导航到快手评论管理页面');
      }

      await HumanActions.wait(page, 1500, 3000);

      // 选择目标视频（评论管理页面默认显示第一个视频的评论，需切换到目标视频）
      if (videoDescription) {
        const videoSwitched = await ks.selectVideoForReply(page, replyData.videoId, videoDescription, videoCreateTime);
        if (executionId) await updatePhase(executionId, 3, '定位视频', 35, '已选择目标视频');
        if (!videoSwitched) {
          logger.warn({ videoDescription }, '快手切换到目标视频失败，将尝试在当前视频下回复');
        }
        await HumanActions.wait(page, 1500, 3000);
      }

      // 构建快手回复目标（借鉴抖音的 ReplyTarget 方案）
      const kuaishouTarget: import('../crawlers/kuaishouCrawler').KuaishouReplyTarget = {
        commentCid: replyData.commentCid,
        text: commentText,
        username: commentUsername,
        level: commentLevel,
        subReplyCount: commentLevel === 1 ? rootSubReplyCount : undefined,
        rootText: rootCommentText,
        rootUsername: commentLevel === 2 ? rootUsername : undefined,
        rootSubReplyCount: commentLevel === 2 ? rootSubReplyCount : undefined,
        createTime: commentCreateTime,
      };
      if (executionId) await updatePhase(executionId, 5, '执行回复', 80, '正在执行回复操作');
      const replied = await ks.replyToComment(page, kuaishouTarget, replyData.text, executionId);
      if (replied) {
        logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '快手回复执行成功');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'sent');
        if (executionId) await updatePhase(executionId, 6, '完成', 100, '回复执行完成');
      } else {
        logger.error({ commentCid: replyData.commentCid }, '快手回复执行失败');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('快手回复执行失败');
      }
    }

    // ── 视频号（Tencent）回复 ──
    if (task.platform === 'tencent') {
      const loggedIn = await tc.handleLogin(page, task.userId);
      if (!loggedIn) {
        logger.error('回复失败：视频号登录失败');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('视频号登录失败');
      }

      const navSuccess = await tc.navigateToCommentManage(page);
      if (executionId) await updatePhase(executionId, 2, '导航', 20, '已导航到评论管理页');
      if (!navSuccess) {
        logger.error('回复失败：无法导航到评论管理');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('无法导航到视频号评论管理');
      }

      await HumanActions.wait(page, 1500, 3000);

      // 查询视频标题用于切换到正确的视频
      let videoTitle = '';
      try {
        const videoRow = await prisma.video.findUnique({
          where: { id: replyData.videoId },
          select: { description: true },
        });
        videoTitle = videoRow?.description || '';
      } catch (e: any) {
        logger.warn({ error: e.message }, '查询视频号视频标题失败，将使用默认视频');
      }

      // 切换到目标视频（通过 wujie shadow DOM 内的视频列表点击）
      if (videoTitle) {
        const videoSwitched = await (tc as any).switchToVideoForReply(page, videoTitle);
        if (executionId) await updatePhase(executionId, 3, '定位视频', 35, '已选择目标视频');
        if (!videoSwitched) {
          logger.warn({ videoTitle }, '视频号切换到目标视频失败，将尝试在当前视频下回复');
        }
        await HumanActions.wait(page, 2000, 3000);
      }

      const tencentTarget: TencentReplyTarget = {
        commentCid: replyData.commentCid,
        text: commentText,
        username: commentUsername,
        level: commentLevel,
        subReplyCount: commentLevel === 1 ? rootSubReplyCount : undefined,
        rootText: rootCommentText,
        rootUsername: commentLevel === 2 ? rootUsername : undefined,
        rootSubReplyCount: commentLevel === 2 ? rootSubReplyCount : undefined,
        createTime: commentCreateTime,
      };
      if (executionId) await updatePhase(executionId, 5, '执行回复', 80, '正在执行回复操作');
      const replied = await tc.replyToComment(page, tencentTarget, replyData.text, executionId);
      if (replied) {
        logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '视频号回复执行成功');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'sent');
        if (executionId) await updatePhase(executionId, 6, '完成', 100, '回复执行完成');
      } else {
        logger.error({ commentCid: replyData.commentCid }, '视频号回复执行失败');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('视频号回复执行失败');
      }

      await tc.executeExitStrategy(page);
      return;
    }

    // ── 小红书回复 ──
    if (task.platform === 'xiaohongshu') {
      const currentUrl = page.url();
      if (!currentUrl.includes('creator.xiaohongshu.com')) {
        await xhs.navigateToCreatorHome(page);
      }

      // 确保在笔记管理页（笔记卡片选择器只在此页生效）
      if (!page.url().includes('note-manager')) {
        await xhs.navigateToNoteManage(page);
      }

      if (executionId) await updatePhase(executionId, 2, '导航', 20, '已定位到笔记管理');

      // 通过点击缩略图进入笔记详情页
      const newPage = await xhs.clickThumbnailAndWaitNewTab(page, replyData.videoId);
      if (!newPage) {
        logger.error('回复失败：无法打开笔记详情页');
        if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
        throw new Error('无法打开小红书笔记详情页');
      }

      try {
        const xhsTarget: import('../crawlers/replyTypes').ReplyTarget = {
          cid: replyData.commentCid,
          text: commentText,
          level: commentLevel,
          username: commentUsername,
          subReplyCount: commentLevel === 1 ? rootSubReplyCount : undefined,
          rootText: rootCommentText,
          rootUsername: commentLevel === 2 ? rootUsername : undefined,
          rootSubReplyCount: commentLevel === 2 ? rootSubReplyCount : undefined,
          createTime: commentCreateTime,
        };

        if (executionId) await updatePhase(executionId, 3, '定位评论', 55, '正在定位评论');
        const replied = await xhs.replyToComment(newPage, xhsTarget, replyData.text, executionId);
        if (replied) {
          logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '小红书回复执行成功');
          if (commentDbId) await db.updateReplyStatus(commentDbId, 'sent');
          if (executionId) await updatePhase(executionId, 4, '完成', 100, '回复执行完成');
        } else {
          logger.error({ commentCid: replyData.commentCid }, '小红书回复执行失败');
          if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
          throw new Error('小红书回复执行失败');
        }
      } finally {
        await newPage.close().catch(() => {});
        await page.bringToFront();
      }

      await xhs.executeExitStrategy(page);
      return;
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '回复执行失败');
    if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
    throw err;
  } finally {
    // 清理 listener 状态（不释放实例，留给后续 Monitor 复用）
    try { dy.unregisterListener?.(); } catch {}
    try { dy.unregisterCommentListener?.(); } catch {}
    try { ks.unregisterListener?.(); } catch {}
    try { ks.unregisterCommentListener?.(); } catch {}

    if (task.platform === 'douyin') {
      try {
        await dy.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
      } catch {}
    }
    if (task.platform === 'kuaishou') {
      try {
        await ks.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
      } catch {}
    }
    if (task.platform === 'xiaohongshu') {
      try {
        await xhs.executeExitStrategy(page, 'menu.note-manage');
      } catch {}
    }
  }
}

/**
 * 重启监控调度器：清除所有现有定时器，重新扫描活跃用户并注册
 * 用于配置变更后或 login_required 状态恢复后重新启动监控
 */
export function restartMonitorScheduler(): void {
  logger.info('[调度器] 正在重启...');
  for (const [key, st] of schedulerStates.entries()) {
    if (st.timer) clearTimeout(st.timer);
  }
  schedulerStates.clear();
  startMonitorScheduler();
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 调度器看门狗：每 30 秒检查所有调度状态
 * 如果某窗口的定时器已过期（remainingMs=0）且无任务运行中，
 * 自动重新调度，防止定时器丢失导致窗口卡死
 */
function startSchedulerWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, st] of schedulerStates.entries()) {
      if (st.pendingTaskCount > 0 || st.scheduleAfterCompletion) continue;
      if (!st.timer) continue;
      // 定时器已过期超过 30 秒，说明 timer 回调丢失
      if (st.nextRunAt > 0 && now > st.nextRunAt + 30_000) {
        // key = "windowId_platform"，platform 是最后一节（may contain underscores in windowId）
        const lastUnderscore = key.lastIndexOf('_');
        const windowId = key.substring(0, lastUnderscore);
        const platform = key.substring(lastUnderscore + 1);
        logger.warn({ windowId, platform, nextRunAt: st.nextRunAt, now, deadSeconds: Math.round((now - st.nextRunAt) / 1000) }, '🐕 调度器看门狗：检测到定时器丢失，自动重新调度');
        scheduleNext(windowId, platform, 5000); // 5 秒后立即重试
      }
    }
  }, 30_000);
}

export function startMonitorScheduler(): void {
  // 启动看门狗
  startSchedulerWatchdog();

  // 扫描所有活跃用户，为每个 (windowId, platform) 创建独立定时器
  db.getAllActiveUsers().then((users: any[]) => {
    const pairs = new Set<string>();
    for (const u of users) {
      const key = stateKey(u.fingerprintWindowId, u.platform);
      if (pairs.has(key)) continue;
      pairs.add(key);

      // 立即创建状态（让 countdown 立即可见）
      const st = getOrCreateSchedulerState(u.fingerprintWindowId, u.platform);
      // 错开启动：每个 pair 随机延迟 5-30 秒后执行首次 runOneSchedule
      const stagger = 5000 + Math.floor(Math.random() * 25000);
      st.intervalMs = stagger;
      st.nextRunAt = Date.now() + stagger;
      st.timer = setTimeout(() => {
        runOneSchedule(u.fingerprintWindowId, u.platform);
      }, stagger);
      logger.info({ windowId: u.fingerprintWindowId, platform: u.platform, stagger }, '⏰ 调度器注册');
    }
    logger.info({ pairs: pairs.size, totalUsers: users.length }, '⏰ 调度器启动完成');
  }).catch((err: Error) => {
    logger.error({ err: err.message }, '调度器启动失败');
  });
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
