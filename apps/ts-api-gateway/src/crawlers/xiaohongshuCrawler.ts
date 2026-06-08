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
    const sliced = allItems.slice(0, this.maxMonitorVideos);

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
    await db.upsertVideosBatch(userId, videos);
    await db.truncateVideosByUser(userId, this.maxMonitorVideos);

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
        riskControlDetected: true,
        riskControlInfo: postRiskCheck,
      };
    }

    return {
      hasUpdate: updatedVideos.length > 0,
      updatedVideos,
      riskControlDetected: false,
    };
  }
}
