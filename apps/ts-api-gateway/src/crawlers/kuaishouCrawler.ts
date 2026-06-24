import { Page } from 'patchright';
import { RequestInterceptor } from '@social-media/browser-core';
import { HumanActions } from '@social-media/browser-core';
import { ExitStrategy, PageType } from '@social-media/browser-core';
import { getSelector, getRandomExitSubmenuKey, getSubmenuKeyForPageType } from './menuSelectors';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { BrowserManager } from '@social-media/browser-core';
import { createLogger } from '../lib/logger';
import { resolveAndClick, tryClickBySelector } from './menuNavigator';
import { isDebugModeEnabled, createReplySessionId, createManifest, saveDebugSnapshot, finishManifest, DebugManifest } from '../lib/replyDebugLogger';
import { recordSelectorTry } from '../lib/taskExecutionRecorder';
import type { ReplyTarget } from './replyTypes';
import { parseDomTimestamp, isTimestampMatch, isDescriptionMatch } from './timeParser';
import fs from 'fs';
import path from 'path';

const logger = createLogger('crawler:kuaishou');

// ============================================================
// Local type definitions (ported from ../types + interceptor)
// ============================================================

export interface VideoInfo {
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: Record<string, number>;
  authorUid?: string;       // 快手 userId
  authorNickname?: string;  // 快手 userName
  isPinned?: boolean;       // 置顶视频标记（photoTop）
}

export interface CommentInfo {
  cid: string;
  text: string;
  user_nickname: string;
  user_uid: string;
  digg_count: number;
  create_time: number;
  reply_id: string;
}

export interface RootCommentSnapshot {
  cid: string;
  text: string;
  replyCount: number;
  createTime: number;
  userUid: string;
  userNickname: string;
}

export interface RiskControlDetection {
  detected: boolean;
  type: 'captcha' | 'login_redirect' | 'security_verify' | 'unknown';
  evidence: string;
}

export interface InterceptedResponse {
  url: string;
  status: number;
  body: any;
  timestamp: number;
  hasMore?: boolean;
  cursor?: string;
}

// ============================================================
// Constants
// ============================================================

const KUAISHOU_HOME = 'https://www.kuaishou.com';
const CREATOR_HOME = 'https://cp.kuaishou.com/article/publish/video';

const VIDEO_LIST_PATTERN = '/rest/cp/works/v2/video/pc/photo/list';
const PHOTO_ANALYSIS_PATTERN = '/rest/cp/creator/analysis/pc/photo/list';
const COMMENT_LIST_PATTERN = '/rest/cp/creator/comment/commentList';
const COMMENT_REPLY_PATTERN = '/rest/cp/creator/comment/subCommentList';
const COMMENT_HOME_PATTERN = '/rest/cp/creator/comment/home';
const ALL_KUAISHOU_COMMENT_PATTERNS = [COMMENT_LIST_PATTERN, COMMENT_REPLY_PATTERN, COMMENT_HOME_PATTERN];

const MAX_SCROLL_ATTEMPTS = 30;
const MAX_SCROLL_NO_NEW_DATA = 10;

const RISK_CONTROL_KEYWORDS = ['captcha', 'login', '安全验证', '验证码', '账号异常', 'risk', 'verify'];
const RISK_CONTROL_URLS = ['/login', '/passport', '/verify', '/captcha'];

// 快手抽屉XPath选择器（用于精确定位抽屉内视频元素）
const DRAWER_VIDEO_ITEM_XPATH = '/html/body/div/div[1]/div[1]/main/div/div/div[1]/div[3]/div/div/div[1]/div/div[2]';
const DRAWER_VIDEO_TITLE_XPATH = '/html/body/div/div[1]/div[1]/main/div/div/div[1]/div[3]/div/div/div[1]/div/div[2]/div[1]';
const DRAWER_SCROLL_CONTAINER_XPATH = '/html/body/div/div[1]/div[1]/main/div/div/div[1]/div[3]/div';

const PLATFORM: 'kuaishou' = 'kuaishou';

// ============================================================
// Exported interfaces
// ============================================================

export interface KuaishouCommentQueueItem {
  awemeId: string;
  description: string;
  createTime: number;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;
  _userId: number;
  isPinned?: boolean;       // 置顶视频标记
}

export interface KuaishouCommentProcessResult {
  awemeId: string;
  success: boolean;
  comments: CommentInfo[];
  error?: string;
}

export interface KuaishouCheckResult {
  hasUpdate: boolean;
  commentsQueue: KuaishouCommentQueueItem[];
  updatedVideos: Array<{
    awemeId: string;
    description: string;
    oldCount: number;
    newCount: number;
    newComments: CommentInfo[];
  }>;
  riskControlDetected: boolean;
  riskControlInfo?: RiskControlDetection;
}

export type KuaishouQuerySource = 'work_list' | 'photo_analysis';

// ============================================================
// Reply target interface (similar to douyin's ReplyTarget)
// ============================================================

// 快手回复目标 — 扩展共享 ReplyTarget，增加快手特有的 commentCid 字段
export interface KuaishouReplyTarget extends ReplyTarget {
  commentCid: string;
}

// ============================================================
// Main crawler class
// ============================================================

export class KuaishouCrawler {
  private interceptor: RequestInterceptor;
  private listenerPageId: string | null = null;
  private commentListenerPageId: string | null = null;
  private currentMenuSection: 'content' | 'data_center' | 'interact' | 'unknown' = 'unknown';
  private page?: Page;
  private awemeIdToPhotoStatus: Map<string, number> = new Map();

  constructor(private maxMonitorVideos: number = 20) {
    this.interceptor = new RequestInterceptor();
  }

  // ════════════════════════════════════════
  // 登录管理
  // ════════════════════════════════════════

  async checkLoginStatus(page: Page): Promise<boolean> {
    try {
      const url = page.url().toLowerCase();
      if (url.includes('/login') || url.includes('/passport') || url.includes('/verify')) {
        logger.info({ url }, '[Login] Detected login page redirect');
        return false;
      }

      const bodyText = await HumanActions.cdpGetBodyText(page);
      const loginKeywords = ['登录', '扫码', '二维码', '请使用快手', '账号登录'];
      for (const keyword of loginKeywords) {
        if (bodyText.includes(keyword)) {
          const hasLoginForm = await HumanActions.cdpIsElementVisible(
            page,
            '.login-qrcode, .qrcode-img, [class*="login"], [class*="qrcode"], .app-download'
          );
          if (hasLoginForm) {
            logger.info({ keyword }, '[Login] Detected login form on page');
            return false;
          }
        }
      }

      if (url.includes('cp.kuaishou.com')) {
        const hasSidebar = await HumanActions.cdpIsElementVisible(
          page,
          '.el-menu, .sidebar, [class*="sidebar"], [class*="menu"]'
        );
        if (hasSidebar) return true;
      }

      return true;
    } catch (error: any) {
      logger.warn({ error: error.message }, '[Login] Error checking login status');
      return true;
    }
  }

