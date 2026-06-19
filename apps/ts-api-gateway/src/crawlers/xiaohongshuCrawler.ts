import { Page } from 'patchright';
import { RequestInterceptor, HumanActions, ExitStrategy, BrowserManager } from '@social-media/browser-core';
import { getSelector, getSelectorChain, getRandomExitSubmenuKeyForPlatform, SelectorDef } from './menuSelectors';
import { resolveAndClick, tryClickBySelector } from './menuNavigator';
import * as db from '../services/monitorDatabaseService';
import { createLogger } from '../lib/logger';
import fs from 'fs';
import path from 'path';

const logger = createLogger('crawler:xiaohongshu');

const XHS_PLATFORM: 'xiaohongshu' = 'xiaohongshu';

const XHS_HOME = 'https://www.xiaohongshu.com';
const CREATOR_HOME = 'https://creator.xiaohongshu.com/creator/home';

const NOTE_LIST_PATTERN = '/api/galaxy/v2/creator/note/user/posted';

const MAX_SCROLL_ATTEMPTS = 30;
const MAX_SCROLL_NO_NEW_DATA = 10;

const RISK_CONTROL_KEYWORDS = ['captcha', 'login', '安全验证', '验证码', '账号异常', 'risk', 'verify', '人机验证', '滑块验证'];
const RISK_CONTROL_URLS = ['/login', '/passport', '/verify', '/captcha', '/check'];

interface VideoInfo {
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: Record<string, any>;
}

interface RiskControlDetection {
  detected: boolean;
  type: string;
  evidence: string;
}

export interface XiaohongshuCheckResult {
  hasUpdate: boolean;
  updatedVideos: Array<{
    awemeId: string;
    description: string;
    oldCount: number;
    newCount: number;
  }>;
  commentsQueue: Array<{
    exportId: string;
    description: string;
    oldCount: number;
    newCount: number;
  }>;
  riskControlDetected: boolean;
  riskControlInfo?: RiskControlDetection;
}

export class XiaohongshuCrawler {
  private interceptor: RequestInterceptor;
  private listenerPageId: string | null = null;
  private currentMenuSection: 'note_manage' | 'data_dashboard' | 'unknown' = 'unknown';

  constructor(private maxMonitorVideos: number = 20) {
    this.interceptor = new RequestInterceptor();
  }

  async warmUp(page: Page): Promise<void> {
    logger.info('Starting warm-up route - navigating to xiaohongshu.com homepage first');

    try {
      await page.goto(XHS_HOME, { waitUntil: 'domcontentloaded' });
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

      logger.info('Xiaohongshu warm-up completed');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Xiaohongshu warm-up failed, proceeding anyway');
    }
  }

  async navigateToCreatorHome(page: Page): Promise<void> {
    const currentUrl = page.url();
    logger.info({ currentUrl, isOnCreator: currentUrl.includes('creator.xiaohongshu.com') }, '[XHS-nav] navigateToCreatorHome start');

    if (currentUrl.includes('creator.xiaohongshu.com')) {
      logger.info({ currentUrl }, 'Already on xiaohongshu creator page, skipping navigation');
    } else {
      logger.info('[XHS-nav] Attempting click-based nav via resolveAndClick');
      // 尝试点击"创作中心"链接（防风控）, 失败时回退到 goto
      const clicked = await resolveAndClick(page, 'nav.to-creator', 'xiaohongshu', { timeout: 10000 });
      logger.info({ clicked, urlAfterClick: page.url() }, '[XHS-nav] resolveAndClick result');
      if (clicked) {
        await HumanActions.wait(page, 2000, 4000);
        await HumanActions.pageLoadBehavior(page);
      } else {
        logger.warn('[XHS-nav] Click-based nav failed, falling back to page.goto');
        await page.goto(CREATOR_HOME, { waitUntil: 'domcontentloaded' });
        HumanActions.clearCDPContext(page);
        await HumanActions.wait(page, 2000, 4000);
        await HumanActions.pageLoadBehavior(page);
      }
    }

    this.currentMenuSection = 'unknown';
    await BrowserManager.logPageHtml(page, 'after_navigateToCreatorHome_xhs');
    const finalUrl = page.url();
    logger.info({ finalUrl, isOnCreator: finalUrl.includes('creator.xiaohongshu.com') }, '[XHS-nav] navigateToCreatorHome done');
  }

  async registerListener(page: Page, patterns: string[]): Promise<void> {
    this.interceptor.clearAll();

    for (const pattern of patterns) {
      this.interceptor.setValidationConfig(pattern, {
        expectedPageUrls: ['creator.xiaohongshu.com'],
        requiredItemFields: [],
        minItems: 0,
      });
    }

    this.listenerPageId = await this.interceptor.register(page, patterns);
    logger.info({ patterns, rejectionCount: this.interceptor.getRejectionLog().length }, 'Xiaohongshu listener registered');
  }

  unregisterListener(): void {
    if (this.listenerPageId) {
      const rejectionLog = this.interceptor.getRejectionLog();
      if (rejectionLog.length > 0) {
        logger.warn({ rejectionCount: rejectionLog.length, latestRejections: rejectionLog.slice(-5) }, 'Xiaohongshu rejection log summary');
      }
      this.interceptor.unregister(this.listenerPageId);
      this.listenerPageId = null;
    }
    this.interceptor.clearAll();
  }

