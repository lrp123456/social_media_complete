import { Page } from 'patchright';
import { RequestInterceptor, HumanActions, BrowserManager } from '@social-media/browser-core';
import { getSelector } from './menuSelectors';
import { resolveAndClick } from './menuNavigator';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('crawler:tencent');

// ── 类型定义 ──

export type TencentVideoInfo = {
  export_id: string;
  desc: string;
  create_time: number;
  object_stat: {
    play_count: number;
    like_count: number;
    comment_count: number;
    share_count: number;
    recommend_count: number;
  };
  media_type?: number;
  status?: number;
};

export type TencentCommentInfo = {
  comment_id: string;
  content: string;
  nickname: string;
  head_img_url: string;
  create_time: number;
  like_count: number;
  reply_count: number;
  export_id: string;
  is_author: boolean;
  reply_to_nickname?: string;
  level: 1 | 2;
};

export interface CommentQueueItem {
  exportId: string;
  description: string;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;
  _userId: number;
}

export interface CommentProcessResult {
  exportId: string;
  success: boolean;
  comments: TencentCommentInfo[];
  commentGroups?: Array<{
    rootComment: any;
    subReplies: any[];
    newInGroup: any[];
  }>;
  error?: string;
}

export interface CheckResult {
  hasUpdate: boolean;
  commentsQueue: CommentQueueItem[];
  updatedVideos: Array<{
    exportId: string;
    description: string;
    oldCount: number;
    newCount: number;
  }>;
  riskControlDetected: boolean;
  riskControlInfo?: RiskControlDetection;
}

export type RiskControlDetection = {
  detected: boolean;
  type: string;
  evidence: string;
};

// ── 常量 ──

const TENCENT_HOME = 'https://channels.weixin.qq.com/platform';
const TENCENT_LOGIN = 'https://channels.weixin.qq.com/login.html';

const POST_LIST_PATTERN = '/mmfinderassistant-bin/post/post_list';
const COMMENT_LIST_PATTERN = '/mmfinderassistant-bin/comment/get_comment_list';
const COMMENT_REPLY_PATTERN = '/mmfinderassistant-bin/comment/get_reply_list';
const ALL_COMMENT_PATTERNS = [COMMENT_LIST_PATTERN, COMMENT_REPLY_PATTERN];

const RISK_CONTROL_KEYWORDS = ['captcha', '验证', '安全', '限制', '封禁', '操作频繁', 'login'];
const RISK_CONTROL_URLS = ['/login', '/verify', '/captcha'];

const SESSION_HEARTBEAT = 15 * 60 * 1000; // 15分钟

// ── 爬虫主类 ──

export class TencentCrawler {
  private interceptor: RequestInterceptor;
  private listenerPageId: string | null = null;

  constructor(private maxMonitorVideos: number = 20) {
    this.interceptor = new RequestInterceptor();
  }

  // ════════════════════════════════════════
  // Phase 0: 登录与会话管理
  // ════════════════════════════════════════

