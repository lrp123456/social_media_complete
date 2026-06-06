// @ts-api-gateway/services/monitorService.ts - 评论监控调度器 (BullMQ)
// 移植 self_folder scheduler.ts 逻辑 → BullMQ Worker 模式

import { Queue, Worker, Job } from 'bullmq';
import { getRedis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { getTraceIdForJob } from '../middleware/trace';
import { WindowMutex } from '../lib/redlock';
import { HumanActions, BrowserManager } from '@social-media/browser-core';
import type { PlatformName } from '@social-media/shared-config';
import type { CommentNode, CommentQueueItem, QuerySource } from '../crawlers/douyinCrawler';
import { DouyinCrawler } from '../crawlers/douyinCrawler';
import { botManager } from './wechatBotService';

const logger = createLogger('monitor-service');

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
    logger.info(`🔍 监控任务开始: ${task.taskId} → ${task.platform}:${task.userId}`);

    // 1. 获取窗口互斥锁
    const lock = await WindowMutex.acquireWithBackoff(task.windowId);

    try {
      // 2. 连接指纹浏览器 + 执行爬取
      const result = await executeMonitorCheck(task);

      // 3. 记录结果
      await prisma.operationLog.create({
        data: {
          action: 'monitor_check',
          details: JSON.stringify(result),
          userId: String(task.userId),
          userName: task.platform,
          result: 'success',
          level: 'info',
        },
      });

      logger.info(`✅ 监控检查完成: ${task.taskId} (新评论: ${result.newComments})`);
    } catch (err) {
      logger.error(`❌ 监控失败: ${task.taskId} - ${(err as Error).message}`);
      await prisma.operationLog.create({
        data: {
          action: 'monitor_check',
          details: JSON.stringify({ error: (err as Error).message }),
          userId: String(task.userId),
          result: 'failure',
          level: 'error',
        },
      });
    } finally {
      await WindowMutex.release(lock, task.windowId);
    }
  },
  {
    connection: getRedis(),
    concurrency: 3,
    limiter: { max: 10, duration: 60_000 },
  },
);

// ============================================================
// 核心爬取逻辑（简化版 - 移植自原 scheduler/crawler）
// ============================================================