  async fetchNoteListFromSource(page: Page): Promise<VideoInfo[]> {
    const pattern = NOTE_LIST_PATTERN;

    this.interceptor.clear(pattern);
    logger.info({ step: 'CLEAR_INITIAL' }, 'Cleared interceptor for fresh start');

    const onTarget = this.isOnTargetPage(page);
    const urlBeforeNav = page.url();
    logger.info({ onTarget, url: urlBeforeNav, isNotePage: urlBeforeNav.includes('/note'), isPublishPage: urlBeforeNav.includes('/publish'), isContentPage: urlBeforeNav.includes('/content') }, '[XHS-fetch] Target page detection');

    if (onTarget) {
      logger.info({ url: page.url() }, 'Already on target page — forcing F5 refresh to ensure fresh data');
      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 4000);
      await HumanActions.pageLoadBehavior(page);
    } else {
      logger.info('[XHS-fetch] Not on target page — navigating to note management');
      await this.navigateToNoteManage(page);
    }

    const responsesAfterNav = this.interceptor.getResponseCount(pattern);
    const rejectionLogAfterNav = this.interceptor.getRejectionLog(5);
    logger.info({ step: 'AFTER_NAVIGATE', existingResponses: responsesAfterNav, url: page.url(), rejectionLog: rejectionLogAfterNav }, '[XHS-fetch] Navigation complete, waiting for target response');

    let initialResponse = await this.interceptor.waitForResponse(pattern, 20000);

    if (!initialResponse) {
      logger.warn({ step: 'NO_RESPONSE_FIRST', existingResponses: this.interceptor.getResponseCount(pattern) }, '[XHS-fetch] No response after first nav, trying menu re-click');
      this.currentMenuSection = 'unknown';
      await this.navigateToNoteManage(page);
      initialResponse = await this.interceptor.waitForResponse(pattern, 15000);
    }

    if (!initialResponse) {
      const responses = this.interceptor.getResponses(pattern);
      const allRejections = this.interceptor.getRejectionLog(20);
      if (responses.length === 0) {
        logger.error({
          step: 'NO_RESPONSE',
          totalResponses: this.interceptor.getResponseCount(pattern),
          rejectionLog: allRejections,
          currentUrl: page.url(),
        }, '[XHS-fetch] No response captured after navigation — aborting');
        await BrowserManager.logPageHtml(page, 'no_response_xhs_note_list');
        throw new Error('No response from xiaohongshu note list after navigation');
      }
    }

    logger.info({ step: 'GOT_INITIAL', hasMore: initialResponse?.hasMore, responseCount: this.interceptor.getResponseCount(pattern) }, '[XHS-fetch] Initial API response captured');

    const initialItems = this.interceptor.getCollectedItems(pattern);
    logger.info({ step: 'INITIAL_ITEMS', initialCount: initialItems.length }, 'Initial note items parsed');

    await this.scrollToLoadMoreWithDualStop(page, pattern);

    const allItems = this.interceptor.getCollectedItems(pattern);
    // ★ 私密过滤：仅保留 permission_code === 0 的公开笔记
    const filteredItems = allItems.filter((item: any) => {
      const permissionCode = item.permission_code ?? item.permissionCode ?? item.permission?.code;
      if (permissionCode !== undefined && permissionCode !== null) {
        const isPublic = Number(permissionCode) === 0;
        if (!isPublic) {
          logger.info({ noteId: item.id || item.note_id }, '[XHS-fetch] 过滤私密笔记（permission_code=%s）', permissionCode);
        }
        return isPublic;
      }
      return true; // 没有 permission_code 的笔记默认为公开
    });
    const sliced = filteredItems.slice(0, this.maxMonitorVideos);

    // 从 raw responses 中提取作者 ID
    let xhsAuthorId: string | undefined;
    let xhsAuthorName: string | undefined;
    const rawResponses = this.interceptor.getResponses(pattern) || [];
    for (const resp of rawResponses) {
      const body = (resp as any)?.body;
      const items = body?.data?.notes || body?.data?.note_infos || body?.data?.note_list || body?.data?.data?.items || [];
      for (const item of items) {
        const uid = item.user?.userId
          || item.user?.user_id
          || item.user_id
          || item.userId
          || item.author?.userId;
        if (uid) {
          xhsAuthorId = String(uid);
          xhsAuthorName = item.user?.nickname || item.user?.name || item.author?.nickname || '';
          break;
        }
      }
      if (xhsAuthorId) break;
    }
    (sliced as any)._xhsAuthorId = xhsAuthorId;
    (sliced as any)._xhsAuthorName = xhsAuthorName;

    logger.info({
      step: 'FETCH_COMPLETE',
      totalCollected: allItems.length,
      totalResponses: this.interceptor.getResponseCount(pattern),
      finalCount: sliced.length,
      maxMonitor: this.maxMonitorVideos,
    }, 'Xiaohongshu note list fetch completed');