  /**
   * 检测登录状态，需要时通过企微推送二维码
   * 先访问 /platform，如果被重定向到 /login 则需要扫码
   */
  async handleLogin(page: Page, userId: number): Promise<boolean> {
    logger.info('[Login] Checking login status');

    // 先尝试访问 platform
    await page.goto(TENCENT_HOME, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 3000);

    // 已登录，无需扫码
    const url = page.url();
    if (url.includes('/platform') && !url.includes('/login')) {
      logger.info('[Login] Session still valid, skip login');
      return true;
    }

    // 被重定向到登录页，需要扫码
    logger.info('[Login] Session expired, need QR scan');

    // 动态导入 botManager（避免循环依赖）
    const { botManager } = await import('../services/wechatBotService');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { wechatUserid: true } });
    if (user?.wechatUserid) {
      await this.captureAndSendQR(page, userId, 'tencent', user.wechatUserid, botManager);
    }

    // 轮询等待扫码（最长120秒）
    const maxWait = 120_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const currentUrl = page.url();
      if (currentUrl.includes('/platform') && !currentUrl.includes('/login')) {
        logger.info('[Login] Login successful');
        return true;
      }

      const bodyText = await HumanActions.cdpGetBodyText(page);
      if (bodyText.includes('已过期')) {
        logger.info('[Login] QR code expired, refreshing');
        await HumanActions.cdpClick(page, '.qrcode-refresh-btn', { timeout: 5000 });
        await HumanActions.wait(page, 2000, 3000);
        if (user?.wechatUserid) {
          await this.captureAndSendQR(page, userId, 'tencent', user.wechatUserid, botManager);
        }
      }

      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('[Login] Login timeout after 120s');
    return false;
  }

  /**
   * 会话保活 — 定期访问首页维持 Cookie
   */
  async keepSessionAlive(page: Page): Promise<void> {
    await page.goto(TENCENT_HOME, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 3000);

    if (page.url().includes('/login')) {
      throw new Error('SESSION_EXPIRED');
    }
  }

  /**
   * 截取二维码并通过企微发送
   */
  private async captureAndSendQR(
    page: Page,
    userId: number,
    platform: string,
    wechatUserid: string,
    botManager: any,
  ): Promise<void> {
    try {
      const selectors = [
        'iframe[src*="login-for-iframe"]',
        'img[src*="qrcode"]',
        'img[src*="qr"]',
        'canvas',
        '[class*="qrcode"] img',
      ];

      let buf: Buffer | undefined;
      const PADDING = 40;

      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.waitForElementState('visible', { timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(500);
            const box = await el.boundingBox();
            if (box && box.width > 50 && box.height > 50) {
              const clip = {
                x: Math.max(0, box.x - PADDING),
                y: Math.max(0, box.y - PADDING),
                width: box.width + PADDING * 2,
                height: box.height + PADDING * 2,
              };
              buf = await page.screenshot({ type: 'png', clip });
              logger.info({ selector: sel, width: clip.width, height: clip.height }, '[Login] QR screenshot captured');
              break;
            }
          }
        } catch {}
      }

      if (!buf) {
        buf = await page.screenshot({ type: 'png' });
        logger.info('[Login] Fallback: full page screenshot');
      }

      await botManager.sendLoginAlert(wechatUserid, platform, userId, buf).catch(() => {});
    } catch (err) {
      await botManager.sendLoginAlert(wechatUserid, platform, userId).catch(() => {});
    }
  }

  // ════════════════════════════════════════
  // 风控检测
  // ════════════════════════════════════════

  async detectRiskControl(page: Page): Promise<RiskControlDetection> {
    try {
      const url = page.url();
      for (const riskUrl of RISK_CONTROL_URLS) {
        if (url.includes(riskUrl) && !url.includes('/platform')) {
          return { detected: true, type: 'url_redirect', evidence: `Redirected: ${url}` };
        }
      }

      const bodyText = await HumanActions.cdpGetBodyText(page);
      for (const keyword of RISK_CONTROL_KEYWORDS) {
        if (bodyText.includes(keyword)) {
          return { detected: true, type: 'risk_keyword', evidence: `Found: "${keyword}"` };
        }
      }

      return { detected: false, type: '', evidence: '' };
    } catch {
      return { detected: false, type: '', evidence: '' };
    }
  }

  // ════════════════════════════════════════
  // API 拦截器管理
  // ════════════════════════════════════════

  async registerListener(page: Page, patterns: string[]): Promise<void> {
    this.interceptor.clearAll();
    for (const pattern of patterns) {
      this.interceptor.setValidationConfig(pattern, {
        expectedPageUrls: ['channels.weixin.qq.com'],
        requiredItemFields: pattern === POST_LIST_PATTERN ? ['export_id'] : ['comment_id'],
        minItems: pattern === POST_LIST_PATTERN ? 1 : 0,
      });
    }
    this.listenerPageId = await this.interceptor.register(page, patterns);
    logger.info({ patterns }, '[Tencent] Listener registered');
  }

  unregisterListener(): void {
    if (this.listenerPageId) {
      this.interceptor.unregister(this.listenerPageId);
      this.listenerPageId = null;
    }
    this.interceptor.clearAll();
  }

  // ════════════════════════════════════════
  // Phase 1: 视频列表发现（占位，任务 5 实现）
  // ════════════════════════════════════════

  async navigateToVideoList(page: Page): Promise<void> {
    // 任务 5 实现
  }

  async checkForUpdates(page: Page, userId: number): Promise<CheckResult> {
    // 任务 5 实现
    return { hasUpdate: false, commentsQueue: [], updatedVideos: [], riskControlDetected: false };
  }

  // ════════════════════════════════════════
  // Phase 2: 评论管理导航（占位，任务 6 实现）
  // ════════════════════════════════════════

  async navigateToCommentManage(page: Page): Promise<boolean> {
    // 任务 6 实现
    return false;
  }

  // ════════════════════════════════════════
  // Phase 3: 评论采集（占位，任务 7 实现）
  // ════════════════════════════════════════

  async processCommentsQueue(
    page: Page,
    queue: CommentQueueItem[],
    userId: number,
  ): Promise<CommentProcessResult[]> {
    // 任务 7 实现
    return [];
  }

  // ════════════════════════════════════════
  // 退出策略
  // ════════════════════════════════════════

  async executeExitStrategy(page: Page): Promise<void> {
    try {
      // 随机选择退出行为
      const actions = ['navigate_submenu', 'idle_wander', 'refresh'];
      const action = actions[Math.floor(Math.random() * actions.length)];

      if (action === 'navigate_submenu') {
        const submenuKeys = ['menu.data-center.video', 'menu.content.image', 'menu.live'];
        const key = submenuKeys[Math.floor(Math.random() * submenuKeys.length)];
        const clicked = await resolveAndClick(page, key, 'tencent', { timeout: 8000 });
        if (clicked) {
          await HumanActions.wait(page, 2000, 3000);
          return;
        }
      }

      if (action === 'idle_wander') {
        await HumanActions.randomBlankClick(page);
        await HumanActions.humanScroll(page, 100 + Math.random() * 200, { minPause: 200, maxPause: 600 });
        await HumanActions.wait(page, 1000, 2000);
        return;
      }

      // fallback: CDP refresh
      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);
      await HumanActions.wait(page, 2000, 3000);
    } catch (err: any) {
      logger.warn({ error: err.message }, '[Exit] Exit strategy failed');
    }
  }
}