  async handleLogin(
    page: Page,
    userId: number,
    onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void,
  ): Promise<boolean> {
    logger.info({ userId }, '[Login] Starting login handling');

    const isLoggedIn = await this.checkLoginStatus(page);
    if (isLoggedIn) {
      logger.info('[Login] Already logged in');
      return true;
    }

    logger.info('[Login] Login required, navigating to login page');
    onProgress?.({ phase: '登录', step: '导航到登录页', percent: 6, detail: '正在打开快手登录页面' });

    const KS_LOGIN_URL = 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api';
    await page.goto(KS_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 2000, 3000);

    const switchBtn = page.locator('div.platform-switch');
    if (await switchBtn.count() > 0) {
      await switchBtn.click();
      await HumanActions.wait(page, 2000, 3000);
      logger.info('[Login] Clicked platform switch button');
    }

    const { botManager } = await import('../services/wechatBotService');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { wechatUserid: true, fingerprintWindowId: true } });
    if (!user?.wechatUserid) {
      logger.error({ userId }, '[Login] No WeChat Work user ID found');
      return false;
    }

    // 使用主页面直接截取 QR（captureQR 支持 iframe）
    const { loginTabRegistry, getLoginFlowConfig } = await import('../services/loginFlowHelpers');
    const ksConfig = getLoginFlowConfig('kuaishou', 'creator');
    let qrSent = false;
    if (ksConfig) {
      const qrBuf = await loginTabRegistry.captureQR(page, ksConfig);
      if (qrBuf) {
        await botManager.sendLoginAlert(user.wechatUserid, 'kuaishou', userId, qrBuf);
        qrSent = true;
      }
    }
    if (!qrSent) {
      await this.captureAndSendQR(page, userId, 'kuaishou', user.wechatUserid, botManager);
    }
    onProgress?.({ phase: '登录', step: '等待扫码', percent: 8, detail: '已发送二维码到企业微信，请扫码登录' });

    const maxWait = 300_000;
    const start = Date.now();
    let qrRefreshCount = 0;
    const maxQrRefreshes = 3;

    while (Date.now() - start < maxWait) {
      await HumanActions.wait(page, 3000, 4000);

      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = Math.floor((maxWait - (Date.now() - start)) / 1000);
      onProgress?.({ phase: '登录', step: '等待扫码', percent: 8, detail: `已等待 ${elapsed}秒，剩余 ${remaining}秒` });

      const currentUrl = page.url();
      if (!currentUrl.startsWith('https://passport.kuaishou.com')) {
        logger.info({ waitMs: Date.now() - start, url: currentUrl }, '[Login] Login successful');
        onProgress?.({ phase: '登录', step: '登录成功', percent: 10, detail: '扫码登录成功' });
        return true;
      }

      const bodyText = await HumanActions.cdpGetBodyText(page);
      if ((bodyText.includes('已过期') || bodyText.includes('刷新')) && qrRefreshCount < maxQrRefreshes) {
        logger.info('[Login] QR code expired, refreshing');
        qrRefreshCount++;
        const refreshBtn = page.locator('.refresh-btn, [class*="refresh"], button:has-text("刷新")');
        if (await refreshBtn.count() > 0) {
          await refreshBtn.first.click().catch(() => {});
          await HumanActions.wait(page, 1000, 2000);
        }
        if (qrRefreshCount <= maxQrRefreshes && ksConfig) {
          const ksQrBuf2 = await loginTabRegistry.captureQR(page, ksConfig);
          if (ksQrBuf2) {
            await botManager.sendLoginAlert(user.wechatUserid, 'kuaishou', userId, ksQrBuf2);
          }
        } else {
          await this.captureAndSendQR(page, userId, 'kuaishou', user.wechatUserid, botManager);
        }
        onProgress?.({ phase: '登录', step: '二维码已刷新', percent: 8, detail: `二维码已过期，已重新发送（${qrRefreshCount}/${maxQrRefreshes}）` });
      }
    }

    logger.error({ waitMs: Date.now() - start }, '[Login] Login timeout');
    onProgress?.({ phase: '登录', step: '登录超时', percent: 0, detail: '等待扫码超时（5分钟）' });
    return false;
  }

  private async captureAndSendQR(
    page: Page,
    userId: number,
    platform: string,
    wechatUserid: string,
    botManager: any,
  ): Promise<void> {
    try {
      const selectors = [
        'img[alt="qrcode"]',
        'img[src*="data:image/"]',
        'img[src*="qrcode"]',
        'canvas',
        '.login-qrcode img',
        '[class*="qrcode"] img',
      ];

      let buf: Buffer | undefined;
      const PADDING = 20;

      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.waitForElementState('visible', { timeout: 5000 }).catch(() => {});
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

      await botManager.sendLoginAlert(wechatUserid, platform, userId, buf).catch((err: any) => {
        logger.warn({ error: err.message }, '[Login] Failed to send QR via bot');
        return botManager.sendTextMessage([wechatUserid], `⚠️ ${platform} 登录已失效，请扫码重新登录`);
      });
    } catch (err: any) {
      logger.error({ error: err.message }, '[Login] Failed to capture and send QR');
      await botManager.sendTextMessage([wechatUserid], `⚠️ ${platform} 登录已失效，请重新登录`).catch(() => {});
    }
  }

  private async scrollElementToViewport(page: Page, selector: string): Promise<void> {
    if (!selector || /[\u4e00-\u9fa5]/.test(selector)) {
      return;
    }

    try {
      const elements = await HumanActions.queryElementsWithInfo(page, selector);
      if (elements && elements.length > 0) {
        const visibleEl = elements.find(el => el.visible);
        if (visibleEl) {
          await HumanActions.cdpScrollNodeIntoView(page, visibleEl.nodeId);
          await HumanActions.wait(page, 300, 500);
          return;
        }
        if (elements[0]) {
          await HumanActions.cdpScrollNodeIntoView(page, elements[0].nodeId);
          await HumanActions.wait(page, 300, 500);
        }
      }
    } catch {}
  }

  private xpathToCss(xpath: string): string | null {
    try {
      let parts: string[];
      let prefix = '';

      if (xpath.startsWith('/html/body/')) {
        parts = xpath.replace('/html/body/', '').split('/');
        prefix = 'body > ';
      } else if (xpath.startsWith('//*[@id="')) {
        const idMatch = xpath.match(/^\/\/\*\[@id="([^"]+)"\]\/(.+)$/);
        if (!idMatch) return null;
        const rootId = idMatch[1];
        parts = idMatch[2].split('/');
        prefix = `#${rootId} > `;
      } else {
        return null;
      }

      const cssParts: string[] = [];

      for (const part of parts) {
        if (!part) continue;
        const tagMatch = part.match(/^([a-zA-Z]+)(?:\[(\d+)\])?$/);
        if (!tagMatch) return null;

        const tag = tagMatch[1].toLowerCase();
        const index = tagMatch[2] ? parseInt(tagMatch[2]) : null;

        if (index !== null && index > 1) {
          cssParts.push(`${tag}:nth-child(${index})`);
        } else {
          cssParts.push(tag);
        }
      }

      return prefix + cssParts.join(' > ');
    } catch {
      return null;
    }
  }

  async warmUp(page: Page): Promise<void> {
    logger.info('Starting warm-up route - navigating to kuaishou.com homepage first');

    try {
      await page.goto(KUAISHOU_HOME, { waitUntil: 'domcontentloaded' });
      await HumanActions.wait(page, 3000, 5000);

      const scrollCount = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < scrollCount; i++) {
        await HumanActions.humanScroll(page, 200 + Math.random() * 300, {
          minPause: 500,
          maxPause: 1500,
        });
        await HumanActions.wait(page, 3000, 6000);
      }

      if (Math.random() < 0.4) {
        await HumanActions.randomBlankClick(page);
        await HumanActions.wait(page, 1000, 2000);
      }

      logger.info('Kuaishou warm-up completed');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Kuaishou warm-up failed, proceeding anyway');
    }
  }

  async navigateToHome(page: Page): Promise<void> {
    const currentUrl = page.url();

    if (currentUrl.includes('cp.kuaishou.com')) {
      logger.info({ currentUrl }, 'Already on kuaishou creator page, skipping navigation');
    } else {
      logger.info('Navigating to kuaishou creator home via click-based menu');
      // 尝试点击"创作者中心"链接（防风控）, 失败时回退到 goto
      const clicked = await resolveAndClick(page, 'nav.to-creator', 'kuaishou', { timeout: 10000 });
      if (clicked) {
        await HumanActions.wait(page, 2000, 4000);
        await HumanActions.pageLoadBehavior(page);
      } else {
        logger.warn('Click-based nav to kuaishou creator failed, falling back to page.goto');
        await page.goto(CREATOR_HOME, { waitUntil: 'domcontentloaded' });
        HumanActions.clearCDPContext(page);
        await HumanActions.wait(page, 2000, 4000);
        await HumanActions.pageLoadBehavior(page);
      }
    }

    this.currentMenuSection = 'unknown';
    // TODO: logPageHtml for kuaishou
    // await BrowserManager.logPageHtml(page, 'after_navigateToHome_kuaishou');
    logger.info({ currentUrl: page.url() }, 'Ready on kuaishou creator page');
  }

  async registerListener(page: Page, patterns: string[]): Promise<void> {
    this.interceptor.clearAll();

    for (const pattern of patterns) {
      this.interceptor.setValidationConfig(pattern, {
        expectedPageUrls: ['cp.kuaishou.com'],
        requiredItemFields: [],
        minItems: 1,
      });
    }

    this.listenerPageId = await this.interceptor.register(page, patterns);
    logger.info({ patterns, rejectionCount: this.interceptor.getRejectionLog().length }, 'Kuaishou listener registered with validation configs');
  }

  unregisterListener(): void {
    if (this.listenerPageId) {
      const rejectionLog = this.interceptor.getRejectionLog();
      if (rejectionLog.length > 0) {
        logger.warn({ rejectionCount: rejectionLog.length, latestRejections: rejectionLog.slice(-5) }, 'Kuaishou rejection log summary');
      }
      this.interceptor.unregister(this.listenerPageId);
      this.listenerPageId = null;
    }
    this.interceptor.clearAll();
  }

  /**
   * 注册评论 API 拦截器（Phase2 调用，在导航到评论管理页面之前）
   */
  async registerCommentListener(page: Page): Promise<void> {
    this.unregisterCommentListener();
    for (const p of ALL_KUAISHOU_COMMENT_PATTERNS) {
      this.interceptor.clear(p);
    }
    this.commentListenerPageId = await this.interceptor.register(page, ALL_KUAISHOU_COMMENT_PATTERNS);
    logger.info({ commentListenerPageId: this.commentListenerPageId }, 'Kuaishou comment API listener pre-registered (Phase2)');
  }

  unregisterCommentListener(): void {
    if (this.commentListenerPageId) {
      this.interceptor.unregister(this.commentListenerPageId);
      this.commentListenerPageId = null;
      logger.info('Kuaishou comment API listener unregistered');
    }
  }

  async fetchVideoListFromSource(page: Page, source: KuaishouQuerySource): Promise<VideoInfo[]> {
    const pattern = source === 'work_list' ? VIDEO_LIST_PATTERN : PHOTO_ANALYSIS_PATTERN;

    this.interceptor.clear(pattern);
    logger.info({ source, step: 'CLEAR_INITIAL' }, 'Cleared interceptor for fresh start');

    const onTarget = this.isOnTargetPage(page, source);
    logger.info({ source, onTarget, url: page.url() }, 'Target page detection');

    if (onTarget) {
      logger.info({ source, url: page.url() }, 'Already on target page — forcing F5 refresh to ensure fresh data');
      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 4000);
      await HumanActions.pageLoadBehavior(page);
    } else {
      if (source === 'work_list') {
        await this.navigateToWorkManage(page);
      } else {
        await this.navigateToPhotoAnalysis(page);
      }
    }

    logger.info({ source, step: 'AFTER_NAVIGATE', existingResponses: this.interceptor.getResponseCount(pattern) }, 'Navigation complete, waiting for target response');

    // 导航后检测前端错误弹窗（快手 API 超时会弹出 "出错了" 对话框，阻塞页面）
    if (await this.dismissErrorDialog(page)) {
      logger.info({ source }, '导航后检测到错误弹窗并已刷新清除，重新等待响应');
    }

    let initialResponse = await this.interceptor.waitForResponse(pattern, 25000);

    if (!initialResponse) {
      // 优先检测前端错误弹窗 — 若存在则刷新清除（用户要求刷新解决而非跳过）
      const dialogHandled = await this.dismissErrorDialog(page);
      if (dialogHandled) {
        logger.info({ source }, '无响应时检测到错误弹窗，已刷新清除，重新导航到目标页面');
        this.currentMenuSection = 'unknown';
        if (source === 'work_list') {
          await this.navigateToWorkManage(page);
        } else {
          await this.navigateToPhotoAnalysis(page);
        }
      } else {
        logger.info({ source }, 'No target response after 25s, compensating with menu re-click');
        this.currentMenuSection = 'unknown';
        if (source === 'work_list') {
          await this.navigateToWorkManage(page);
        } else {
          await this.navigateToPhotoAnalysis(page);
        }
      }
      logger.info({ source, step: 'AFTER_COMPENSATION', existingResponses: this.interceptor.getResponseCount(pattern) }, 'Compensation complete, waiting again');
      initialResponse = await this.interceptor.waitForResponse(pattern, 20000);
    }

    if (!initialResponse) {
      logger.error({
        source,
        step: 'NO_RESPONSE',
        totalResponsesInStore: this.interceptor.getResponseCount(pattern),
        rejectionLog: this.interceptor.getRejectionLog(5),
      }, 'No response captured after navigation');
      // TODO: logPageHtml for kuaishou
      // await BrowserManager.logPageHtml(page, `no_response_kuaishou_${source}`);
      throw new Error(`No response from kuaishou ${source} after navigation`);
    }

    logger.info({ source, step: 'GOT_INITIAL', hasMore: initialResponse.hasMore, cursor: initialResponse.cursor }, 'Initial API response captured');

    const initialItems = this.interceptor.getCollectedItems(pattern);
    // 诊断日志：打印前5条视频的评论数字段（确认 parseVideoItem 提取是否正确）
    const sampleItems = initialItems.slice(0, 5).map((i: any) => ({
      id: i.aweme_id,
      desc: i.description?.slice(0, 30),
      comment_count: i.comment_count,
      metrics_keys: i.metrics ? Object.keys(i.metrics).slice(0, 10) : [],
    }));
    logger.info({ source, step: 'INITIAL_ITEMS', initialCount: initialItems.length, sampleItems }, 'Kuaishou video items parsed with comment diagnostics');

    // 从 raw responses 中提取 authorUid、photoStatus 和 isPinned（增量构建，供滚动循环和后处理共用）
    const awemeIdToAuthor = new Map<string, { uid: string; nickname: string }>();
    const awemeIdToPhotoStatus = new Map<string, number>();
    const privateAwemeIds = new Set<string>();
    const awemeIdToIsPinned = new Map<string, boolean>();

    /** 从 raw responses 中增量更新 photoStatus map，返回当前公开视频数 */
    const updatePhotoStatusMapAndGetPublicCount = (): number => {
      const rawResponses = this.interceptor.getResponses(pattern) || [];
      for (const resp of rawResponses) {
        const body = (resp as any)?.body;
        if (!body || typeof body !== 'object') continue;
        const rawItems: any[] =
          (Array.isArray(body.items) ? body.items : null) ||
          (Array.isArray(body.list) ? body.list : null) ||
          (Array.isArray(body.feeds) ? body.feeds : null) ||
          (Array.isArray(body.data?.items) ? body.data.items : null) ||
          (Array.isArray(body.data?.list) ? body.data.list : null) ||
          (Array.isArray(body.data?.feeds) ? body.data.feeds : null) ||
          (Array.isArray(body.data?.photoList?.photoItems) ? body.data.photoList.photoItems : null) ||
          (Array.isArray(body.data?.photoList) ? body.data.photoList : null) ||
          (Array.isArray(body.data?.analysisList) ? body.data.analysisList : null) ||
          (Array.isArray(body.data?.worksList) ? body.data.worksList : null) ||
          [];
        for (const raw of rawItems) {
          const id = raw.workId || raw.photoId || raw.id;
          const uid = raw.userId || raw.authorId;
          if (id && uid) {
            awemeIdToAuthor.set(String(id), {
              uid: String(uid),
              nickname: raw.userName || raw.authorName || '',
            });
          }
          // 提取 photoStatus 用于非公开过滤（photo_analysis 源无此字段，undefined 视为公开）
          const photoStatus = raw.photoStatus ?? raw.status;
          if (id && photoStatus !== undefined) {
            awemeIdToPhotoStatus.set(String(id), Number(photoStatus));
            if (Number(photoStatus) !== 0) {
              privateAwemeIds.add(String(id));
            }
          }
          // 提取 photoTop 置顶标记（photoTop: true 表示置顶视频）
          if (id) {
            awemeIdToIsPinned.set(String(id), raw.photoTop === true);
          }
        }
      }
      // 公开视频数 = 已收集总数 - 已知非公开数
      const collectedCount = this.interceptor.getCollectedCount(pattern);
      const publicCount = collectedCount - privateAwemeIds.size;
      return publicCount;
    };

    // 初始更新一次，获取初始公开视频数
    const initialPublicCount = updatePhotoStatusMapAndGetPublicCount();
    logger.info({ source, collected: initialItems.length, publicCount: initialPublicCount, privateCount: privateAwemeIds.size }, '[Phase1] Initial photo status map built');

    if (source === 'photo_analysis') {
      await this.paginateNextPage(page, pattern);
    } else {
      // 传入公开视频计数回调，让滚动循环用公开视频数判断是否停止
      await this.scrollToLoadMoreWithDualStop(page, pattern, updatePhotoStatusMapAndGetPublicCount);
    }

    const allItems = this.interceptor.getCollectedItems(pattern);

    logger.info(
      { source, mapSize: awemeIdToAuthor.size, sampleAuthor: awemeIdToAuthor.size > 0 ? Array.from(awemeIdToAuthor.values())[0] : null },
      '[Kuaishou Phase1] Author extraction from raw responses',
    );

    // 先 enrich，再过滤非公开，最后截断到 maxMonitorVideos（确保返回的公开视频数尽量达到目标）
    const enriched = allItems.map((item: any) => ({
      ...item,
      authorUid: awemeIdToAuthor.get(String(item.aweme_id))?.uid || String(item.userId || item.authorId || ''),
      authorNickname: awemeIdToAuthor.get(String(item.aweme_id))?.nickname || item.userName || item.authorName || '',
      isPinned: awemeIdToIsPinned.get(String(item.aweme_id)) || false,
    }));

    // 非公开视频过滤：photoStatus !== 0 视为非公开（必须先检查 undefined，photo_analysis 源无此字段）
    const filtered = enriched.filter((item: any) => {
      const photoStatus = awemeIdToPhotoStatus.get(String(item.aweme_id));
      if (photoStatus !== undefined && photoStatus !== 0) {
        logger.info({ awemeId: item.aweme_id, photoStatus }, '[Phase1] 过滤非公开视频（photoStatus!=0）');
        return false;
      }
      return true;
    });

    const sliced = filtered.slice(0, this.maxMonitorVideos);

    logger.info({
      source,
      step: 'FETCH_COMPLETE',
      totalCollected: allItems.length,
      totalResponses: this.interceptor.getResponseCount(pattern),
      finalCount: sliced.length,
      privateFiltered: enriched.length - filtered.length,
      maxMonitor: this.maxMonitorVideos,
      awemeIds: sliced.map(i => i.aweme_id),
    }, 'Kuaishou video list fetch completed');

    this.awemeIdToPhotoStatus = awemeIdToPhotoStatus;
    return sliced;
  }

  private isOnTargetPage(page: Page, source: KuaishouQuerySource): boolean {
    const url = page.url();

    if (source === 'work_list') {
      return url.includes('/article/manage/video') || url.includes('/article/manage');
    }
    if (source === 'photo_analysis') {
      return url.includes('/statistics/article') || url.includes('/statistics/');
    }
    return false;
  }

  private async navigateToWorkManage(page: Page): Promise<void> {
    logger.info({ currentMenuSection: this.currentMenuSection }, 'Navigating to kuaishou work management');

    await HumanActions.thinkingPause(page, 800, 2000);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const clicked = await resolveAndClick(page, 'menu.content.work-manage', 'kuaishou', { timeout: 10000 });

      if (clicked) {
        await HumanActions.wait(page, 1500, 3000);
        await this.dismissErrorDialog(page);
        logger.info('Navigated to kuaishou work management page');
        this.currentMenuSection = 'content';
        return;
      }

      logger.warn({ attempt }, 'Kuaishou work management navigation failed, retrying');
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('Menu navigation to kuaishou work management failed after all retries');
  }

  private async navigateToPhotoAnalysis(page: Page): Promise<void> {
    logger.info({ currentMenuSection: this.currentMenuSection }, 'Navigating to kuaishou photo analysis');

    await HumanActions.thinkingPause(page, 800, 2000);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const clicked = await resolveAndClick(page, 'menu.data-center.photo-analysis', 'kuaishou', { timeout: 10000 });

      if (clicked) {
        await HumanActions.wait(page, 2000, 3500);
        await this.dismissErrorDialog(page);
        logger.info('Navigated to kuaishou photo analysis page');
        this.currentMenuSection = 'data_center';
        return;
      }

      logger.warn({ attempt }, 'Kuaishou photo analysis navigation failed, retrying');
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('Menu navigation to kuaishou photo analysis failed after all retries');
  }


  /**
   * 分页加载 — 快手数据中心（作品分析）使用 Element UI 分页器,
   * 需要点击"下一页"按钮触发新 API 请求, 而非滚动加载。
   */
  private async paginateNextPage(page: Page, pattern: string): Promise<void> {
    let totalPages = 0;
    let pagesSinceNewData = 0;
    let lastKnownCount = this.interceptor.getCollectedCount(pattern);
    let lastKnownResponseCount = this.interceptor.getResponseCount(pattern);

    const MAX_PAGES = 20;
    const MAX_NO_NEW_DATA = 3;
    const nextBtnDef = getSelector('page.next-page-btn', PLATFORM);

    while (totalPages < MAX_PAGES) {
      const collectedCount = this.interceptor.getCollectedCount(pattern);
      const responseCount = this.interceptor.getResponseCount(pattern);

      if (collectedCount > lastKnownCount || responseCount > lastKnownResponseCount) {
        pagesSinceNewData = 0;
        lastKnownCount = collectedCount;
        lastKnownResponseCount = responseCount;
      }

      logger.info({
        step: 'PAGE_ITERATION',
        totalPages,
        collectedCount,
        responseCount,
        maxMonitor: this.maxMonitorVideos,
        pagesSinceNewData,
      }, 'Kuaishou page loop iteration');

      if (collectedCount >= this.maxMonitorVideos) {
        logger.info({ collectedCount, maxMonitor: this.maxMonitorVideos, totalPages }, 'Kuaishou quantity cap reached - stopping pagination');
        break;
      }

      if (pagesSinceNewData >= MAX_NO_NEW_DATA) {
        logger.info({ totalPages, pagesSinceNewData, collectedCount }, 'Kuaishou no new data after consecutive pages - stopping');
        break;
      }

      // 滚动到页面底部（分页器在底部，需要先滚到底部才能看到并点击下一页按钮）
      await HumanActions.cdpSmartScroll(page, [], 2000, 'down');
      await HumanActions.wait(page, 500, 1000);

      // 检查下一页按钮是否存在且可用
      const btnCss = nextBtnDef.css;
      if (!btnCss) {
        logger.warn('Kuaishou next-page button selector not configured');
        break;
      }

      // 等待页面稳定后再检查按钮
      await HumanActions.wait(page, 500, 1000);

      const btnVisible = await HumanActions.cdpIsElementVisible(page, btnCss);
      if (!btnVisible) {
        // 回退：尝试用 fallback 选择器
        let foundFallback = false;
        for (const fbSel of ['.btn-next', '.el-pagination__next', 'button.btn-next']) {
          const fbVisible = await HumanActions.cdpIsElementVisible(page, fbSel);
          if (fbVisible) {
            logger.info({ btnCss, fallback: fbSel, totalPages }, 'Kuaishou next-page button found via fallback');
            // 用回退选择器点击
            await HumanActions.cdpClick(page, fbSel, { timeout: 8000 });
            await HumanActions.wait(page, 1500, 3000);
            const newResponse = await this.interceptor.waitForResponse(pattern, 15000);
            totalPages++;
            // update counts same as main flow
            const postPageCount = this.interceptor.getCollectedCount(pattern);
            if (postPageCount > lastKnownCount) {
              pagesSinceNewData = 0;
              lastKnownCount = postPageCount;
            } else {
              pagesSinceNewData++;
            }
            foundFallback = true;
            break;
          }
        }
        if (!foundFallback) {
          logger.info({ btnCss, totalPages }, 'Kuaishou next-page button not visible (last page?) - stopping');
          break;
        }
        continue;
      }

      // 检查按钮是否 disabled
      const isDisabled = await HumanActions.cdpIsElementDisabled(page, btnCss, ['dom-property', 'class-disabled', 'attr-disabled']);
      if (isDisabled) {
        logger.info({ totalPages }, 'Kuaishou next-page button is disabled (last page) - stopping');
        break;
      }

      await this.humanReadingPause(page);

      // 点击下一页
      logger.info({ btnCss, totalPages }, 'Kuaishou clicking next page button');
      const clickResult = await HumanActions.cdpClick(page, btnCss, { timeout: 8000 });
      logger.info({ btnCss, clickResult, totalPages }, 'Kuaishou next page click result');
      await HumanActions.wait(page, 2000, 4000);

      // 等待新的 API 响应
      const newResponse = await this.interceptor.waitForResponse(pattern, 15000);
      logger.info({ totalPages, hasNewResponse: !!newResponse, responses: this.interceptor.getResponseCount(pattern), collected: this.interceptor.getCollectedCount(pattern) }, 'Kuaishou after next page wait');
      totalPages++;

      const postPageCount = this.interceptor.getCollectedCount(pattern);
      const postPageResponseCount = this.interceptor.getResponseCount(pattern);

      if (postPageCount > lastKnownCount || postPageResponseCount > lastKnownResponseCount) {
        pagesSinceNewData = 0;
        lastKnownCount = postPageCount;
        lastKnownResponseCount = postPageResponseCount;
        logger.info({
          step: 'PAGE_IMMEDIATE_HIT',
          totalPages,
          newCount: postPageCount,
          increment: postPageCount - collectedCount,
        }, 'Kuaishou new data arrived after page click');
      } else {
        pagesSinceNewData++;
        logger.info({ step: 'PAGE_NO_DATA', totalPages, pagesSinceNewData }, 'Kuaishou no new data after page click');
      }
    }

    logger.info({ step: 'PAGE_LOOP_DONE', totalPages, finalCollected: this.interceptor.getCollectedCount(pattern) }, 'Kuaishou page loop finished');
  }

  private async scrollToLoadMoreWithDualStop(page: Page, pattern: string, getPublicCount?: () => number): Promise<void> {
    let totalScrolls = 0;
    let scrollsSinceNewData = 0;
    let lastKnownCount = this.interceptor.getCollectedCount(pattern);
    let lastKnownResponseCount = this.interceptor.getResponseCount(pattern);

    while (totalScrolls < MAX_SCROLL_ATTEMPTS) {
      const collectedCount = this.interceptor.getCollectedCount(pattern);
      const responseCount = this.interceptor.getResponseCount(pattern);
      const publicCount = getPublicCount ? getPublicCount() : collectedCount;

      if (collectedCount > lastKnownCount || responseCount > lastKnownResponseCount) {
        scrollsSinceNewData = 0;
        lastKnownCount = collectedCount;
        lastKnownResponseCount = responseCount;
        logger.info({
          step: 'DAEMON_DATA_ARRIVED',
          totalScrolls,
          collectedCount,
          publicCount,
          responseCount,
          maxMonitor: this.maxMonitorVideos,
        }, 'Kuaishou background daemon detected new data');
      }

      logger.info({
        step: 'SCROLL_ITERATION',
        totalScrolls,
        collectedCount,
        publicCount,
        responseCount,
        maxMonitor: this.maxMonitorVideos,
        scrollsSinceNewData,
        dataExhausted: this.interceptor.hasDataExhausted(pattern),
      }, 'Kuaishou scroll loop iteration');

      if (publicCount >= this.maxMonitorVideos) {
        logger.info({ collectedCount, publicCount, maxMonitor: this.maxMonitorVideos, totalScrolls }, 'Kuaishou quantity cap reached - stopping scroll');
        break;
      }

      if (this.interceptor.hasDataExhausted(pattern)) {
        logger.info({ totalScrolls, collectedCount, publicCount }, 'Kuaishou data exhausted - stopping scroll');
        break;
      }

      if (scrollsSinceNewData >= MAX_SCROLL_NO_NEW_DATA) {
        logger.info({ totalScrolls, scrollsSinceNewData, collectedCount, publicCount }, 'Kuaishou no new data after consecutive scrolls - stopping');
        break;
      }

      await this.humanReadingPause(page);

      await this.smartScrollListContainer(page);

      totalScrolls++;

      const postScrollCount = this.interceptor.getCollectedCount(pattern);
      const postScrollResponseCount = this.interceptor.getResponseCount(pattern);

      if (postScrollCount > lastKnownCount || postScrollResponseCount > lastKnownResponseCount) {
        scrollsSinceNewData = 0;
        lastKnownCount = postScrollCount;
        lastKnownResponseCount = postScrollResponseCount;
        logger.info({
          step: 'SCROLL_IMMEDIATE_HIT',
          totalScrolls,
          newCount: postScrollCount,
          increment: postScrollCount - collectedCount,
        }, 'Kuaishou new data arrived immediately after scroll');
      } else {
        scrollsSinceNewData++;
        logger.info({ step: 'SCROLL_NO_IMMEDIATE_DATA', totalScrolls, scrollsSinceNewData }, 'Kuaishou no immediate data after scroll');

        if (scrollsSinceNewData >= 4) {
          logger.info({ step: 'FALLBACK_KEY' }, 'Kuaishou trying fallback CDP wheel scroll');
          await HumanActions.humanScroll(page, 400, {
            minPause: 300,
            maxPause: 800,
          });
          await HumanActions.wait(page, 1500, 3000);
          const fallbackCount = this.interceptor.getCollectedCount(pattern);
          if (fallbackCount > lastKnownCount) {
            scrollsSinceNewData = 0;
            lastKnownCount = fallbackCount;
            logger.info({ step: 'FALLBACK_KEY_OK' }, 'Kuaishou fallback scroll triggered new data');
          } else {
            logger.info({ step: 'FALLBACK_KEY_FAIL' }, 'Kuaishou fallback scroll did not trigger new data');
          }
        }
      }
    }

    logger.info({ step: 'SCROLL_LOOP_DONE', totalScrolls, finalCollected: this.interceptor.getCollectedCount(pattern), finalPublic: getPublicCount ? getPublicCount() : this.interceptor.getCollectedCount(pattern), finalResponses: this.interceptor.getResponseCount(pattern) }, 'Kuaishou scroll loop finished');
  }

  private async humanReadingPause(page: Page): Promise<void> {
    const readingDelay = 800 + Math.random() * 700;
    logger.debug({ readingDelay: Math.round(readingDelay) }, 'Kuaishou human reading pause between scrolls');
    await HumanActions.wait(page, readingDelay, readingDelay + 100);
  }

  private async smartScrollListContainer(page: Page): Promise<void> {
    try {
      const scrollDef = getSelector('scroll.main-content', PLATFORM);
      const tableBodyDef = getSelector('region.work-list-table', PLATFORM);
      const containerSelectors = [
        scrollDef.css,
        tableBodyDef.css,
        '[class*="table"] [class*="body"]',
        '.ant-table-body',
        '[class*="list-scroll"]',
        '[class*="scroll"]',
        '[class*="work"] [class*="list"]',
      ].filter(Boolean) as string[];

      const container = await HumanActions.cdpFindScrollContainer(page, containerSelectors);

      if (container) {
        logger.info({ container }, 'Kuaishou found scrollable container via CDP DOM, dispatching smart scroll');
        await HumanActions.cdpSmartScroll(page, [container.sel], 300, 'down');
      } else {
        logger.info('Kuaishou no container found, dispatching CDP scroll at viewport center');
        await HumanActions.cdpSmartScroll(page, [], 400, 'down');
      }

      await HumanActions.wait(page, 300, 800);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Kuaishou smart scroll failed, using CDP scroll fallback');
      await HumanActions.humanScroll(page, 300);
    }
  }

  async executeExitStrategy(page: Page, currentPage: PageType = 'other', excludeSubmenuKey?: string): Promise<void> {
    const action = ExitStrategy.getNextPageAction(currentPage);
    const currentSubmenuKey = getSubmenuKeyForPageType(currentPage, PLATFORM);
    const excludeKeys = [excludeSubmenuKey, currentSubmenuKey].filter(Boolean) as string[];
    logger.info({ currentPage, action, excludeKeys }, 'Kuaishou executing exit strategy');

    if (action === 'refresh') {
      const exitAction = ExitStrategy.getRandomExitAction();
      logger.info({ exitAction }, 'Exit action chosen');

      if (exitAction === 'navigate_submenu') {
        const submenuKey = getRandomExitSubmenuKey(PLATFORM, ...excludeKeys);
        logger.info({ submenuKey }, 'Navigating to random submenu for exit');

        const clicked = await resolveAndClick(page, submenuKey, 'kuaishou', { timeout: 10000 });
        if (clicked) {
          logger.info({ submenuKey }, 'Successfully navigated to submenu');
          this.currentMenuSection = 'unknown';
        } else {
          logger.warn({ submenuKey }, 'Submenu navigation failed, falling back to idle wander');
          await HumanActions.randomBlankClick(page);
        }
        await HumanActions.wait(page, 2000, 4000);
      } else if (exitAction === 'idle_wander') {
        logger.info('Executing idle wander for exit');
        await HumanActions.randomBlankClick(page);
        await HumanActions.wait(page, 500, 1500);
        await HumanActions.humanScroll(page, 50 + Math.random() * 100, {
          minPause: 200,
          maxPause: 600,
        });
        await HumanActions.wait(page, 1000, 2000);
      } else {
        logger.info('Executing CDP refresh as last resort');
        await HumanActions.cdpF5Refresh(page);
        HumanActions.clearCDPContext(page);
        this.currentMenuSection = 'unknown';
        await HumanActions.wait(page, 2000, 4000);
      }
    } else {
      const submenuKey = getRandomExitSubmenuKey(PLATFORM, ...excludeKeys);
      logger.info({ submenuKey }, 'Switching source — navigating to submenu');

      const clicked = await resolveAndClick(page, submenuKey, 'kuaishou', { timeout: 10000 });
      if (clicked) {
        this.currentMenuSection = 'unknown';
      } else {
        logger.warn('Submenu navigation failed for switch source, falling back to idle wander');
        await HumanActions.randomBlankClick(page);
        this.currentMenuSection = 'unknown';
      }
      await HumanActions.wait(page, 1000, 2000);
    }

    logger.info({ finalUrl: page.url(), currentMenuSection: this.currentMenuSection }, 'Kuaishou exit strategy completed — final page state');
  }

  async detectRiskControlAsync(page: Page): Promise<RiskControlDetection> {
    try {
      const url = page.url().toLowerCase();
      for (const riskUrl of RISK_CONTROL_URLS) {
        if (url.includes(riskUrl)) {
          return {
            detected: true,
            type: 'login_redirect',
            evidence: `URL redirected to: ${url}`,
          };
        }
      }

      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        for (const keyword of RISK_CONTROL_KEYWORDS) {
          if (bodyText.includes(keyword.toLowerCase())) {
            return {
              detected: true,
              type: keyword.includes('login') || keyword.includes('passport') ? 'login_redirect' : 'captcha',
              evidence: `Page contains risk control keyword: "${keyword}"`,
            };
          }
        }
      } catch {}

      try {
        const title = await HumanActions.cdpGetTitle(page);
        for (const keyword of RISK_CONTROL_KEYWORDS) {
          if (title.includes(keyword.toLowerCase())) {
            return {
              detected: true,
              type: 'security_verify',
              evidence: `Page title contains: "${title}"`,
            };
          }
        }
      } catch {}

      return {
        detected: false,
        type: 'unknown',
        evidence: '',
      };
    } catch {
      return {
        detected: false,
        type: 'unknown',
        evidence: '',
      };
    }
  }

  // ════════════════════════════════════════
  // 前端错误弹窗处理 (cp-dialog-wrapper)
  // 快手自身 API 请求超时 (30s) 时前端弹出 "出错了"/"timeout of 30000ms exceeded" 对话框，
  // 该弹窗会阻塞页面交互，导致爬虫无法获取数据。用户反馈该弹窗有时无法正常关闭，
  // 因此检测到后优先刷新页面清除卡死状态，而非跳过。
  // ════════════════════════════════════════

  /**
   * 检测快手前端错误弹窗 (.cp-dialog-wrapper)
   * @returns detected=是否可见; content=弹窗内容摘要（用于日志）
   */
  private async detectErrorDialog(page: Page): Promise<{ detected: boolean; content?: string }> {
    try {
      const visible = await HumanActions.cdpIsElementVisible(page, '.cp-dialog-wrapper');
      if (!visible) return { detected: false };

      let content = '出错了';
      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        const timeoutMatch = bodyText.match(/timeout of \d+ms exceeded/i);
        if (timeoutMatch) {
          content = timeoutMatch[0];
        } else if (bodyText.includes('出错了')) {
          content = '出错了';
        }
      } catch {}

      return { detected: true, content };
    } catch {
      return { detected: false };
    }
  }

  /**
   * 处理快手前端错误弹窗 — 先尝试点击"确认"关闭，再刷新页面清除卡死状态。
   * 刷新是关键步骤：用户反馈该弹窗有时无法正常关闭，刷新页面是更可靠的方案。
   * @returns 是否检测并处理了错误弹窗（即是否刷新了页面）
   */
  private async dismissErrorDialog(page: Page): Promise<boolean> {
    const detected = await this.detectErrorDialog(page);
    if (!detected.detected) return false;

    logger.warn({ content: detected.content }, '[ErrorDialog] 快手前端错误弹窗已检测到，刷新页面清除卡死状态');

    // 先尝试点击"确认"按钮关闭弹窗（可能失败，但无害）
    const confirmSelectors = [
      '.cp-dialog__btns button',
      '.cp-dialog .el-button--primary',
      '.cp-dialog-wrapper button',
    ];
    for (const sel of confirmSelectors) {
      try {
        const clicked = await HumanActions.cdpClick(page, sel, { timeout: 3000 });
        if (clicked) {
          logger.info({ selector: sel }, '[ErrorDialog] 已点击确认按钮');
          break;
        }
      } catch {}
    }

    await HumanActions.wait(page, 500, 1000);

    // 关键：刷新页面清除卡死状态（用户要求：刷新页面解决，而非跳过）
    await HumanActions.cdpF5Refresh(page);
    HumanActions.clearCDPContext(page);
    this.currentMenuSection = 'unknown';
    await HumanActions.wait(page, 2000, 4000);
    await HumanActions.pageLoadBehavior(page);

    // 验证弹窗是否已消失
    const stillThere = await this.detectErrorDialog(page);
    if (stillThere.detected) {
      logger.warn({ content: stillThere.content }, '[ErrorDialog] 刷新后弹窗仍存在，将在下次检查时重试');
    } else {
      logger.info('[ErrorDialog] 刷新页面后错误弹窗已清除');
    }

    return true;
  }

  async captureRiskScene(page: Page, userId: number, riskType: string): Promise<{ screenshotPath: string | null; htmlPath: string | null }> {
    const sceneDir = path.resolve(process.cwd(), 'data', 'risk_scenes');
    if (!fs.existsSync(sceneDir)) {
      fs.mkdirSync(sceneDir, { recursive: true });
    }

    const timestamp = Date.now();
    const baseName = `risk_kuaishou_${userId}_${riskType}_${timestamp}`;
    let screenshotPath: string | null = null;
    let htmlPath: string | null = null;

    try {
      const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
      screenshotPath = path.join(sceneDir, `${baseName}.png`);
      fs.writeFileSync(screenshotPath, screenshotBuffer);
      logger.info({ screenshotPath, sizeKB: Math.round(screenshotBuffer.length / 1024) }, 'Kuaishou risk scene screenshot saved');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to capture kuaishou risk scene screenshot');
    }

    try {
      const html = await HumanActions.cdpGetBodyText(page);
      htmlPath = path.join(sceneDir, `${baseName}.html.txt`);
      fs.writeFileSync(htmlPath, html);
      logger.info({ htmlPath, length: html.length }, 'Kuaishou risk scene HTML text saved');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to capture kuaishou risk scene HTML');
    }

    return { screenshotPath, htmlPath };
  }

  async checkForUpdates(
    page: Page,
    userId: number,
    windowId: string,
    source: KuaishouQuerySource
  ): Promise<KuaishouCheckResult> {
    logger.info({ userId, source }, '[Phase1] Starting kuaishou update check — collection only mode');

    const riskCheck = await this.detectRiskControlAsync(page);
    if (riskCheck.detected) {
      logger.error({ userId, riskType: riskCheck.type, evidence: riskCheck.evidence }, '[Phase1] Kuaishou risk control detected before check');
      return {
        hasUpdate: false,
        commentsQueue: [],
        updatedVideos: [],
        riskControlDetected: true,
        riskControlInfo: riskCheck,
      };
    }

    // 开始抓取前清除可能存在的前端错误弹窗
    await this.dismissErrorDialog(page);

    logger.info({ userId }, '[Phase1] Fetching kuaishou video list from source');
    const videos = await this.fetchVideoListFromSource(page, source);

    // syncPlatformAuthorId 会处理首次绑定 + 自愈检测

    // 诊断日志：记录每个视频的评论数提取情况
    logger.info({
      userId,
      videoCount: videos.length,
      videoDetails: videos.map(v => ({
        awemeId: v.aweme_id,
        desc: v.description?.slice(0, 30),
        commentCount: v.comment_count,
      })),
    }, '[Phase1] Fetched video list with comment counts');

    const dbVideos = await db.getVideosByUserId(userId);

    // 快手两个数据源的 workId / photoId 不同，按 title+createTime 归一化 ID
    const titleToDbId = new Map<string, string>();
    for (const dv of dbVideos) {
      const key = `${dv.description}|${dv.createTime}`;
      titleToDbId.set(key, dv.id);
    }

    for (const v of videos) {
      const key = `${v.description}|${v.create_time}`;
      const existingId = titleToDbId.get(key);
      if (existingId && existingId !== v.aweme_id) {
        logger.info({ oldId: v.aweme_id, normalizedId: existingId, description: v.description?.slice(0, 30) }, '[Phase1] Kuaishou ID normalized (cross-source dedup)');
        v.aweme_id = existingId;
      }
    }

    logger.info({ userId, dbVideoCount: dbVideos.length, fetchedCount: videos.length }, '[Phase1] Comparing with database records (pre-upsert)');

    // 动态剔除：已入库视频变为非公开（photoStatus!=0）时从数据库删除
    const awemeIdToPhotoStatus = this.awemeIdToPhotoStatus;
    for (const dbVideo of dbVideos) {
      const freshItem = videos.find((f: any) => f.aweme_id === dbVideo.id);
      if (!freshItem) {
        const photoStatus = awemeIdToPhotoStatus.get(dbVideo.id);
        if (photoStatus !== undefined && photoStatus !== 0) {
          logger.info({ awemeId: dbVideo.id, photoStatus }, '[Phase1] 已入库视频变为非公开，剔除');
          await prisma.video.delete({ where: { id: dbVideo.id } });
        }
      }
    }

    const commentsQueue: KuaishouCommentQueueItem[] = [];

    for (const video of videos) {
      const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
      if (!dbVideo) {
        // 跨用户保护：视频可能已被其他用户首次爬取入库
        const existingVideo = await prisma.video.findUnique({ where: { id: video.aweme_id } });
        if (existingVideo && existingVideo.userId !== userId) {
          logger.warn({
            awemeId: video.aweme_id,
            description: video.description?.slice(0, 30),
            ownerUserId: existingVideo.userId,
            currentUserId: userId,
          }, '[Phase1] Video already exists under another user — skipping to prevent cross-user data leak');
          continue;
        }
        // 新视频首次入库：如果有评论，入队获取
        if (video.comment_count > 0) {
          logger.info({
            awemeId: video.aweme_id,
            description: video.description,
            commentCount: video.comment_count,
          }, '[Phase1] New kuaishou video with comments — enqueuing for initial fetch');
          commentsQueue.push({
            awemeId: video.aweme_id,
            description: video.description,
            createTime: video.create_time,
            oldCount: 0,
            newCount: video.comment_count,
            isFirstCrawl: true,
            _userId: userId,
            isPinned: video.isPinned || false,
          });
        } else {
          logger.info({ awemeId: video.aweme_id, description: video.description }, '[Phase1] New kuaishou video with no comments — skipping');
        }

        // 同步作者 ID（首次绑定 + 自愈）
        if (video.authorUid) {
          await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
          logger.info({ userId, authorUid: video.authorUid }, '[Kuaishou Phase1] Synced platform author ID');
        }

        continue;
      }

      if (video.comment_count > dbVideo.commentCount) {
        const diff = video.comment_count - dbVideo.commentCount;
        logger.info({
          awemeId: video.aweme_id,
          description: video.description,
          oldCount: dbVideo.commentCount,
          newCount: video.comment_count,
          diff,
        }, '[Phase1] Kuaishou comment count increased — enqueuing for comment fetch');

        commentsQueue.push({
          awemeId: video.aweme_id,
          description: video.description,
          createTime: video.create_time,
          oldCount: dbVideo.commentCount,
          newCount: video.comment_count,
          isFirstCrawl: false,
          _userId: userId,
          isPinned: video.isPinned || false,
        });
      } else {
        // 评论数未变，但检查是否需要首次深度爬取（无 VideoRootCommentCount 记录）
        const snapshots = await db.getRootCommentCounts(video.aweme_id);
        if (snapshots.size === 0 && video.comment_count > 0) {
          logger.info({
            awemeId: video.aweme_id,
            description: video.description,
          }, '[Phase1] Existing kuaishou video without snapshots — enqueuing for initial deep crawl');
          commentsQueue.push({
            awemeId: video.aweme_id,
            description: video.description,
            createTime: video.create_time,
            oldCount: dbVideo.commentCount,
            newCount: video.comment_count,
            isFirstCrawl: true,
            _userId: userId,
            isPinned: video.isPinned || false,
          });
        } else {
          logger.info({
            awemeId: video.aweme_id,
            current: video.comment_count,
            stored: dbVideo.commentCount,
          }, '[Phase1] Kuaishou comment count unchanged');
        }
      }
    }

    logger.info({ userId, videoCount: videos.length }, '[Phase1] Comparison done, upserting videos to database');
    await db.reconcileVideosForUser(userId, videos, this.maxMonitorVideos);

    if (commentsQueue.length === 0) {
      logger.info({ userId }, '[Phase1] No comment updates found — task complete');
    } else {
      logger.info({ userId, count: commentsQueue.length, awemeIds: commentsQueue.map(q => q.awemeId) }, '[Phase1] Found videos with comment updates — proceeding to Phase 2');
    }

    const postRiskCheck = await this.detectRiskControlAsync(page);
    if (postRiskCheck.detected) {
      logger.error({ userId, riskType: postRiskCheck.type }, '[Phase1] Kuaishou risk control detected after check');
      return {
        hasUpdate: false,
        commentsQueue,
        updatedVideos: [],
        riskControlDetected: true,
        riskControlInfo: postRiskCheck,
      };
    }

    return {
      hasUpdate: commentsQueue.length > 0,
      commentsQueue,
      updatedVideos: [],
      riskControlDetected: false,
    };
  }

  async navigateToCommentManage(page: Page): Promise<boolean> {
    logger.info('[Phase2] Navigating to kuaishou comment management page');

    await HumanActions.thinkingPause(page, 800, 2000);

    await this.ensureSidebarReady(page);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const bodyText = await HumanActions.cdpGetBodyText(page);
      const alreadyOnCommentPage = bodyText.includes('评论管理')
        && (bodyText.includes('选择视频') || bodyText.includes('评论列表'));

      if (alreadyOnCommentPage) {
        logger.info({ attempt }, '[Phase2] Already on kuaishou comment management page');
        return true;
      }

      const commentClicked = await resolveAndClick(page, 'menu.interact.comment-manage', 'kuaishou', { timeout: 10000 });

      if (commentClicked) {
        logger.info('[Phase2] [评论管理] clicked, waiting for page load');
        await HumanActions.wait(page, 3000, 5000);
        await this.dismissErrorDialog(page);

        const loaded = await this.waitForCommentManagePage(page);
        if (loaded) {
          logger.info('[Phase2] Kuaishou comment management page loaded successfully');
          this.currentMenuSection = 'interact';
          return true;
        }
        logger.warn({ attempt }, '[Phase2] Page elements not fully loaded after click');
      } else {
        logger.warn({ attempt }, '[Phase2] All [评论管理] click attempts failed');
      }

      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('[Phase2] Navigation to kuaishou comment management failed after all retries');
    return false;
  }

  private async ensureSidebarReady(page: Page): Promise<void> {
    try {
      const sidebarDef = getSelector('region.sidebar', PLATFORM);
      const sidebarCss = sidebarDef.css || 'section > ul';
      const sidebarVisible = await HumanActions.cdpIsElementVisible(page, sidebarCss);
      if (sidebarVisible) return;

      logger.info('[Phase2] Kuaishou sidebar not fully rendered, clicking home to reset');
      const homeDef = getSelector('menu.home', PLATFORM);
      await tryClickBySelector(page, homeDef, { timeout: 6000 });
      await HumanActions.wait(page, 2000, 3500);
    } catch {}
  }

  private async waitForCommentManagePage(page: Page): Promise<boolean> {
    const startTime = Date.now();
    const timeout = 30000;

    while (Date.now() - startTime < timeout) {
      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        if (bodyText.includes('评论管理') || bodyText.includes('选择视频')) {
          return true;
        }
      } catch {}

      const selectVideoBtnDef = getSelector('page.select-video-btn', PLATFORM);
      if (selectVideoBtnDef.css) {
        try {
          const selectBtnVisible = await HumanActions.cdpIsElementVisible(page, selectVideoBtnDef.css);
          if (selectBtnVisible) return true;
        } catch {}
      }

      const selectWorkVisible = await HumanActions.cdpIsElementVisible(page, 'button:has-text("选择视频")');
      if (selectWorkVisible) return true;

      await HumanActions.wait(page, 800, 1500);
    }

    return false;
  }

  async processCommentsQueue(
    page: Page,
    queue: KuaishouCommentQueueItem[]
  ): Promise<{ results: KuaishouCommentProcessResult[]; riskDetected: boolean; riskInfo?: RiskControlDetection }> {
    const results: KuaishouCommentProcessResult[] = [];
    const startTime = Date.now();

    logger.info({ queueLength: queue.length }, '[Phase3] Starting kuaishou comment queue processing');

    this.page = page;

    // 拦截器已在 monitorService Phase2 导航前注册，此处不重复注册
    // 等待 comment/home 响应到达（页面加载后会自动调用）
    let homeReady = false;
    for (let w = 0; w < 10; w++) {
      const hr = this.interceptor.getResponses(COMMENT_HOME_PATTERN);
      if (hr.length > 0) {
        homeReady = true;
        logger.info({ waitRounds: w }, '[Phase3] comment/home response found');
        break;
      }
      await HumanActions.wait(page, 500, 800);
    }
    if (!homeReady) {
      logger.warn('[Phase3] comment/home response not received after waiting, will try drawer for first video');
    }

    try {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const videoT0 = Date.now();
        logger.info({ index: i + 1, total: queue.length, awemeId: item.awemeId }, '[Phase3] Processing kuaishou video in queue');

        const riskCheck = await this.detectRiskControlAsync(page);
        if (riskCheck.detected) {
          logger.error({ awemeId: item.awemeId, riskType: riskCheck.type }, '[Phase3] Kuaishou risk control detected — aborting');
          return { results, riskDetected: true, riskInfo: riskCheck };
        }

        // 处理每个视频前清除可能存在的前端错误弹窗
        await this.dismissErrorDialog(page);

        // ── Pre-check：检查 comment/home 响应判断当前视频 ──
        let needDrawer = true;
        let existingCommentResp: any = null;

        const homeResp = this.interceptor.getResponses(COMMENT_HOME_PATTERN);
        if (homeResp.length > 0) {
          const latestHome = homeResp[homeResp.length - 1];
          const currentPhotoId = latestHome.body?.data?.photo?.photoId || '';
          const currentTitle = latestHome.body?.data?.photo?.title?.trim() || '';

          if (currentPhotoId === item.awemeId) {
            logger.info({ awemeId: item.awemeId, currentPhotoId }, '[Phase3] Pre-check: home API matches target video');
            // 检查是否已有 commentList 响应
            const listResp = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
            if (listResp.length > 0) {
              existingCommentResp = listResp[listResp.length - 1];
              logger.info({ awemeId: item.awemeId }, '[Phase3] Pre-check: commentList response already loaded');
            }
            needDrawer = false;
          } else {
            logger.info({ awemeId: item.awemeId, currentPhotoId, currentTitle }, '[Phase3] Pre-check: current video is different, need drawer');
          }
        } else {
          logger.info({ awemeId: item.awemeId }, '[Phase3] Pre-check: no home response yet, need drawer');
        }

        // ── 需要开抽屉选择视频 ──
        if (needDrawer) {
          // 清空旧的评论响应
          for (const p of ALL_KUAISHOU_COMMENT_PATTERNS) {
            this.interceptor.clear(p);
          }

          const drawerOpened = await this.openSelectVideoDrawer(page);
          if (!drawerOpened) {
            logger.error({ awemeId: item.awemeId }, '[Phase3] Failed to open drawer — skipping');
            results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Failed to open drawer' });
            continue;
          }

          const clickT0 = Date.now();
          const clicked = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description, item.createTime);
          logger.info({ awemeId: item.awemeId, clickMs: Date.now() - clickT0, clicked }, '[Phase3] Drawer click completed');
          if (!clicked) {
            logger.error({ awemeId: item.awemeId }, '[Phase3] Video not found in drawer — skipping');
            await this.closeDrawer(page);
            results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Video not found in drawer' });
            continue;
          }

          // 等待抽屉关闭 + 评论 API 响应
          await HumanActions.wait(page, 1500, 2500);
          // 等待抽屉消失（最多 5 秒）
          for (let w = 0; w < 5; w++) {
            if (!(await this.isDrawerVisible(page))) break;
            await HumanActions.wait(page, 800, 1200);
          }

          // 等待 commentList 响应
          const respT0 = Date.now();
          const listResp = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
          if (listResp.length > 0) {
            existingCommentResp = listResp[listResp.length - 1];
          } else {
            // 等待一下让 API 返回
            await HumanActions.wait(page, 2000, 3000);
            const listResp2 = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
            if (listResp2.length > 0) {
              existingCommentResp = listResp2[listResp2.length - 1];
            }
          }
          logger.info({ awemeId: item.awemeId, waitMs: Date.now() - respT0, hasResp: !!existingCommentResp }, '[Phase3] Comment API wait completed');
        }

        if (!existingCommentResp) {
          logger.warn({ awemeId: item.awemeId }, '[Phase3] No comment API response — skipping');
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'No API response' });
          continue;
        }

        // ── 从首轮 commentList 提取根评论 ──
        const firstPageComments = existingCommentResp.body?.data?.list || [];
        const rootComments = firstPageComments.filter((c: any) => c.replyTo === 0);
        const subReplies = firstPageComments.filter((c: any) => c.replyTo !== 0);

        logger.info({
          awemeId: item.awemeId,
          totalInResponse: firstPageComments.length,
          rootCount: rootComments.length,
          subReplyCount: subReplies.length,
        }, '[Phase3] First page comments parsed');

        // ── 滚动 + 点击展开按钮收集子回复 ──
        const allCollectedComments = [...firstPageComments];
        const expandPattern = /展开(查看)?\d+条回复/;

        for (let scrollRound = 0; scrollRound < 30; scrollRound++) {
          // 查找视口内的展开按钮
          const expandButtons = await page.evaluate((pattern: string) => {
            const regex = new RegExp(pattern);
            const results: Array<{ x: number; y: number; text: string; rootCommentId: string }> = [];
            const all = Array.from(document.querySelectorAll('*'));
            for (const el of all) {
              const t = (el.textContent || '').trim();
              if (!regex.test(t) || !(el instanceof HTMLElement)) continue;
              const isLeaf = !Array.from(el.children).some(child => regex.test((child.textContent || '').trim()));
              if (!isLeaf) continue;
              const rect = el.getBoundingClientRect();
              if (rect.top < 0 || rect.bottom > window.innerHeight || rect.width === 0 || rect.height === 0) continue;

              // 往上找根评论的 commentId
              let rootCommentId = '';
              const commentItem = el.closest('[class*="comment-item"], [class*="comment"]');
              if (commentItem) {
                const cidAttr = commentItem.getAttribute('data-comment-id') || commentItem.getAttribute('data-id') || '';
                if (cidAttr) rootCommentId = cidAttr;
              }

              results.push({
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                text: t,
                rootCommentId,
              });
            }
            return results;
          }, expandPattern.source);

          if (expandButtons.length > 0) {
            // 点击每个展开按钮
            for (const btn of expandButtons) {
              logger.info({ awemeId: item.awemeId, text: btn.text, x: btn.x, y: btn.y }, '[Phase3] Clicking expand button');

              // 清空 subCommentList 响应
              this.interceptor.clear(COMMENT_REPLY_PATTERN);

              // CDP 点击
              await HumanActions.withCDPContext(page, async (ctx) => {
                await ctx.mouse.moveTo({ x: btn.x, y: btn.y });
                await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                await ctx.mouse.clickAt(btn.x, btn.y);
              });

              // 等待 subCommentList API 响应
              await HumanActions.wait(page, 1500, 2500);
              const subResp = this.interceptor.getResponses(COMMENT_REPLY_PATTERN);
              if (subResp.length > 0) {
                const latestSubResp = subResp[subResp.length - 1];
                const subList = latestSubResp.body?.data?.list || [];
                if (subList.length > 0) {
                  // 从 POST 请求体中获取根评论 ID（最可靠的方式）
                  const rootCommentId = String(latestSubResp.requestBody?.commentId || btn.rootCommentId || '');
                  for (const sub of subList) {
                    sub._rootCommentId = rootCommentId || String(sub.replyTo);
                  }
                  allCollectedComments.push(...subList);
                  logger.info({ awemeId: item.awemeId, subCount: subList.length, rootCommentId, text: btn.text }, '[Phase3] Sub-replies collected');
                }
              }
            }
          }

          // 向下滚动查看更多
          await this.scrollCommentAreaForKuaishou(page, 300);
          await HumanActions.wait(page, 1500, 2500);

          // 检查滚动后是否有新的 commentList 分页响应（加载更多根评论）
          const newCommentResps = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
          if (newCommentResps.length > 0) {
            const latestResp = newCommentResps[newCommentResps.length - 1];
            const newList = latestResp.body?.data?.list || [];
            // 去重：只添加之前没见过的评论
            const existingIds = new Set(allCollectedComments.map((c: any) => String(c.commentId)));
            const fresh = newList.filter((c: any) => !existingIds.has(String(c.commentId)));
            if (fresh.length > 0) {
              allCollectedComments.push(...fresh);
              logger.info({ awemeId: item.awemeId, freshCount: fresh.length, totalCollected: allCollectedComments.length }, '[Phase3] New root comments from pagination');
            }
          }

          // 检查是否到底
          const atBottom = await page.evaluate(() => {
            const container = document.querySelector('.el-main') as HTMLElement;
            if (!container) return true;
            return container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
          });
          if (atBottom) {
            logger.info({ awemeId: item.awemeId, scrollRound }, '[Phase3] Reached bottom');
            break;
          }
        }

        // ── 保存到数据库 ──
        // 构建根评论 ID 集合，用于子评论挂载
        const rootCommentIds = new Set(rootComments.map((c: any) => String(c.commentId)));
        const commentIdToRoot = new Map<string, string>();
        for (const rc of rootComments) {
          commentIdToRoot.set(String(rc.commentId), String(rc.commentId));
        }

        // 查询作者 ID 用于 isAuthor 判断
        const ksUser = await db.getUserById(item._userId);
        const ksAuthorId = ksUser?.platformAuthorId;

        const dbComments = allCollectedComments.map((c: any) => {
          const cid = String(c.commentId || '');
          const isRoot = c.replyTo === 0;
          // 子评论的 rootId：优先用 _rootCommentId（展开按钮标记），否则用 replyTo 查找
          const rootId = isRoot ? cid : (c._rootCommentId || commentIdToRoot.get(String(c.replyTo)) || String(c.replyTo || ''));
          const parentId = isRoot ? cid : String(c.replyTo || '');
          return {
            comment_id: cid,
            content: c.content || '',
            nickname: c.authorName || '',
            head_img_url: c.headurl || '',
            create_time: Math.floor((c.timestamp || 0) / 1000),
            like_count: c.likedCount || 0,
            reply_count: c.subCommentCount || 0,
            export_id: item.awemeId,
            is_author: ksAuthorId ? String(c.authorId) === String(ksAuthorId) : false,
            level: isRoot ? 1 as const : 2 as const,
            root_id: rootId,
            parent_id: parentId,
            reply_to_name: isRoot ? undefined : (c.replyToName || undefined),
          };
        });

        await db.batchUpsertComments('kuaishou', dbComments, item._userId);
        await db.updateCommentCount(item.awemeId, item.newCount);

        // 保存根评论快照
        const snapshots = rootComments.map((c: any) => ({
          cid: String(c.commentId),
          replyCount: c.subCommentCount || 0,
        }));
        await db.upsertRootCommentCounts(item.awemeId, snapshots);

        logger.info({
          awemeId: item.awemeId,
          totalCollected: allCollectedComments.length,
          roots: rootComments.length,
          videoMs: Date.now() - videoT0,
        }, '[Phase3] Video comment collection complete');

        results.push({ awemeId: item.awemeId, success: true, comments: dbComments as any });

        // 回到顶部准备下一个视频
        if (i < queue.length - 1) {
          await this.scrollCommentAreaForKuaishou(page, 'top');
          await HumanActions.wait(page, 500, 1000);
        }
      }
    } finally {
      this.unregisterCommentListener();
      logger.info('[Phase3] Kuaishou comment queue processing finished');
    }

    const elapsed = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    logger.info({ elapsed, total: queue.length, success: successCount, failed: failCount }, '[Phase3] Kuaishou queue processing complete');

    return { results, riskDetected: false };
  }

  /**
   * 滚动快手评论容器：hover 到 .el-main → 模拟鼠标滚轮
   */
  private async scrollCommentAreaForKuaishou(page: Page, direction: 'bottom' | 'top' | number): Promise<boolean> {
    const t0 = Date.now();
    const selectors = ['.el-main', 'main', '[class*="main-content"]'];

    return await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.dom.refreshDocument();

      // 找到滚动容器
      let containerRect: { x: number; y: number; width: number; height: number } | null = null;
      for (const sel of selectors) {
        const nodeId = await ctx.cdp.querySelector(sel);
        if (nodeId && nodeId > 0) {
          const box = await ctx.cdp.getBoxModel(nodeId);
          if (box && box.width > 0 && box.height > 0) {
            containerRect = { x: box.content[0], y: box.content[1], width: box.width, height: box.height };
            break;
          }
        }
      }

      if (!containerRect) {
        logger.warn('[scrollKuaishou] Container not found');
        return false;
      }

      // hover 到容器中心
      const hoverX = Math.round(containerRect.x + containerRect.width * (0.3 + Math.random() * 0.4));
      const hoverY = Math.round(containerRect.y + containerRect.height * (0.3 + Math.random() * 0.4));
      await ctx.mouse.moveTo({ x: hoverX, y: hoverY });
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

      // 滚动
      if (direction === 'top') {
        const scrollCount = 5 + Math.floor(Math.random() * 3);
        for (let i = 0; i < scrollCount; i++) {
          await ctx.mouse.dispatchWheel(0, -(1000 + Math.random() * 1000));
          await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        }
      } else if (direction === 'bottom') {
        const scrollCount = 5 + Math.floor(Math.random() * 3);
        for (let i = 0; i < scrollCount; i++) {
          await ctx.mouse.dispatchWheel(0, 1000 + Math.random() * 1000);
          await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        }
      } else {
        const dir = direction >= 0 ? 1 : -1;
        let remaining = Math.abs(direction);
        while (remaining > 0) {
          const step = Math.min(200 + Math.random() * 200, remaining);
          await ctx.mouse.dispatchWheel(0, step * dir);
          remaining -= step;
          await new Promise(r => setTimeout(r, 30 + Math.random() * 50));
        }
      }

      logger.info({ direction, totalMs: Date.now() - t0 }, '[scrollKuaishou] Completed');
      return true;
    });
  }

  private async openSelectVideoDrawer(page: Page): Promise<boolean> {
    const maxRetries = 2;
    const selectVideoDef = getSelector('page.select-video-btn', PLATFORM);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      logger.info({ attempt }, '[Drawer] Attempting to open kuaishou [选择视频] drawer');

      // 使用 tryClickBySelector 统一处理（text优先 + CSS回退）
      const clicked = await tryClickBySelector(page, selectVideoDef, { timeout: 10000 });

      if (clicked) {
        logger.info({ attempt }, '[Drawer] Button click succeeded, waiting for drawer');
        await HumanActions.wait(page, 1500, 3000);

        const drawerVisible = await this.isDrawerVisible(page);
        if (drawerVisible) {
          logger.info('[Drawer] Kuaishou drawer confirmed visible');
          return true;
        }

        logger.warn({ attempt }, '[Drawer] Click succeeded but drawer not detected, proceeding anyway');
        return true;
      } else {
        logger.warn({ attempt }, '[Drawer] All click methods failed');
        await HumanActions.wait(page, 1000, 2000);
      }
    }

    logger.error('[Drawer] Failed to open kuaishou drawer after all retries');
    return false;
  }

  private async isDrawerVisible(page: Page): Promise<boolean> {
    try {
      const selectVideoDef = getSelector('page.select-video-btn', PLATFORM);
      if (selectVideoDef.css) {
        const visible = await HumanActions.cdpIsElementVisible(page, selectVideoDef.css);
        if (visible) {
          logger.info({ selector: selectVideoDef.css }, 'Kuaishou drawer area detected via direct CSS');
          return true;
        }
      }

      // 使用管理的选择器检测抽屉
      const drawerDef = getSelector('drawer.container', PLATFORM);
      const drawerSelectors = [
        drawerDef.css,
        '[class*="drawer"]',
        '[class*="sidesheet"]',
        '[class*="modal"]',
        '[class*="select-video"]',
        '[class*="selectVideo"]',
      ].filter(Boolean) as string[];

      for (const selector of drawerSelectors) {
        const visible = await HumanActions.cdpIsElementVisible(page, selector);
        if (visible) {
          logger.info({ selector }, 'Kuaishou drawer detected as visible');
          return true;
        }
      }

      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        if (bodyText.includes('选择视频') && (bodyText.includes('评论数') || bodyText.includes('发布于'))) {
          logger.info('Kuaishou drawer content detected via body text');
          return true;
        }
      } catch {}

      return false;
    } catch {
      return false;
    }
  }

  private async closeDrawer(page: Page): Promise<boolean> {
    try {
      await HumanActions.cdpKeyPress(page, 'Escape', 'Escape', 27);
      await HumanActions.wait(page, 800, 1500);

      let drawerGone = !(await this.isDrawerVisible(page));

      if (!drawerGone) {
        const maskSelectors = [
          '[class*="mask"]',
          '[class*="overlay"]',
          '[class*="modal-mask"]',
        ];
        for (const selector of maskSelectors) {
          const visible = await HumanActions.cdpIsElementVisible(page, selector);
          if (visible) {
            await HumanActions.cdpClick(page, selector, { timeout: 3000 });
            await HumanActions.wait(page, 800, 1500);
            drawerGone = !(await this.isDrawerVisible(page));
            if (drawerGone) break;
          }
        }
      }

      if (drawerGone) {
        logger.info('[Drawer] Kuaishou drawer closed successfully');
      } else {
        logger.warn('[Drawer] Kuaishou drawer may still be visible after close attempts');
      }
      return drawerGone;
    } catch (error: any) {
      logger.warn({ error: error.message }, '[Drawer] Error closing kuaishou drawer');
      return false;
    }
  }

  private async findAndClickVideoInDrawer(
    page: Page,
    awemeId: string,
    description: string,
    createTime: number,
  ): Promise<boolean> {
    const MAX_SCROLL_ATTEMPTS = 100;
    const TIMESTAMP_TOLERANCE = 60;

    logger.info({ awemeId, createTime, descPrefix: description.substring(0, 20) }, '[Drawer] Searching for target video in drawer');

    for (let scrollAttempt = 0; scrollAttempt <= MAX_SCROLL_ATTEMPTS; scrollAttempt++) {
      await HumanActions.wait(page, 400, 700);

      // 在 page.evaluate 中遍历 .video-item 元素
      const matchResult = await page.evaluate(({ desc, createTimeNum, tolerance }: { desc: string; createTimeNum: number; tolerance: number }) => {
        const items = document.querySelectorAll('.video-item');
        let minTimestamp = Infinity;
        let maxTimestamp = -Infinity;
        let itemCount = 0;
        const timeDiffs: number[] = [];

        for (const item of items) {
          const titleEl = item.querySelector('.video-info__content__title');
          const dateEl = item.querySelector('.video-info__content__date');
          const title = titleEl?.textContent?.trim() || '';
          const dateText = dateEl?.textContent?.trim() || '';
          const fullText = title + ' ' + dateText;

          // 解析时间（快手格式：2026-05-28 09:03:19）
          const dateMatch = dateText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
          if (!dateMatch) continue;
          const [, y, m, d, h, min, s] = dateMatch;
          const domTimestamp = Math.floor(new Date(`${y}-${m}-${d}T${h}:${min}:${s}+08:00`).getTime() / 1000);

          itemCount++;
          if (domTimestamp < minTimestamp) minTimestamp = domTimestamp;
          if (domTimestamp > maxTimestamp) maxTimestamp = domTimestamp;
          timeDiffs.push(domTimestamp - createTimeNum);

          // 时间差判断
          if (Math.abs(domTimestamp - createTimeNum) > tolerance) continue;

          // description 前缀匹配
          const descPrefix = desc.toLowerCase().substring(0, 20);
          if (descPrefix.length > 0 && !fullText.toLowerCase().includes(descPrefix)) continue;

          // 匹配成功，点击 detail 区域
          const detailEl = item.querySelector('.video-info__content__detail') || item.querySelector('.video-info__content');
          if (detailEl) {
            (detailEl as HTMLElement).click();
            return { found: true, domTimestamp, title: title.substring(0, 50), itemCount, minTimestamp, maxTimestamp, timeDiffs };
          }
        }

        // 如果所有已加载视频的时间都早于目标时间，说明已经滚动过头了
        if (minTimestamp < createTimeNum - tolerance) {
          return { found: false, scrolledPast: true, itemCount, minTimestamp, maxTimestamp, timeDiffs };
        }

        return { found: false, scrolledPast: false, itemCount, minTimestamp, maxTimestamp, timeDiffs };
      }, { desc: description, createTimeNum: createTime, tolerance: TIMESTAMP_TOLERANCE });

      logger.info({ scrollAttempt, loadedItems: matchResult.itemCount, latestDate: matchResult.maxTimestamp, oldestDate: matchResult.minTimestamp, targetCreateTime: createTime }, '[Drawer] Scroll diagnostic');

      if (matchResult.found) {
        logger.info({ awemeId, domTimestamp: matchResult.domTimestamp, createTime, matchType: 'timestamp+description' }, '[Drawer] 匹配成功');
        return true;
      }

      // 如果已滚动过头，提前终止
      if (matchResult.scrolledPast) {
        logger.warn({ awemeId, createTime, oldestTimestamp: matchResult.minTimestamp }, '[Drawer] 已滚动过头，停止搜索');
        break;
      }

      // 未匹配，滚动加载更多
      if (scrollAttempt < MAX_SCROLL_ATTEMPTS) {
        logger.info({ scrollAttempt }, '[Drawer] 未匹配，滚动加载更多');
        await this.scrollDrawerForMoreKuaishou(page, scrollAttempt);
      }
    }

    logger.warn({ awemeId, maxScrolls: MAX_SCROLL_ATTEMPTS }, '[Drawer] 滚动穷尽仍未匹配');
    return false;
  }

  private async scrollDrawerForMoreKuaishou(page: Page, scrollAttempt: number): Promise<void> {
    const SCROLL_CONTAINER = '.auto-load-list';
    const drawerScrollSelectors = ['.el-drawer__body', '.drawer__content', SCROLL_CONTAINER];
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.dom.refreshDocument();
      let containerRect: { x: number; y: number; width: number; height: number } | null = null;
      for (const sel of drawerScrollSelectors) {
        const nodeId = await ctx.cdp.querySelector(sel);
        if (nodeId && nodeId > 0) {
          const box = await ctx.cdp.getBoxModel(nodeId);
          if (box && box.width > 0 && box.height > 0) {
            containerRect = { x: box.content[0], y: box.content[1], width: box.width, height: box.height };
            break;
          }
        }
      }
      if (containerRect) {
        const hoverX = Math.round(containerRect.x + containerRect.width * (0.3 + Math.random() * 0.4));
        const hoverY = Math.round(containerRect.y + containerRect.height * (0.3 + Math.random() * 0.4));
        await ctx.mouse.moveTo({ x: hoverX, y: hoverY });
        await new Promise(r => setTimeout(r, 150 + Math.random() * 200));
        for (let i = 0; i < 2; i++) {
          await ctx.mouse.dispatchWheel(0, 200 + Math.random() * 150);
          await new Promise(r => setTimeout(r, 100 + Math.random() * 150));
        }
      }
    });
    await HumanActions.wait(page, 1500, 2500);
  }

  private async waitForCommentResponse(page: Page): Promise<InterceptedResponse | null> {
    const timeout = 20000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const responses = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
      if (responses.length > 0) {
        const latest = responses[responses.length - 1];
        logger.info({ awemeId: '(current)', responseTime: Date.now() - startTime }, '[Phase3] Kuaishou comment API response captured');
        return latest;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    logger.warn({ timeout }, '[Phase3] Kuaishou comment API response wait timed out');
    return null;
  }

  private parseCommentList(body: any): CommentInfo[] {
    try {
      const comments = body?.data?.commentList || body?.data?.rootComments || body?.data?.commentInfoList || body?.data?.list || body?.data?.comments || body?.data?.items || body?.comments || [];
      if (!Array.isArray(comments)) return [];

      const rootComments = comments.filter((c: any) => {
        const replyId = c.replyId ?? c.reply_id ?? '0';
        return replyId === 0 || replyId === '0' || replyId === null || replyId === undefined;
      });

      logger.info({ totalReceived: comments.length, rootComments: rootComments.length }, 'Kuaishou root comment filter applied');

      logger.debug({ bodyKeys: Object.keys(body || {}), dataKeys: Object.keys(body?.data || {}), firstComment: comments[0] ? JSON.stringify(comments[0]).slice(0, 500) : 'none' }, 'Kuaishou comment API raw structure');

      return rootComments.map((c: any) => {
        let rawTime = c.timestamp || c.createTime || c.created_at || 0;
        if (rawTime > 1e12) rawTime = Math.floor(rawTime / 1000);
        if (rawTime === 0) rawTime = Math.floor(Date.now() / 1000);
        return {
          cid: c.commentId || c.comment_id || c.id || c.cid || '',
          text: c.content || c.text || c.message || '',
          user_nickname: c.userName || c.user_name || c.author?.name || c.user?.name || c.nickname || '',
          user_uid: c.userId || c.user_id || c.author?.id || c.user?.id || c.authorId || '',
          digg_count: c.likeCount || c.like_count || c.likedCount || c.diggCount || c.likeNum || 0,
          create_time: rawTime,
          reply_id: String(c.replyId ?? c.reply_id ?? '0'),
        };
      });
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to parse kuaishou comment list');
      return [];
    }
  }

  private parseRootCommentSnapshots(body: any): RootCommentSnapshot[] {
    const comments: any[] = body?.data?.commentList || body?.data?.rootComments ||
                            body?.data?.commentInfoList || body?.data?.list || body?.data?.comments || [];
    return comments
      .filter((c: any) => c.replyTo === 0 || c.replyTo === '0' || c.replyTo === null || c.replyTo === undefined)
      .map((c: any) => ({
        cid: String(c.commentId || c.comment_id || ''),
        text: c.content || c.text || '',
        replyCount: c.subCommentCount ?? 0,
        createTime: c.timestamp > 1e12 ? Math.floor(c.timestamp / 1000) : c.timestamp,
        userUid: String(c.authorId || c.userId || ''),
        userNickname: c.authorName || c.userName || '',
      }));
  }

  private async saveRootCommentSnapshots(videoId: string): Promise<RootCommentSnapshot[]> {
    const response = await this.waitForCommentResponse(this.page!);
    if (!response?.body) {
      logger.warn({ videoId }, 'No kuaishou comment API response for snapshots');
      return [];
    }
    const snapshots = this.parseRootCommentSnapshots(response.body);
    if (snapshots.length > 0) {
      await db.upsertRootCommentCounts(videoId, snapshots.map(s => ({
        cid: s.cid,
        replyCount: s.replyCount,
      })));
    }
    return snapshots;
  }

  // ════════════════════════════════════════
  // 回复相关
  // ════════════════════════════════════════

  /**
   * 直接导航到评论管理页面（用于回复流程）
   */
  async navigateToCommentPageDirect(page: Page): Promise<boolean> {
    return this.navigateToCommentManage(page);
  }

  /**
   * 选择目标视频（用于回复流程）
   */
  async selectVideoForReply(page: Page, videoId: string, videoDescription: string, createTime: number): Promise<boolean> {
    const drawerOpened = await this.openSelectVideoDrawer(page);
    if (!drawerOpened) {
      logger.error('[Reply] Failed to open video selection drawer');
      return false;
    }
    const clicked = await this.findAndClickVideoInDrawer(page, videoId, videoDescription, createTime);
    if (clicked) {
      await HumanActions.wait(page, 1500, 3000);
    }
    return clicked;
  }

  /**
   * 在 page 上下文注入 esbuild 留下的 __name helper（tsx 默认 keepNames: true 会注入）
   * 必须在任何 page.evaluate 之前调用一次
   */
  private async injectEsbuildPolyfill(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        // @ts-ignore: 故意挂在 window 上
        if (typeof (window as any).__name === 'undefined') {
          (window as any).__name = (target: any, value: string) =>
            Object.defineProperty(target, 'name', { value, configurable: true });
        }
      });
    } catch {
      // 注入失败不影响主流程
    }
  }

  /**
   * 回复评论
   * 通过 commentCid 或 commentText 定位目标评论后点击该评论的回复按钮，
   * 然后在同一个评论容器内查找输入框和发送按钮，避免误操作其他评论。
   */
  async replyToComment(page: Page, target: KuaishouReplyTarget, replyText: string, executionId?: string): Promise<boolean> {
    logger.info({ 
      commentCid: target.commentCid, 
      text: target.text?.slice(0, 30), 
      username: target.username,
      level: target.level,
      textLength: replyText.length 
    }, '[Reply] Starting reply');

    // ── 调试模式初始化 ──
    const debugEnabled = await isDebugModeEnabled();
    let manifest: DebugManifest | null = null;
    let sessionId = '';
    let stepIdx = 0;

    if (debugEnabled) {
      sessionId = createReplySessionId({
        text: target.text,
        level: target.level,
        createTime: target.createTime || 0,
      });
      manifest = createManifest(sessionId, {
        text: target.text,
        level: target.level,
        createTime: target.createTime || 0,
      });
      logger.info({ sessionId }, '[Reply] Debug mode enabled, snapshots will be saved');
    }

    let currentPhase = '';
    const snap = async (label: string, extra?: Record<string, any>) => {
      if (manifest) {
        stepIdx++;
        await saveDebugSnapshot({ page, stepLabel: label, sessionId, stepIndex: stepIdx, manifest, extra });
        if (executionId) {
          await recordSelectorTry(executionId, label, {
            phase: currentPhase,
            selectors: extra?.selectors || [],
            mouseAction: extra?.mouseAction,
            extra: extra?.context,
          }).catch(() => {});
        }
      }
    };

    try {
      // 注入 esbuild polyfill，防止 __name is not defined 错误
      await this.injectEsbuildPolyfill(page);
      await HumanActions.thinkingPause(page, 800, 2000);
      currentPhase = '准备';
      await snap('reply_start');

      // ── Step 0: 定位根评论容器并展开子评论 ──
      // 策略：先找到根评论容器，然后在该容器内展开子评论
      const expandPattern = /展开(查看)?\d+条回复/;
      
      // 查找所有根评论容器，找到目标根评论
      const rootCommentInfo = await page.evaluate((target: {
        cid: string; text: string; username: string; level: number;
        subReplyCount?: number; rootText?: string; rootUsername?: string;
      }) => {
        const rootContainers = Array.from(document.querySelectorAll('.comment-item')) as HTMLElement[];
        
        /** 去装饰子元素 */
        function bareUsernameText(el: HTMLElement): string {
          const clone = el.cloneNode(true) as HTMLElement;
          const ch = clone.children;
          for (let i = ch.length - 1; i >= 0; i--) ch[i].remove();
          return (clone.textContent || '').trim().toLowerCase();
        }
        
        /** 查找容器内的子评论数（只看直接子代的expand-btn，避免嵌套子评论） */
        function findSubReplyCount(container: HTMLElement): number {
          const contentEl = container.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return 0;
          const expandBtn = contentEl.querySelector(':scope > .comment-item__content__expand-btn');
          if (expandBtn) {
            const match = (expandBtn.textContent || '').match(/(\d+)条回复/);
            if (match) return parseInt(match[1], 10);
          }
          return 0;
        }
        
        /** 查找容器内的评论正文（只取直接子代，避免嵌套子评论混入） */
        function findCommentText(container: HTMLElement): string {
          const contentEl = container.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return '';
          const detailEl = contentEl.querySelector(':scope > .comment-content__detail') as HTMLElement;
          if (!detailEl) return '';
          const span = detailEl.querySelector(':scope > span');
          return ((span?.textContent) || detailEl.textContent || '').trim();
        }
        
        /** 查找容器内的评论用户名
         * 根评论结构: <username>UserA<span class="author-tag">作者</span></username>
         * 子评论结构: <username>UserA<span class="reply">回复</span>UserB:</username>
         * 都需要只取第一个文本节点（在第一个元素子节点之前的文本）
         */
        function findUsername(container: HTMLElement): string {
          const contentEl = container.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return '';
          const usernameEl = contentEl.querySelector(':scope > .comment-content__username') as HTMLElement;
          if (!usernameEl) return '';
          let text = '';
          for (const node of Array.from(usernameEl.childNodes)) {
            if (node.nodeType === 1) break;
            if (node.nodeType === 3) text += node.textContent || '';
          }
          return text.trim().toLowerCase();
        }

        // 对于子评论（level=2），先找到根评论
        if (target.level === 2 && target.rootText && target.rootUsername) {
          for (let i = 0; i < rootContainers.length; i++) {
            const c = rootContainers[i];
            const rootUsername = findUsername(c);
            const rootText = findCommentText(c);
            
            const rootUsernameMatch = rootUsername === target.rootUsername!.toLowerCase();
            
            // 精确匹配根评论内容（不使用includes，避免"12"匹配"1312"）
            const rootTextMatch = rootText && (rootText === target.rootText! || 
              (rootText.length > 5 && target.rootText!.length > 5 &&
               (rootText.includes(target.rootText!) || target.rootText!.includes(rootText))));
            
            if (rootUsernameMatch && rootTextMatch) {
              const rect = c.getBoundingClientRect();
              return {
                index: i,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                method: 'root-found-for-sub',
              };
            }
          }
        }
        
        // 对于根评论（level=1），使用三重匹配
        if (target.level === 1) {
          for (let i = 0; i < rootContainers.length; i++) {
            const c = rootContainers[i];
            const username = findUsername(c);
            const commentText = findCommentText(c);
            const subReplyCount = findSubReplyCount(c);
            
            const usernameMatch = target.username && username === target.username.toLowerCase();
            
            // 精确匹配评论内容（不使用includes，避免"12"匹配"1312"）
            const textMatch = target.text && commentText &&
              (commentText === target.text || 
               (commentText.length > 5 && target.text.length > 5 && 
                (commentText.includes(target.text) || target.text.includes(commentText))));
            
            const countMatch = target.subReplyCount !== undefined && subReplyCount === target.subReplyCount;
            
            if (usernameMatch && textMatch && countMatch) {
              const rect = c.getBoundingClientRect();
              return {
                index: i,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                method: 'triple-match-root',
              };
            }
            
            if (usernameMatch && textMatch) {
              const rect = c.getBoundingClientRect();
              return {
                index: i,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                method: 'username-text-match-root',
              };
            }
          }
        }
        
        return null;
      }, target as any);

      if (!rootCommentInfo) {
        await snap('root_comment_not_found');
        if (manifest) finishManifest(manifest, false);
        logger.error({ target }, '[Reply] Root comment not found');
        return false;
      }

      logger.info({ method: rootCommentInfo.method, index: rootCommentInfo.index }, '[Reply] Found root comment container');
      
      // ★ 关键：找到根评论后立刻把它滚到视口中央
      // 借鉴评论树爬取方案：快手评论页的滚动容器是 .el-main，需要操作容器的 scrollTop
      // 用元素的 scrollIntoView 会自动找到最近的可滚动祖先（.el-main）并滚动它
      const scrollResult = await page.evaluate((rootIndex: number) => {
        const rootContainers = document.querySelectorAll('.comment-item');
        if (rootIndex >= rootContainers.length) return { ok: false, reason: 'index-out-of-range' };
        const rootContainer = rootContainers[rootIndex] as HTMLElement;
        
        // 找到真正的滚动容器（.el-main 或其他可滚动祖先）
        let scrollContainer: HTMLElement | null = null;
        let cur: HTMLElement | null = rootContainer.parentElement;
        while (cur) {
          const overflowY = getComputedStyle(cur).overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
            scrollContainer = cur;
            break;
          }
          cur = cur.parentElement;
        }
        
        if (!scrollContainer) {
          // 兜底：用 scrollIntoView
          rootContainer.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
          return { ok: true, method: 'scrollIntoView', containerSelector: null as string | null };
        }
        
        // 计算目标滚动位置：让根评论显示在容器中央
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = rootContainer.getBoundingClientRect();
        // 当前根评论 top（相对容器顶部）= targetRect.top - containerRect.top + scrollContainer.scrollTop
        const currentTopInContainer = targetRect.top - containerRect.top + scrollContainer.scrollTop;
        // 目标 scrollTop = currentTopInContainer - (containerHeight / 2) + (targetHeight / 2)
        const desiredScrollTop = currentTopInContainer - scrollContainer.clientHeight / 2 + targetRect.height / 2;
        
        scrollContainer.scrollTop = Math.max(0, desiredScrollTop);
        
        return { 
          ok: true, 
          method: 'scrollTop',
          containerSelector: scrollContainer.className || scrollContainer.tagName,
          desiredScrollTop: Math.round(desiredScrollTop),
          containerScrollHeight: scrollContainer.scrollHeight,
          containerClientHeight: scrollContainer.clientHeight,
        };
      }, rootCommentInfo.index);
      logger.info({ scrollResult }, '[Reply] Scrolled root comment into view');
      await HumanActions.wait(page, 1000, 1500);
      
      currentPhase = '定位评论';
      await snap('root_comment_found', { method: rootCommentInfo.method, index: rootCommentInfo.index, scroll: scrollResult });

      // 在目标根评论容器内展开子评论
      if (target.level === 2) {
        let totalExpanded = 0;
        
        // 循环展开子评论（最多20轮，处理大量子评论的情况）
        for (let expandRound = 0; expandRound < 20; expandRound++) {
          // 在目标根评论容器内查找展开按钮
          const expandButton = await page.evaluate((args: { rootIndex: number; pattern: string }) => {
            const { rootIndex, pattern } = args;
            const regex = new RegExp(pattern);
            const rootContainers = document.querySelectorAll('.comment-item');
            if (rootIndex >= rootContainers.length) return null;
            
            const rootContainer = rootContainers[rootIndex] as HTMLElement;
            const all = Array.from(rootContainer.querySelectorAll('*'));
            
            for (const el of all) {
              const t = (el.textContent || '').trim();
              if (!regex.test(t) || !(el instanceof HTMLElement)) continue;
              const isLeaf = !Array.from(el.children).some(child => regex.test((child.textContent || '').trim()));
              if (!isLeaf) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
              };
            }
            return null;
          }, { rootIndex: rootCommentInfo.index, pattern: expandPattern.source });

          if (!expandButton) {
            logger.info({ round: expandRound + 1 }, '[Reply] No more expand buttons found');
            break;
          }

          // 如果按钮不在视口内，用 scrollIntoView 把按钮滚到视口中央
          if (!expandButton.visible) {
            await page.evaluate((args: { rootIndex: number; pattern: string }) => {
              const { rootIndex, pattern } = args;
              const regex = new RegExp(pattern);
              const rootContainers = document.querySelectorAll('.comment-item');
              if (rootIndex >= rootContainers.length) return;
              const rootContainer = rootContainers[rootIndex] as HTMLElement;
              const all = Array.from(rootContainer.querySelectorAll('*'));
              for (const el of all) {
                const t = (el.textContent || '').trim();
                if (!regex.test(t) || !(el instanceof HTMLElement)) continue;
                const isLeaf = !Array.from(el.children).some(child => regex.test((child.textContent || '').trim()));
                if (!isLeaf) continue;
                el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
                return;
              }
            }, { rootIndex: rootCommentInfo.index, pattern: expandPattern.source });
            await HumanActions.wait(page, 600, 1000);
            
            // 重新获取按钮坐标（滚动后坐标变了）
            const refreshed = await page.evaluate((args: { rootIndex: number; pattern: string }) => {
              const { rootIndex, pattern } = args;
              const regex = new RegExp(pattern);
              const rootContainers = document.querySelectorAll('.comment-item');
              if (rootIndex >= rootContainers.length) return null;
              const rootContainer = rootContainers[rootIndex] as HTMLElement;
              const all = Array.from(rootContainer.querySelectorAll('*'));
              for (const el of all) {
                const t = (el.textContent || '').trim();
                if (!regex.test(t) || !(el instanceof HTMLElement)) continue;
                const isLeaf = !Array.from(el.children).some(child => regex.test((child.textContent || '').trim()));
                if (!isLeaf) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                return {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                };
              }
              return null;
            }, { rootIndex: rootCommentInfo.index, pattern: expandPattern.source });
            if (refreshed) {
              expandButton.x = refreshed.x;
              expandButton.y = refreshed.y;
            }
          }

          logger.info({ round: expandRound + 1, x: expandButton.x, y: expandButton.y }, '[Reply] Clicking expand button');
          await HumanActions.clickAtCoordinates(page, expandButton.x, expandButton.y);
          await HumanActions.wait(page, 1500, 2500);
          totalExpanded++;
          
          // 等待子评论加载完成
          await HumanActions.wait(page, 1000, 1500);
        }

        if (totalExpanded > 0) {
          currentPhase = '展开子评论';
      await snap('expanded_sub_comments_in_root', { totalExpanded });
          logger.info({ totalExpanded }, '[Reply] Expanded sub-comments in target root comment');
        }
      }

      // ── Step 1: 在根评论容器内定位目标评论的回复按钮 ──
      const locateResult = await page.evaluate((args: {
        target: {
          cid: string; text: string; username: string; level: number;
          subReplyCount?: number; rootText?: string; rootUsername?: string;
        };
        rootIndex: number;
      }) => {
        const { target, rootIndex } = args;
        const rootContainers = document.querySelectorAll('.comment-item');
        if (rootIndex >= rootContainers.length) return null;
        const rootContainer = rootContainers[rootIndex] as HTMLElement;
        
        /** 去装饰子元素 */
        function bareUsernameText(el: HTMLElement): string {
          const clone = el.cloneNode(true) as HTMLElement;
          const ch = clone.children;
          for (let i = ch.length - 1; i >= 0; i--) ch[i].remove();
          return (clone.textContent || '').trim().toLowerCase();
        }
        
        /** 在容器内查找"回复"按钮（只查找直接子代的btns，避免嵌套子评论） */
        const findReplyBtn = (el: HTMLElement): { x: number; y: number; width: number; height: number } | null => {
          // 直接子代的 .comment-content > .comment-content__btns
          const contentEl = el.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return null;
          const btnsContainer = contentEl.querySelector(':scope > .comment-content__btns') as HTMLElement;
          if (!btnsContainer) return null;
          
          // 优先：通过 .icon-reply 找
          const replyIcon = btnsContainer.querySelector('.icon-reply') as HTMLElement;
          if (replyIcon) {
            const btnWrapper = replyIcon.closest('.comment-content__btns__btn') as HTMLElement;
            if (btnWrapper) {
              const r = btnWrapper.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
          // 次选：按文本"回复"找
          const btns = btnsContainer.querySelectorAll(':scope > .comment-content__btns__btn');
          for (const btn of Array.from(btns)) {
            if ((btn.textContent || '').trim().includes('回复')) {
              const r = (btn as HTMLElement).getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
          return null;
        };
        
        /** 查找容器内的评论正文（只取直接子代的 detail，避免嵌套） */
        function findCommentText(container: HTMLElement): string {
          // 直接子代 .comment-content > .comment-content__detail
          const contentEl = container.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return '';
          const detailEl = contentEl.querySelector(':scope > .comment-content__detail') as HTMLElement;
          if (!detailEl) return '';
          // 只取 detail 内 span 的文本（评论正文在第一个span里）
          const span = detailEl.querySelector(':scope > span');
          return ((span?.textContent) || detailEl.textContent || '').trim();
        }
        
        /** 查找容器内的评论用户名
         * 根评论结构: <username>UserA<span class="author-tag">作者</span></username>
         * 子评论结构: <username>UserA<span class="reply">回复</span>UserB:</username>
         * 都需要只取第一个文本节点（去掉所有子元素后的"第一段"文本）
         */
        function findUsername(container: HTMLElement): string {
          // 直接子代 .comment-content > .comment-content__username
          const contentEl = container.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return '';
          const usernameEl = contentEl.querySelector(':scope > .comment-content__username') as HTMLElement;
          if (!usernameEl) return '';
          
          // 遍历子节点，取第一个文本节点（在第一个元素子节点之前的文本）
          let text = '';
          for (const node of Array.from(usernameEl.childNodes)) {
            if (node.nodeType === 1) break; // 遇到元素节点就停（如<span>回复</span>或<span>作者</span>）
            if (node.nodeType === 3) {       // 文本节点
              text += node.textContent || '';
            }
          }
          return text.trim().toLowerCase();
        }

        // 对于根评论（level=1），直接在根评论容器内找回复按钮
        if (target.level === 1) {
          const commentText = findCommentText(rootContainer);
          const username = findUsername(rootContainer);
          
          // 精确匹配评论内容（不使用includes，避免"12"匹配"1312"）
          const textMatch = target.text && commentText &&
            (commentText === target.text || 
             (commentText.length > 5 && target.text.length > 5 &&
              (commentText.includes(target.text) || target.text.includes(commentText))));
          const usernameMatch = target.username && username === target.username.toLowerCase();
          
          if (textMatch && usernameMatch) {
            return findReplyBtn(rootContainer);
          }
        }
        
        // 对于子评论（level=2），在根评论的子评论容器内搜索
        if (target.level === 2) {
          const subCommentContainer = rootContainer.querySelector('.comment-item__content__sub-comments');
          if (!subCommentContainer) return null;
          
          const subItems = subCommentContainer.querySelectorAll('.comment-sub-item');
          for (const subC of Array.from(subItems)) {
            const subUsername = findUsername(subC as HTMLElement);
            const subText = findCommentText(subC as HTMLElement);
            
            const subUsernameMatch = target.username && subUsername === target.username.toLowerCase();
            
            // 精确匹配子评论内容（不使用includes，避免"12"匹配"1312"）
            const subTextMatch = target.text && subText &&
              (subText === target.text || 
               (subText.length > 5 && target.text.length > 5 &&
                (subText.includes(target.text) || target.text.includes(subText))));
            
            if (subUsernameMatch && subTextMatch) {
              // ★ 关键：把子评论滚到视口中央，再返回回复按钮坐标
              (subC as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
              return findReplyBtn(subC as HTMLElement);
            }
          }
        }
        
        return null;
      }, { target: target as any, rootIndex: rootCommentInfo.index });

      if (!locateResult) {
        await snap('reply_button_not_found');
        if (manifest) finishManifest(manifest, false);
        logger.error({ target }, '[Reply] Reply button not found in root comment container');
        return false;
      }

      // 等待 scrollIntoView 完成
      await HumanActions.wait(page, 400, 700);

      // 重新获取按钮坐标（滚动后坐标可能已经变了）
      const freshRect = await page.evaluate((args: {
        target: { text: string; username: string; level: number; rootText?: string; rootUsername?: string };
        rootIndex: number;
      }) => {
        const { target, rootIndex } = args;
        const rootContainers = document.querySelectorAll('.comment-item');
        if (rootIndex >= rootContainers.length) return null;
        const rootContainer = rootContainers[rootIndex] as HTMLElement;
        
        function findUsername(container: HTMLElement): string {
          const contentEl = container.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return '';
          const usernameEl = contentEl.querySelector(':scope > .comment-content__username') as HTMLElement;
          if (!usernameEl) return '';
          let text = '';
          for (const node of Array.from(usernameEl.childNodes)) {
            if (node.nodeType === 1) break;
            if (node.nodeType === 3) text += node.textContent || '';
          }
          return text.trim().toLowerCase();
        }
        function findCommentText(container: HTMLElement): string {
          const contentEl = container.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return '';
          const detailEl = contentEl.querySelector(':scope > .comment-content__detail') as HTMLElement;
          if (!detailEl) return '';
          const span = detailEl.querySelector(':scope > span');
          return ((span?.textContent) || detailEl.textContent || '').trim();
        }
        function getReplyBtnRect(el: HTMLElement) {
          const contentEl = el.querySelector(':scope > .comment-content') as HTMLElement;
          if (!contentEl) return null;
          const btnsContainer = contentEl.querySelector(':scope > .comment-content__btns') as HTMLElement;
          if (!btnsContainer) return null;
          const replyIcon = btnsContainer.querySelector('.icon-reply') as HTMLElement;
          if (replyIcon) {
            const btn = replyIcon.closest('.comment-content__btns__btn') as HTMLElement;
            if (btn) {
              const r = btn.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
          const btns = btnsContainer.querySelectorAll(':scope > .comment-content__btns__btn');
          for (const btn of Array.from(btns)) {
            if ((btn.textContent || '').trim().includes('回复')) {
              const r = (btn as HTMLElement).getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
          return null;
        }
        
        if (target.level === 1) {
          rootContainer.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
          return getReplyBtnRect(rootContainer);
        }
        if (target.level === 2) {
          const subCommentContainer = rootContainer.querySelector('.comment-item__content__sub-comments');
          if (!subCommentContainer) return null;
          const subItems = subCommentContainer.querySelectorAll('.comment-sub-item');
          for (const subC of Array.from(subItems)) {
            const subUsername = findUsername(subC as HTMLElement);
            const subText = findCommentText(subC as HTMLElement);
            const subUsernameMatch = target.username && subUsername === target.username.toLowerCase();
            const subTextMatch = target.text && subText &&
              (subText === target.text || 
               (subText.length > 5 && target.text.length > 5 &&
                (subText.includes(target.text) || target.text.includes(subText))));
            if (subUsernameMatch && subTextMatch) {
              (subC as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
              return getReplyBtnRect(subC as HTMLElement);
            }
          }
        }
        return null;
      }, { target: target as any, rootIndex: rootCommentInfo.index });

      const finalRect = freshRect || locateResult;
      currentPhase = '执行回复';
      await snap('reply_button_found', { 
        method: 'in-root-container', 
        level: target.level,
        x: Math.round(finalRect.x), 
        y: Math.round(finalRect.y) 
      });
      logger.info({ level: target.level, x: Math.round(finalRect.x), y: Math.round(finalRect.y) }, '[Reply] Located reply button (after scrollIntoView)');

      // ── Step 2: CDP 点击目标评论的回复按钮 ──
      const clickX = finalRect.x + finalRect.width / 2;
      const clickY = finalRect.y + finalRect.height / 2;
      await HumanActions.clickAtCoordinates(page, clickX, clickY);
      await HumanActions.wait(page, 800, 1500);
      await snap('clicked_reply_button', { x: Math.round(clickX), y: Math.round(clickY) });

      // ── Step 3: 定位并点击回复输入框 ──
      // 点击回复后，对应评论内的 .comment-input__wrapper 从 display:none 变为可见
      // 输入框为 .comment-input [contenteditable="true"]
      const inputRect = await page.evaluate(() => {
        // 优先：查找可见的 .comment-input__wrapper 内的 .comment-input
        const wrappers = Array.from(document.querySelectorAll('.comment-input__wrapper')) as HTMLElement[];
        for (let i = wrappers.length - 1; i >= 0; i--) {
          const w = wrappers[i];
          // 跳过 display:none 的 wrapper
          if (w.style.display === 'none' || getComputedStyle(w).display === 'none') continue;
          const input = w.querySelector('.comment-input') as HTMLElement;
          if (input) {
            const r = input.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
        // 回退：查找所有可见的 contenteditable div（排除顶部发表评论输入框）
        const candidates = Array.from(document.querySelectorAll('div[contenteditable="true"]')) as HTMLElement[];
        for (let i = candidates.length - 1; i >= 0; i--) {
          const el = candidates[i];
          // 跳过顶部发表评论输入框（class 含 author-comment-input）
          if (el.closest('.author-comment-input')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return null;
      });

      if (!inputRect) {
        await snap('reply_input_not_found');
        if (manifest) finishManifest(manifest, false);
        logger.error('[Reply] Reply input not found');
        return false;
      }

      currentPhase = '输入回复';
      await snap('reply_input_found', { x: Math.round(inputRect.x), y: Math.round(inputRect.y) });
      await HumanActions.clickAtCoordinates(page, inputRect.x + inputRect.width / 2, inputRect.y + inputRect.height / 2);
      await HumanActions.wait(page, 300, 600);
      await snap('clicked_reply_input');

      // ── Step 4: 输入回复内容 ──
      await HumanActions.safeCDPType(page, replyText);
      await HumanActions.wait(page, 500, 1200);
      await snap('typed_reply_text');

      // ── Step 5: 定位并点击确认发送按钮 ──
      // 快手评论回复的提交按钮是 .comment-btn.sure-btn，文本为 "确认"（不是 "发送"）
      const submitRect = await page.evaluate(() => {
        // 优先：精确查找 .sure-btn
        const sureBtn = document.querySelector('.sure-btn') as HTMLElement;
        if (sureBtn) {
          const r = sureBtn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        // 次选：在可见的 .comment-input__wrapper__control 内查找 .comment-btn（非"取消"的那个）
        const wrappers = Array.from(document.querySelectorAll('.comment-input__wrapper__control')) as HTMLElement[];
        for (const w of wrappers) {
          if (w.style.display === 'none' || getComputedStyle(w).display === 'none') continue;
          const btns = w.querySelectorAll('.comment-btn');
          for (const btn of Array.from(btns)) {
            const text = (btn.textContent || '').trim();
            if (text === '确认' || text === '发送') {
              const r = (btn as HTMLElement).getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
        }
        // 回退：按文本 "确认" 查找
        const allBtns = Array.from(document.querySelectorAll('span, button, div')).filter(
          (n) => (n.textContent || '').trim() === '确认'
        ) as HTMLElement[];
        for (let i = allBtns.length - 1; i >= 0; i--) {
          const r = allBtns[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return null;
      });

      if (submitRect) {
        currentPhase = '提交回复';
      await snap('submit_button_found', { x: Math.round(submitRect.x), y: Math.round(submitRect.y) });
        await HumanActions.clickAtCoordinates(page, submitRect.x + submitRect.width / 2, submitRect.y + submitRect.height / 2);
        await snap('clicked_submit_button');
      } else {
        await snap('submit_button_not_found');
        logger.warn('[Reply] Submit button not found');
      }

      await HumanActions.wait(page, 1500, 3000);
      await HumanActions.betweenActionsPause(page);

      await snap('reply_completed');
      if (manifest) finishManifest(manifest, true);
      logger.info({ commentCid: target.commentCid, submitClicked: !!submitRect }, '[Reply] Reply sent');
      return true;
    } catch (err: any) {
      await snap('error', { message: err.message });
      if (manifest) finishManifest(manifest, false);
      logger.error({ error: err.message, commentCid: target.commentCid }, '[Reply] Reply failed');
      return false;
    }
  }

  // ════════════════════════════════════════
  // Phase3 Simple Mode
  // ════════════════════════════════════════

  /**
   * 收集所有分页的 commentList API 响应（简单模式用）
   */
  private async collectAllCommentResponses(page: Page): Promise<InterceptedResponse[]> {
    const allResponses: InterceptedResponse[] = [];
    let response = await this.waitForCommentResponse(page);
    if (!response) return [];
    allResponses.push(response);

    const MAX_COMMENT_PAGES = 10;
    for (let pageNum = 1; pageNum < MAX_COMMENT_PAGES; pageNum++) {
      const lastResp = allResponses[allResponses.length - 1];
      const pcursor = lastResp?.body?.data?.pcursor;
      if (!pcursor) {
        logger.info({ pages: allResponses.length }, '[Simple] All comment pages loaded');
        break;
      }

      logger.info({ page: pageNum + 1, cursor: pcursor }, '[Simple] Scrolling to load more comments');

      const scrolled = await this.scrollCommentAreaForKuaishou(page, 'bottom');
      if (!scrolled) {
        await HumanActions.cdpSmartScroll(page, ['.el-main', 'main'], 500, 'down');
      }
      await HumanActions.wait(page, 1500, 2500);

      response = await this.waitForCommentResponse(page);
      if (response) {
        allResponses.push(response);
      } else {
        logger.info({ page: pageNum + 1 }, '[Simple] No more comment responses');
        break;
      }
    }

    return allResponses;
  }

  /**
   * 简单模式 Phase3：仅采集根评论（最多 30 条）
   * 使用纯 CID 去重，不采集子评论内容
   */
  async processCommentsQueueSimple(
    page: Page,
    queue: KuaishouCommentQueueItem[],
    maxRootComments: number = 30,
  ): Promise<{ results: Array<{ awemeId: string; success: boolean; commentGroups?: any[]; error?: string }> }> {
    const results: Array<{ awemeId: string; success: boolean; commentGroups?: any[]; error?: string }> = [];

    for (const item of queue) {
      try {
        logger.info({ awemeId: item.awemeId, maxRootComments }, '[Simple] Starting simple mode comment collection');

        // ── 清空拦截器中旧的评论响应 ──
        for (const p of ALL_KUAISHOU_COMMENT_PATTERNS) {
          this.interceptor.clear(p);
        }

        // ── 打开抽屉 ──
        const drawerOpened = await this.openSelectVideoDrawer(page);
        if (!drawerOpened) {
          logger.warn({ awemeId: item.awemeId }, '[Simple] Failed to open drawer, skipping');
          results.push({ awemeId: item.awemeId, success: false, error: 'Failed to open drawer' });
          continue;
        }

        // ── 点击视频 ──
        const clicked = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description, item.createTime);
        if (!clicked) {
          logger.warn({ awemeId: item.awemeId }, '[Simple] Failed to click video, skipping');
          results.push({ awemeId: item.awemeId, success: false, error: 'Failed to click video' });
          continue;
        }

        // ── 等待 API 响应 ──
        await HumanActions.wait(page, 3000, 5000);

        // 1. 获取已有的根评论 CID 集合
        const existingCids = await prisma.comment.findMany({
          where: { videoId: item.awemeId, level: 1 },
          select: { cid: true },
        });
        const existingCidSet = new Set(existingCids.map(c => c.cid));

        // 2. 滚动加载根评论
        const allComments: any[] = [];
        let consecutiveNoNew = 0;
        let hasMore = true;

        while (hasMore && allComments.length < maxRootComments && consecutiveNoNew < 5) {
          // 等待 API 响应
          const responses = await this.collectAllCommentResponses(page);

          if (responses.length === 0) {
            consecutiveNoNew++;
            logger.info({ awemeId: item.awemeId, consecutiveNoNew }, '[Simple] No API response, incrementing counter');
            continue;
          }

          // 提取根评论（快手 API 格式）
          const newComments = responses.flatMap(r => r.body?.data?.list || [])
            .filter(c => !existingCidSet.has(String(c.commentId)));

          if (newComments.length === 0) {
            consecutiveNoNew++;
          } else {
            consecutiveNoNew = 0;
            allComments.push(...newComments);
          }

          // 检查 has_more（快手：pcursor 有值=有更多）
          const lastResp = responses[responses.length - 1];
          hasMore = !!lastResp?.body?.data?.pcursor;

          // 继续滚动
          if (hasMore && allComments.length < maxRootComments) {
            await this.scrollCommentAreaForKuaishou(page, 'bottom');
            await HumanActions.wait(page, 8000, 8000);
          }
        }

        // 3. 限制到 maxRootComments
        const commentsToStore = allComments.slice(0, maxRootComments);

        // 4. 存储新评论
        if (commentsToStore.length > 0) {
          for (const comment of commentsToStore) {
            await db.upsertComment(item.awemeId, {
              cid: String(comment.commentId),
              text: comment.content || '',
              user_nickname: comment.authorName || '',
              user_uid: String(comment.authorId) || '',
              digg_count: comment.likedCount || 0,
              create_time: comment.timestamp || 0,
              reply_id: '0',
            });
          }

          logger.info({
            awemeId: item.awemeId,
            newCount: commentsToStore.length,
            totalCollected: allComments.length,
          }, '[Simple] Stored new root comments');

          // 5. 构建 commentGroups（与 unifiedQueue 兼容）
          const commentGroups = commentsToStore.map(comment => ({
            rootComment: {
              cid: String(comment.commentId),
              text: comment.content || '',
              userNickname: comment.authorName || '',
              userUid: String(comment.authorId) || '',
              createTime: comment.timestamp || 0,
              diggCount: comment.likedCount || 0,
              level: 1 as const,
              replyId: '0',
              isAuthor: false,
              subComments: [],
              imageUrls: comment.imageUrls,
            },
            subReplies: [],
            newInGroup: [
              {
                cid: String(comment.commentId),
                text: comment.content || '',
                userNickname: comment.authorName || '',
                userUid: String(comment.authorId) || '',
                createTime: comment.timestamp || 0,
                diggCount: comment.likedCount || 0,
                level: 1 as const,
                replyId: '0',
                isAuthor: false,
                subComments: [],
                imageUrls: comment.imageUrls,
              },
            ],
          }));

          // 6. 触发企微通知
          await this.notifyNewComments(item.awemeId, commentsToStore);

          results.push({ awemeId: item.awemeId, success: true, commentGroups });
        } else {
          logger.info({ awemeId: item.awemeId }, '[Simple] No new root comments found');
          results.push({ awemeId: item.awemeId, success: true, commentGroups: [] });
        }
      } catch (err) {
        logger.error({ awemeId: item.awemeId, err: (err as Error).message }, '[Simple] Error processing comment queue item');
        results.push({ awemeId: item.awemeId, success: false, error: (err as Error).message });
      }
    }

    return { results };
  }

  /**
   * 通知新评论（复用现有逻辑）
   */
  private async notifyNewComments(awemeId: string, comments: any[]): Promise<void> {
    try {
      const { monitorService } = await import('../services/monitorService');
      await monitorService.notifyNewComments(awemeId, comments);
    } catch (err: any) {
      logger.error({ awemeId, err: err.message }, '[Simple] Failed to notify new comments');
    }
  }
}