    return sliced;
  }

  private isOnTargetPage(page: Page): boolean {
    const url = page.url();
    return url.includes('creator.xiaohongshu.com') && (url.includes('/note') || url.includes('/publish') || url.includes('/content'));
  }

  private async navigateToNoteManage(page: Page): Promise<void> {
    logger.info({ currentMenuSection: this.currentMenuSection, url: page.url() }, '[XHS-nav-note] Starting navigation to note management');

    await HumanActions.thinkingPause(page, 800, 2000);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      logger.info({ attempt, url: page.url() }, '[XHS-nav-note] Calling resolveAndClick for menu.note-manage');
      const clicked = await resolveAndClick(page, 'menu.note-manage', XHS_PLATFORM, { timeout: 10000 });
      logger.info({ attempt, clicked, urlAfter: page.url() }, '[XHS-nav-note] resolveAndClick result');
      if (clicked) {
        await HumanActions.wait(page, 1500, 3000);
        const finalUrl = page.url();
        const isOnNotePage = finalUrl.includes('/note') || finalUrl.includes('/publish') || finalUrl.includes('/content');
        logger.info({ finalUrl, isOnNotePage }, '[XHS-nav-note] Navigated, checking if on target page');
        this.currentMenuSection = 'note_manage';
        return;
      }
      logger.warn({ attempt, url: page.url() }, '[XHS-nav-note] Note management navigation failed, retrying');
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 3000);
    }
    logger.error({ finalUrl: page.url() }, '[XHS-nav-note] Menu navigation to note management FAILED after all retries');
  }

  private async scrollToLoadMoreWithDualStop(page: Page, pattern: string): Promise<void> {
    let totalScrolls = 0;
    let scrollsSinceNewData = 0;
    let lastKnownCount = this.interceptor.getCollectedCount(pattern);
    let lastKnownResponseCount = this.interceptor.getResponseCount(pattern);

    while (totalScrolls < MAX_SCROLL_ATTEMPTS) {
      const collectedCount = this.interceptor.getCollectedCount(pattern);
      const responseCount = this.interceptor.getResponseCount(pattern);

      if (collectedCount > lastKnownCount || responseCount > lastKnownResponseCount) {
        scrollsSinceNewData = 0;
        lastKnownCount = collectedCount;
        lastKnownResponseCount = responseCount;
        logger.info({
          step: 'DAEMON_DATA_ARRIVED',
          totalScrolls,
          collectedCount,
          responseCount,
          maxMonitor: this.maxMonitorVideos,
        }, 'XHS background daemon detected new data');
      }

      logger.info({
        step: 'SCROLL_ITERATION',
        totalScrolls,
        collectedCount,
        responseCount,
        maxMonitor: this.maxMonitorVideos,
        scrollsSinceNewData,
        dataExhausted: this.interceptor.hasDataExhausted(pattern),
      }, 'XHS scroll loop iteration (async dual-track)');

      if (collectedCount >= this.maxMonitorVideos) {
        logger.info({ collectedCount, maxMonitor: this.maxMonitorVideos, totalScrolls }, 'XHS quantity cap reached - stopping scroll');
        break;
      }

      if (this.interceptor.hasDataExhausted(pattern)) {
        logger.info({ totalScrolls, collectedCount }, 'XHS data exhausted (page=-1) - stopping scroll');
        break;
      }

      if (scrollsSinceNewData >= MAX_SCROLL_NO_NEW_DATA) {
        logger.info({ totalScrolls, scrollsSinceNewData, collectedCount }, 'XHS no new data after consecutive scrolls - stopping');
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
        }, 'XHS new data arrived immediately after scroll');
      } else {
        scrollsSinceNewData++;
        logger.info({ step: 'SCROLL_NO_IMMEDIATE_DATA', totalScrolls, scrollsSinceNewData }, 'XHS no immediate data after scroll - continuing rhythm');

        if (scrollsSinceNewData >= 4) {
          logger.info({ step: 'FALLBACK_KEY' }, 'XHS trying fallback CDP wheel scroll');
          await HumanActions.humanScroll(page, 400, {
            minPause: 300,
            maxPause: 800,
          });
          await HumanActions.wait(page, 1500, 3000);
          const fallbackCount = this.interceptor.getCollectedCount(pattern);
          if (fallbackCount > lastKnownCount) {
            scrollsSinceNewData = 0;
            lastKnownCount = fallbackCount;
            logger.info({ step: 'FALLBACK_KEY_OK' }, 'XHS fallback scroll triggered new data');
          } else {
            logger.info({ step: 'FALLBACK_KEY_FAIL' }, 'XHS fallback scroll did not trigger new data');
          }
        }
      }
    }

    logger.info({ step: 'SCROLL_LOOP_DONE', totalScrolls, finalCollected: this.interceptor.getCollectedCount(pattern), finalResponses: this.interceptor.getResponseCount(pattern) }, 'XHS scroll loop finished');
  }

  private async humanReadingPause(page: Page): Promise<void> {
    const readingDelay = 800 + Math.random() * 700;
    await HumanActions.wait(page, readingDelay, readingDelay + 100);
  }

  private async smartScrollListContainer(page: Page): Promise<void> {
    try {
      const noteListDef = getSelector('region.note-list', XHS_PLATFORM);
      const noteListScrollDef = getSelector('region.note-list-scroll', XHS_PLATFORM);
      const mainContentDef = getSelector('scroll.main-content', XHS_PLATFORM);

      const containerSelectors = [
        ...(noteListScrollDef.css ? [noteListScrollDef.css] : []),
        ...(noteListDef.css ? [noteListDef.css] : []),
        '#content-area main [class*="scroll"]',
        '#content-area main [class*="list"]',
        '[class*="table"] [class*="body"]',
      ].filter(Boolean) as string[];

      const container = await HumanActions.cdpFindScrollContainer(page, containerSelectors);

      if (container) {
        logger.info({ selector: container.sel }, 'XHS scrolling container');
        await HumanActions.cdpSmartScroll(page, [container.sel], 300, 'down');
      } else if (mainContentDef.css) {
        logger.info({ selector: mainContentDef.css }, 'XHS no specific container found, scrolling main content area');
        await HumanActions.cdpSmartScroll(page, [mainContentDef.css], 400, 'down');
      } else {
        logger.info('XHS no container found, scrolling viewport center');
        await HumanActions.cdpSmartScroll(page, [], 400, 'down');
      }

      await HumanActions.wait(page, 300, 800);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'XHS smart scroll failed, using CDP scroll fallback');
      await HumanActions.humanScroll(page, 300);
    }
  }

  async executeExitStrategy(page: Page, excludeSubmenuKey?: string): Promise<void> {
    const exitAction = ExitStrategy.getRandomExitAction();
    const excludeKeys = [excludeSubmenuKey, 'menu.note-manage'].filter(Boolean) as string[];
    logger.info({ exitAction, excludeKeys }, 'Xiaohongshu exit strategy: executing');

    if (exitAction === 'navigate_submenu') {
      const submenuKey = getRandomExitSubmenuKeyForPlatform(XHS_PLATFORM, ...excludeKeys);
      logger.info({ submenuKey }, 'Xiaohongshu exit strategy: navigate to random submenu');

      const clicked = await resolveAndClick(page, submenuKey, XHS_PLATFORM, { timeout: 10000 });
      if (clicked) {
        this.currentMenuSection = 'unknown';
      } else {
        logger.warn('Xiaohongshu submenu navigation failed, falling back to idle wander');
        await HumanActions.randomBlankClick(page);
      }
      await HumanActions.wait(page, 2000, 4000);
    } else if (exitAction === 'idle_wander') {
      logger.info('Xiaohongshu exit strategy: idle wander');
      await HumanActions.randomBlankClick(page);
      await HumanActions.wait(page, 500, 1500);
      await HumanActions.humanScroll(page, 50 + Math.random() * 100, {
        minPause: 200,
        maxPause: 600,
      });
      await HumanActions.wait(page, 1000, 2000);
    } else {
      logger.info('Xiaohongshu exit strategy: CDP refresh');
      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 4000);
    }
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

  async captureRiskScene(page: Page, userId: number, riskType: string): Promise<{ screenshotPath: string | null; htmlPath: string | null }> {
    const sceneDir = path.resolve(process.cwd(), 'data', 'risk_scenes');
    if (!fs.existsSync(sceneDir)) {
      fs.mkdirSync(sceneDir, { recursive: true });
    }

    const timestamp = Date.now();
    const baseName = `risk_xhs_${userId}_${riskType}_${timestamp}`;
    let screenshotPath: string | null = null;
    let htmlPath: string | null = null;

    try {
      const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
      screenshotPath = path.join(sceneDir, `${baseName}.png`);
      fs.writeFileSync(screenshotPath, screenshotBuffer);
      logger.info({ screenshotPath, sizeKB: Math.round(screenshotBuffer.length / 1024) }, 'Xiaohongshu risk scene screenshot saved');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to capture xiaohongshu risk scene screenshot');
    }

    try {
      const html = await HumanActions.cdpGetBodyText(page);
      htmlPath = path.join(sceneDir, `${baseName}.html.txt`);
      fs.writeFileSync(htmlPath, html);
      logger.info({ htmlPath, length: html.length }, 'Xiaohongshu risk scene HTML text saved');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to capture xiaohongshu risk scene HTML');
    }

    return { screenshotPath, htmlPath };
  }

  /**
   * Phase 2: 检查主站登录态
   * 打开 www.xiaohongshu.com → 检测用户头像存在 → 未登录则发 QR → 回退 light
   * @returns true=已登录，false=未登录
   */
  async checkMainsiteLogin(
    context: any,  // BrowserContext
    userId: number,
    wechatUserid: string,
  ): Promise<boolean> {
    logger.info({ userId }, '[XHS-Phase2] 开始检查主站登录态');
    const mainsitePage = await context.newPage();

    try {
      await mainsitePage.goto('https://www.xiaohongshu.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await HumanActions.wait(mainsitePage, 3000, 5000);

      // 检测用户头像（已登录标识）
      const avatarDef = getSelector('region.mainsite-user-avatar', XHS_PLATFORM);
      let loggedIn = false;
      if (avatarDef.css) {
        try {
          await mainsitePage.waitForSelector(avatarDef.css, { timeout: 8000 });
          loggedIn = true;
        } catch {
          loggedIn = false;
        }
      }

      if (!loggedIn) {
        logger.info({ userId }, '[XHS-Phase2] 主站未登录，发送 QR 码');

        // 截图 QR 码区域
        const qrDef = getSelector('region.mainsite-qr-code', XHS_PLATFORM);
        try {
          const qrEl = await mainsitePage.waitForSelector(qrDef.css || '.qrcode-img', { timeout: 15000 });
          const qrBuffer = await qrEl.screenshot({ type: 'png' });

          // 发送到企微 — 使用 botManager.sendLoginAlert（与抖音/快手/视频号一致）
          const { botManager } = await import('../services/wechatBotService');
          await botManager.sendLoginAlert(wechatUserid, 'xiaohongshu', userId, qrBuffer);
          logger.info({ userId }, '[XHS-Phase2] QR 码已发送到企微');
        } catch (err: any) {
          logger.warn({ userId, error: err.message }, '[XHS-Phase2] QR 码截图失败');
        }
      }

      return loggedIn;
    } catch (err: any) {
      logger.warn({ userId, error: err.message }, '[XHS-Phase2] 主站登录检查异常');
      return false;
    } finally {
      await mainsitePage.close().catch(() => {});
    }
  }

  async checkForUpdates(
    page: Page,
    userId: number
  ): Promise<XiaohongshuCheckResult> {
    logger.info({ userId, url: page.url() }, '[XHS-Light] Starting xiaohongshu update check — light mode (no comment details)');

    const riskCheck = await this.detectRiskControlAsync(page);
    if (riskCheck.detected) {
      logger.error({ userId, riskType: riskCheck.type, evidence: riskCheck.evidence }, '[XHS-Light] Risk control detected before check');
      return {
        hasUpdate: false,
        updatedVideos: [],
        commentsQueue: [],
        riskControlDetected: true,
        riskControlInfo: riskCheck,
      };
    }

    // 诊断：检查拦截器当前状态
    const preFetchResponses = this.interceptor.getResponseCount(NOTE_LIST_PATTERN);
    const preFetchRejections = this.interceptor.getRejectionLog(3);
    logger.info({ userId, preFetchResponses, preFetchRejections, url: page.url() }, '[XHS-Light] Pre-fetch interceptor state');

    logger.info({ userId }, '[XHS-Light] Fetching note list');
    const videos = await this.fetchNoteListFromSource(page);

    // 同步作者 ID
    const xhsAuthorId = (videos as any)._xhsAuthorId;
    const xhsAuthorName = (videos as any)._xhsAuthorName;
    if (xhsAuthorId) {
      await db.syncPlatformAuthorId(userId, xhsAuthorId, xhsAuthorName);
      logger.info({ userId, xhsAuthorId }, '[XHS-Light] Synced platform author ID');
    }

    // 诊断日志：记录每个笔记的评论数提取情况
    logger.info({
      userId,
      noteCount: videos.length,
      noteDetails: videos.map(v => ({
        awemeId: v.aweme_id,
        desc: v.description?.slice(0, 30),
        commentCount: v.comment_count,
      })),
    }, '[XHS-Light] Fetched note list with comment counts');

    const dbVideos = await db.getVideosByUserId(userId);

    logger.info({ userId, dbVideoCount: dbVideos.length, fetchedCount: videos.length }, '[XHS-Light] Comparing with database records');

    const updatedVideos: Array<{
      awemeId: string;
      description: string;
      oldCount: number;
      newCount: number;
    }> = [];

    for (const video of videos) {
      const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
      if (!dbVideo) {
        // 新笔记首次入库：如果有评论，记录为有更新
        if (video.comment_count > 0) {
          logger.info({
            awemeId: video.aweme_id,
            description: video.description,
            commentCount: video.comment_count,
          }, '[XHS-Light] New note with comments — marking as updated');
          updatedVideos.push({
            awemeId: video.aweme_id,
            description: video.description,
            oldCount: 0,
            newCount: video.comment_count,
          });
        } else {
          logger.info({ awemeId: video.aweme_id, description: video.description }, '[XHS-Light] New note with no comments — skipping');
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
        }, '[XHS-Light] Comment count increased — will notify (light mode)');

        updatedVideos.push({
          awemeId: video.aweme_id,
          description: video.description,
          oldCount: dbVideo.commentCount,
          newCount: video.comment_count,
        });
      } else {
        logger.info({
          awemeId: video.aweme_id,
          current: video.comment_count,
          stored: dbVideo.commentCount,
        }, '[XHS-Light] Comment count unchanged');
      }
    }

    logger.info({ userId, videoCount: videos.length }, '[XHS-Light] Comparison done, upserting videos to database');
    await db.reconcileVideosForUser(userId, videos, this.maxMonitorVideos);

    for (const update of updatedVideos) {
      await db.updateCommentCount(update.awemeId, update.newCount);
      // Light 模式：创建合成 Comment 记录，供前端 new-comments API 显示
      await db.markCommentsAsNotified(update.awemeId);
      const newCount = update.newCount - update.oldCount;
      if (newCount > 0) {
        await db.upsertLightModeComment(update.awemeId, {
          text: `[轻量模式] ${newCount} 条新评论`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }

    if (updatedVideos.length === 0) {
      logger.info({ userId }, '[XHS-Light] No comment updates found');
    } else {
      logger.info({ userId, count: updatedVideos.length, awemeIds: updatedVideos.map(v => v.awemeId) }, '[XHS-Light] Found notes with comment updates — will send light notification');
    }

    const postRiskCheck = await this.detectRiskControlAsync(page);
    if (postRiskCheck.detected) {
      logger.error({ userId, riskType: postRiskCheck.type }, '[XHS-Light] Risk control detected after check');
      return {
        hasUpdate: false,
        updatedVideos: [],
        commentsQueue: [],
        riskControlDetected: true,
        riskControlInfo: postRiskCheck,
      };
    }

    const commentsQueue = updatedVideos.map((v) => ({
      exportId: v.awemeId,
      description: v.description,
      oldCount: v.oldCount,
      newCount: v.newCount,
    }));

    return {
      hasUpdate: updatedVideos.length > 0,
      updatedVideos,
      commentsQueue,
      riskControlDetected: false,
    };
  }

  // ============================================================
  // Phase 3: 评论树采集
  // ============================================================

  async clickThumbnailAndWaitNewTab(page: Page, noteId: string, timeout = 15000): Promise<Page | null> {
    logger.info({ noteId }, '[XHS-Phase3] Clicking thumbnail to open note detail');

    try {
      const cardDef = getSelector('region.note-card-by-id', XHS_PLATFORM);
      const coverDef = getSelector('region.note-card-cover', XHS_PLATFORM);

      // 监听新标签页
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout }),
        (async () => {
          // 找到卡片内的缩略图并点击
          const cardSelector = cardDef.css?.replace('{noteId}', noteId);
          if (!cardSelector) throw new Error('No card selector');
          const card = await page.waitForSelector(cardSelector, { timeout: 10000 });
          let clickEl = card;
          if (coverDef.css) {
            const cover = await card.$(coverDef.css);
            if (cover) clickEl = cover;
          }
          await (clickEl as any).click();
        })(),
      ]);

      await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await HumanActions.wait(newPage, 2000, 4000);
      logger.info({ noteId, url: newPage.url() }, '[XHS-Phase3] New tab opened');
      return newPage;
    } catch (err: any) {
      logger.warn({ noteId, error: err.message }, '[XHS-Phase3] Failed to open new tab for note');
      return null;
    }
  }

  async registerCommentInterceptor(newPage: Page): Promise<void> {
    const patterns = [
      '/api/sns/web/v2/comment/page',
      '/api/sns/web/v2/comment/sub/page',
    ];

    const interceptor = new RequestInterceptor();
    for (const pattern of patterns) {
      interceptor.setValidationConfig(pattern, {
        expectedPageUrls: ['www.xiaohongshu.com'],
        requiredItemFields: [],
        minItems: 0,
      });
    }

    const listenerId = await interceptor.register(newPage, patterns);
    logger.info({ patterns }, '[XHS-Phase3] Comment API interceptor registered');

    (this as any)._commentInterceptor = interceptor;
    (this as any)._commentListenerId = listenerId;
  }

  async scrollLoadRootComments(newPage: Page): Promise<any[]> {
    logger.info('[XHS-Phase3] Loading root comments via scroll');

    const interceptor = (this as any)._commentInterceptor as RequestInterceptor;
    const pattern = '/api/sns/web/v2/comment/page';

    await interceptor.waitForResponse(pattern, 15000).catch(() => {});

    let allItems: any[] = [];
    let scrollAttempts = 0;
    const maxScrollAttempts = 30;

    while (scrollAttempts < maxScrollAttempts) {
      const items = interceptor.getCollectedItems(pattern);
      if (items.length > allItems.length) {
        allItems = items;
        logger.info({ totalItems: allItems.length, attempt: scrollAttempts }, '[XHS-Phase3] Root comments batch loaded');
      }

      const responses = interceptor.getResponses(pattern);
      const lastResp = responses[responses.length - 1];
      const hasMore = lastResp?.body?.data?.has_more !== false;

      if (!hasMore && allItems.length > 0) {
        logger.info({ totalItems: allItems.length }, '[XHS-Phase3] All root comments loaded');
        break;
      }

      const scrollerDef = getSelector('region.comment-scroller', XHS_PLATFORM);
      if (scrollerDef.css) {
        try {
          await HumanActions.cdpSmartScroll(newPage, [scrollerDef.css], 400, 'down');
        } catch {
          await HumanActions.humanScroll(newPage, 300, { minPause: 300, maxPause: 800 });
        }
      } else {
        await HumanActions.humanScroll(newPage, 300, { minPause: 300, maxPause: 800 });
      }
      await HumanActions.wait(newPage, 1000, 2000);
      scrollAttempts++;
    }

    return allItems;
  }

  async expandSubCommentsForRoots(newPage: Page, rootComments: any[]): Promise<void> {
    logger.info({ totalRoots: rootComments.length }, '[XHS-Phase3] Expanding sub-comments');

    for (const root of rootComments) {
      const subCount = root.sub_comment_count || root.subCommentCount || 0;
      if (subCount <= 0) continue;

      const rootCid = root.id;
      if (!rootCid) continue;

      logger.info({ rootCid, subCount }, '[XHS-Phase3] Expanding sub-comments for root');

      try {
        const rootContainer = newPage.locator(`[id="comment-${rootCid}"]`).first();
        if (await rootContainer.isVisible().catch(() => false)) {
          const expandBtn = rootContainer.getByText('展开').first();
          if (await expandBtn.isVisible().catch(() => false)) {
            await expandBtn.click();
            await HumanActions.wait(newPage, 1500, 2500);
          }

          for (let i = 0; i < 10; i++) {
            const moreBtn = rootContainer.getByText('展开更多回复').first();
            if (await moreBtn.isVisible().catch(() => false)) {
              await moreBtn.click();
              await HumanActions.wait(newPage, 1000, 2000);
            } else {
              break;
            }
          }
        } else {
          logger.warn({ rootCid }, '[XHS-Phase3] Root container not found, trying page-wide search');
          const expandBtn = newPage.getByText('展开').first();
          if (await expandBtn.isVisible().catch(() => false)) {
            await expandBtn.click();
            await HumanActions.wait(newPage, 1500, 2500);
          }
        }
      } catch (err: any) {
        logger.warn({ rootCid, error: err.message }, '[XHS-Phase3] Failed to expand sub-comments');
      }
    }
  }

  buildCommentTree(newPage: Page): Array<{
    cid: string; text: string; user_nickname: string; user_uid: string;
    digg_count: number; create_time: number; reply_id: string;
    rootId?: string; parentId?: string; level: number; replyToName?: string; is_author?: boolean;
  }> {
    const interceptor = (this as any)._commentInterceptor as RequestInterceptor;
    const comments: Array<any> = [];

    // 解析根评论 /comment/page
    const rootResponses = interceptor.getResponses('/api/sns/web/v2/comment/page');
    for (const resp of rootResponses) {
      const items = resp?.body?.data?.comments || resp?.body?.data?.items || [];
      for (const item of items) {
        comments.push({
          cid: item.id,
          text: item.content,
          user_nickname: item.user_info?.nickname || '',
          user_uid: item.user_info?.user_id || '',
          digg_count: parseInt(item.like_count || '0', 10),
          create_time: Math.floor((item.create_time || 0) / 1000),
          reply_id: '0',
          rootId: undefined,
          parentId: undefined,
          level: 1,
          replyToName: undefined,
          is_author: item.show_tags?.includes('is_author') || false,
        });

        if (item.comments && Array.isArray(item.comments)) {
          for (const sub of item.comments) {
            comments.push({
              cid: sub.id,
              text: sub.content,
              user_nickname: sub.user_info?.nickname || '',
              user_uid: sub.user_info?.user_id || '',
              digg_count: parseInt(sub.like_count || '0', 10),
              create_time: Math.floor((sub.create_time || 0) / 1000),
              reply_id: sub.target_comment?.id || item.id,
              rootId: item.id,
              parentId: sub.target_comment?.id || item.id,
              level: 2,
              replyToName: sub.target_comment?.user_info?.nickname || '',
              is_author: sub.show_tags?.includes('is_author') || false,
            });
          }
        }
      }
    }

    // 解析子评论 /comment/sub/page
    const subResponses = interceptor.getResponses('/api/sns/web/v2/comment/sub/page');
    for (const resp of subResponses) {
      const items = resp?.body?.data?.comments || resp?.body?.data?.items || [];
      for (const sub of items) {
        comments.push({
          cid: sub.id,
          text: sub.content,
          user_nickname: sub.user_info?.nickname || '',
          user_uid: sub.user_info?.user_id || '',
          digg_count: parseInt(sub.like_count || '0', 10),
          create_time: Math.floor((sub.create_time || 0) / 1000),
          reply_id: sub.target_comment?.id || sub.root_id || '0',
          rootId: sub.root_id || undefined,
          parentId: sub.target_comment?.id || sub.parent_id || undefined,
          level: 2,
          replyToName: sub.target_comment?.user_info?.nickname || '',
          is_author: sub.show_tags?.includes('is_author') || false,
        });
      }
    }

    return comments;
  }

  async processOneNoteComments(
    page: Page,
    item: { exportId: string; description: string },
    userId: number,
  ): Promise<{ success: boolean; awemeId: string; error?: string }> {
    const { exportId, description } = item;
    logger.info({ exportId, desc: description?.slice(0, 30) }, '[XHS-Phase3] Processing note');

    try {
      const newPage = await this.clickThumbnailAndWaitNewTab(page, exportId);
      if (!newPage) {
        return { success: false, awemeId: exportId, error: 'Failed to open note detail page' };
      }

      try {
        await this.registerCommentInterceptor(newPage);
        const rootComments = await this.scrollLoadRootComments(newPage);
        await this.expandSubCommentsForRoots(newPage, rootComments);

        const comments = this.buildCommentTree(newPage);
        logger.info({ exportId, rootCount: rootComments.length, totalComments: comments.length }, '[XHS-Phase3] Comments collected');

        if (comments.length > 0) {
          await db.upsertCommentTree(exportId, comments);

          const rootCids = new Set(comments.filter((c) => c.level === 1).map((c) => c.cid));
          const subCountByRoot = new Map<string, number>();
          for (const c of comments) {
            if (c.level === 2 && c.rootId && rootCids.has(c.rootId)) {
              subCountByRoot.set(c.rootId, (subCountByRoot.get(c.rootId) || 0) + 1);
            }
          }
          const rootCounts = [...subCountByRoot.entries()].map(([cid, count]) => ({ cid, replyCount: count }));
          await db.upsertRootCommentCounts(exportId, rootCounts);
          await db.deleteStaleRootCounts(exportId, [...rootCids].concat(rootCounts.map((r) => r.cid)));
          await db.updateVideoCommentCount(userId, exportId, comments.length);
        }

        return { success: true, awemeId: exportId };
      } finally {
        await newPage.close().catch(() => {});
        await page.bringToFront();
        await HumanActions.wait(page, 5000, 10000);
      }
    } catch (err: any) {
      logger.warn({ exportId, error: err.message }, '[XHS-Phase3] Note processing failed');
      return { success: false, awemeId: exportId, error: err.message };
    }
  }

  async processCommentsQueue(
    page: Page,
    queue: Array<{ exportId: string; description: string; oldCount: number; newCount: number }>,
    userId: number,
  ): Promise<Array<{ success: boolean; awemeId: string; error?: string }>> {
    logger.info({ queueLength: queue.length, userId }, '[XHS-Phase3] Processing comments queue');

    const results: Array<{ success: boolean; awemeId: string; error?: string }> = [];

    for (const item of queue) {
      const result = await this.processOneNoteComments(page, item, userId);
      results.push(result);

      if (result.error?.includes('captcha') || result.error?.includes('Risk control')) {
        logger.warn({ userId, awemeId: item.exportId }, '[XHS-Phase3] Risk detected, aborting queue');
        break;
      }
    }

    const interceptor = (this as any)._commentInterceptor as RequestInterceptor;
    const listenerId = (this as any)._commentListenerId;
    if (interceptor && listenerId) {
      interceptor.unregister(listenerId);
      interceptor.clearAll();
      (this as any)._commentInterceptor = undefined;
      (this as any)._commentListenerId = undefined;
    }

    return results;
  }

  /**
   * 评论回复 6 阶段流程（在小红书主站笔记详情页执行）
   * Phase 1: 数据准备（已在 executeReplyAction 中完成）
   * Phase 3: 评论定位（cid 强主键 + 文本 + 昵称三重匹配）
   * Phase 4: 点击回复按钮
   * Phase 5: 输入内容并发送
   */
  async replyToComment(
    page: Page,
    target: import('./replyTypes').ReplyTarget,
    replyText: string,
    executionId?: string,
  ): Promise<boolean> {
    logger.info({
      cid: target.cid,
      text: target.text?.slice(0, 30),
      level: target.level,
      username: target.username,
    }, '[XHS-Reply] Starting xiaohongshu reply');

    try {
      // 等待评论区加载
      const containerDef = getSelector('region.comments-container', XHS_PLATFORM);
      if (containerDef.css) {
        await page.waitForSelector(containerDef.css, { timeout: 15000 }).catch(() => {});
      }
      await HumanActions.wait(page, 2000, 4000);

      // Phase 3: 评论定位（cid 强主键）
      const cid = target.cid;
      if (!cid) {
        logger.error('[XHS-Reply] No cid provided');
        return false;
      }

      let commentEl = page.locator(`[data-cid="${cid}"]`).first();
      if (!(await commentEl.isVisible().catch(() => false))) {
        commentEl = page.locator(`[id*="${cid}"]`).first();
      }
      if (!(await commentEl.isVisible().catch(() => false))) {
        logger.warn({ cid }, '[XHS-Reply] Comment element not found by cid, trying text+username matching');
        const allComments = page.locator('[class*="comment-item"]');
        const count = await allComments.count();
        for (let i = 0; i < count; i++) {
          const el = allComments.nth(i);
          const text = await el.innerText().catch(() => '');
          if (text.includes(target.text?.slice(0, 20) || '') && text.includes(target.username || '')) {
            commentEl = el;
            logger.info({ idx: i }, '[XHS-Reply] Found comment by text+username');
            break;
          }
        }
      }

      if (!(await commentEl.isVisible().catch(() => false))) {
        logger.error({ cid }, '[XHS-Reply] Comment not found');
        return false;
      }

      // Phase 4: 点击回复按钮
      await commentEl.scrollIntoViewIfNeeded();
      await HumanActions.wait(page, 500, 1000);

      let replyClicked = false;
      const replyBtn = commentEl.getByText('回复').first();
      if (await replyBtn.isVisible().catch(() => false)) {
        await replyBtn.click();
        replyClicked = true;
      } else {
        const globalReplyBtn = page.getByText('回复', { exact: true }).first();
        if (await globalReplyBtn.isVisible().catch(() => false)) {
          await globalReplyBtn.click();
          replyClicked = true;
        }
      }

      if (!replyClicked) {
        logger.error({ cid }, '[XHS-Reply] Reply button not found');
        return false;
      }
      await HumanActions.wait(page, 500, 1000);

      // Phase 5: 输入内容并发送
      let inputFocused = false;
      const inputEl = page.locator('.bottom-container [contenteditable="true"]').first();
      if (await inputEl.isVisible().catch(() => false)) {
        await inputEl.click();
        await HumanActions.wait(page, 200, 500);
        await HumanActions.safeCDPType(page, replyText);
        await HumanActions.wait(page, 500, 1200);
        inputFocused = true;
      } else {
        const fallbackInput = page.locator('[contenteditable="true"]').first();
        if (await fallbackInput.isVisible().catch(() => false)) {
          await fallbackInput.click();
          await HumanActions.wait(page, 200, 500);
          await HumanActions.safeCDPType(page, replyText);
          await HumanActions.wait(page, 500, 1200);
          inputFocused = true;
        }
      }

      if (!inputFocused) {
        logger.error('[XHS-Reply] No reply input found');
        return false;
      }

      // 发送：优先找"发送"按钮，回退 Enter 键
      const sendBtn = page.getByText('发送', { exact: true }).first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
        await HumanActions.wait(page, 1000, 2000);
        logger.info({ cid: target.cid, text: replyText }, '[XHS-Reply] Reply sent');
      } else {
        await page.keyboard.press('Enter');
        await HumanActions.wait(page, 1000, 2000);
        logger.info({ cid: target.cid }, '[XHS-Reply] Reply sent via Enter key');
      }
      return true;
    } catch (err: any) {
      logger.error({ cid: target.cid, error: err.message }, '[XHS-Reply] Reply failed');
      return false;
    }
  }
}