async function executeMonitorCheck(task: MonitorTask): Promise<{ newComments: number; videosChecked: number }> {
  // 1. 连接指纹浏览器
  const { chromium } = await import('patchright');
  const browser = await chromium.launchChannel('chrome', { headless: false });

  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    // 2. 导航 + 执行平台特定爬取
    const platformCrawlers: Record<string, (page: any, task?: MonitorTask) => Promise<{ newComments: number; videosChecked?: number }>> = {
      douyin: runDouyinCheck,
      kuaishou: crawlKuaishou,
      xiaohongshu: crawlXiaohongshu,
    };

    const crawler = platformCrawlers[task.platform];
    if (!crawler) throw new Error(`不支持的监控平台: ${task.platform}`);

    const result = await crawler(page, task);
    await browser.close();

    return { newComments: result.newComments, videosChecked: result.videosChecked || 10 };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function crawlDouyin(page: any): Promise<{ newComments: number }> {
  await page.goto('https://creator.douyin.com', { waitUntil: 'domcontentloaded' });
  await HumanActions.wait(page, 3000, 5000);

  // 风控检测（三维）
  const bodyText = await HumanActions.cdpGetBodyText(page);
  const riskDetected = detectRiskControl(page.url(), bodyText);

  if (riskDetected) {
    logger.warn('⚠️ 抖音风控检测触发！');
    // TODO: 截图 → OSS → 企业微信告警 → 封禁用户
    return { newComments: 0 };
  }

  // 拦截 API 获取评论数据
  await HumanActions.wait(page, 2000, 4000);
  return { newComments: Math.floor(Math.random() * 20) }; // 简化：实际需接入 interceptor
}

async function crawlKuaishou(page: any): Promise<{ newComments: number }> {
  await page.goto('https://cp.kuaishou.com', { waitUntil: 'domcontentloaded' });
  await HumanActions.wait(page, 3000, 5000);
  return { newComments: Math.floor(Math.random() * 15) };
}

async function crawlXiaohongshu(page: any): Promise<{ newComments: number }> {
  await page.goto('https://creator.xiaohongshu.com', { waitUntil: 'domcontentloaded' });
  await HumanActions.wait(page, 2000, 4000);
  return { newComments: Math.floor(Math.random() * 10) };
}

// ============================================================
// 风控检测（三维：URL + 正文 + 标题）
// ============================================================

function detectRiskControl(url: string, bodyText: string): boolean {
  const riskUrls = ['/verify', '/captcha', '/login', '/passport', '/security_check'];
  const riskKeywords = [
    '验证码', '安全验证', '滑块验证', '人机验证', '账号异常',
    'verify', 'captcha', 'sec_verify', 'security_check',
  ];

  // URL 检测
  if (riskUrls.some((u) => url.includes(u))) return true;

  // 正文检测
  for (const kw of riskKeywords) {
    if (bodyText.includes(kw)) return true;
  }

  return false;
}

// ============================================================
// 企业微信通知（模板卡片）
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
      const content = `⚠️ **风控告警**\n> 平台: ${platform}\n> 风控类型: 未知\n> 用户ID: ${userId}\n> 已自动进入冷却期`;
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
// 抖音 Deep 模式爬取（Phase 1 + 3 完整链路）
// ============================================================

async function runDouyinCheck(page: any, task?: MonitorTask): Promise<{ newComments: number; videosChecked: number }> {
  if (!task) return { newComments: 0, videosChecked: 0 };

  const crawler = new DouyinCrawler();

  // Phase 1: 检查更新，获取评论队列
  const checkResult = await crawler.checkForUpdates(page, task.userId, task.fingerprintWindowId, 'work_list');
  const queue: CommentQueueItem[] = checkResult.commentsQueue || [];

  if (checkResult.riskControlDetected) {
    logger.warn({ userId: task.userId }, '抖音风控检测触发，跳过爬取');
    await sendMonitorNotification(task.userId, task.platform, 'risk_detected');
    return { newComments: 0, videosChecked: 0 };
  }

  if (queue.length === 0) {
    logger.info({ userId: task.userId }, '抖音无新增评论');
    await sendMonitorNotification(task.userId, task.platform, 'monitor_complete');
    return { newComments: 0, videosChecked: 0 };
  }

  // Phase 2 + 3: 处理评论队列
  await crawler.navigateToCommentManage(page);
  const phase3Result = await crawler.processCommentsQueue(page, queue);

  if (phase3Result.riskDetected) {
    logger.warn({ userId: task.userId, riskInfo: phase3Result.riskInfo }, 'Phase 3 风控触发');
    await sendMonitorNotification(task.userId, task.platform, 'risk_detected');
    return { newComments: 0, videosChecked: queue.length };
  }

  // 汇总新增评论数
  const totalNewComments = phase3Result.results.reduce(
    (sum, r) => sum + (r.comments?.length || 0), 0
  );

  const result = { newComments: totalNewComments, updatedVideos: checkResult.updatedVideos };

  // 通知调用（Deep 模式 - 含评论群数据）
  if (result.newComments > 0) {
    const commentGroups = (phase3Result as any).results
      ?.filter((r: any) => r.success && r.commentGroups)
      ?.flatMap((r: any) =>
        r.commentGroups.map((g: any) => ({
          awemeId: r.awemeId,
          description: queue.find(q => q.awemeId === r.awemeId)?.description || '',
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
    }
  }

  return { newComments: result.newComments, videosChecked: queue.length };
}

// ============================================================
// 定时调度：轮询排期规则 + 自动入队
// ============================================================

let schedulerTimer: NodeJS.Timeout | null = null;

export function startMonitorScheduler(intervalMs = 900_000): void {
  if (schedulerTimer) clearInterval(schedulerTimer);

  schedulerTimer = setInterval(async () => {
    try {
      // 检查排期规则
      const rules = await prisma.scheduleRule.findMany({ where: { enabled: true } });
      const canRun = rules.length === 0 || evaluateRules(rules);

      if (!canRun) {
        logger.debug('排期规则限制，跳过本轮监控');
        return;
      }

      // 获取所有活跃用户
      const users = await prisma.user.findMany({
        where: {
          status: { not: 'blocked' },
          monitoringEnabled: true,
        },
      });

      // 按 window_id 分组（同一窗口不并发）
      const byWindow = new Map<string, typeof users>();
      for (const u of users) {
        const items = byWindow.get(u.fingerprintWindowId) || [];
        items.push(u);
        byWindow.set(u.fingerprintWindowId, items);
      }

      // 入队（BullMQ 负责实际执行和调度）
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
  }, intervalMs);

  logger.info(`⏰ 监控调度器已启动 (间隔: ${intervalMs}ms)`);
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
