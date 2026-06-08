import { Page } from 'patchright';
import { RequestInterceptor } from '@social-media/browser-core';
import { HumanActions } from '@social-media/browser-core';
import { ExitStrategy, PageType } from '@social-media/browser-core';
import { getSelector, getRandomExitSubmenuKey, getSubmenuKeyForPageType } from './menuSelectors';
import * as db from '../services/monitorDatabaseService';
import { BrowserManager } from '@social-media/browser-core';
import { createLogger } from '../lib/logger';
import { resolveAndClick, tryClickBySelector } from './menuNavigator';
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
const COMMENT_LIST_PATTERN = '/rest/cp/comment/pc/list';

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
  oldCount: number;
  newCount: number;
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
// Main crawler class
// ============================================================

export class KuaishouCrawler {
  private interceptor: RequestInterceptor;
  private listenerPageId: string | null = null;
  private currentMenuSection: 'content' | 'data_center' | 'interact' | 'unknown' = 'unknown';

  constructor(private maxMonitorVideos: number = 20) {
    this.interceptor = new RequestInterceptor();
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

    let initialResponse = await this.interceptor.waitForResponse(pattern, 25000);

    if (!initialResponse) {
      logger.info({ source }, 'No target response after 25s, compensating with menu re-click');
      this.currentMenuSection = 'unknown';
      if (source === 'work_list') {
        await this.navigateToWorkManage(page);
      } else {
        await this.navigateToPhotoAnalysis(page);
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

    if (source === 'photo_analysis') {
      await this.paginateNextPage(page, pattern);
    } else {
      await this.scrollToLoadMoreWithDualStop(page, pattern);
    }

    const allItems = this.interceptor.getCollectedItems(pattern);
    const sliced = allItems.slice(0, this.maxMonitorVideos);

    logger.info({
      source,
      step: 'FETCH_COMPLETE',
      totalCollected: allItems.length,
      totalResponses: this.interceptor.getResponseCount(pattern),
      finalCount: sliced.length,
      maxMonitor: this.maxMonitorVideos,
      awemeIds: sliced.map(i => i.aweme_id),
    }, 'Kuaishou video list fetch completed');

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
        }, 'Kuaishou background daemon detected new data');
      }

      logger.info({
        step: 'SCROLL_ITERATION',
        totalScrolls,
        collectedCount,
        responseCount,
        maxMonitor: this.maxMonitorVideos,
        scrollsSinceNewData,
        dataExhausted: this.interceptor.hasDataExhausted(pattern),
      }, 'Kuaishou scroll loop iteration');

      if (collectedCount >= this.maxMonitorVideos) {
        logger.info({ collectedCount, maxMonitor: this.maxMonitorVideos, totalScrolls }, 'Kuaishou quantity cap reached - stopping scroll');
        break;
      }

      if (this.interceptor.hasDataExhausted(pattern)) {
        logger.info({ totalScrolls, collectedCount }, 'Kuaishou data exhausted - stopping scroll');
        break;
      }

      if (scrollsSinceNewData >= MAX_SCROLL_NO_NEW_DATA) {
        logger.info({ totalScrolls, scrollsSinceNewData, collectedCount }, 'Kuaishou no new data after consecutive scrolls - stopping');
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

    logger.info({ step: 'SCROLL_LOOP_DONE', totalScrolls, finalCollected: this.interceptor.getCollectedCount(pattern), finalResponses: this.interceptor.getResponseCount(pattern) }, 'Kuaishou scroll loop finished');
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

    logger.info({ userId }, '[Phase1] Fetching kuaishou video list from source');
    const videos = await this.fetchVideoListFromSource(page, source);

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

    const commentsQueue: KuaishouCommentQueueItem[] = [];

    for (const video of videos) {
      const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
      if (!dbVideo) {
        // 新视频首次入库：仅记入 DB，不入队（避免两个数据源交替时重复入队）
        logger.info({
          awemeId: video.aweme_id,
          description: video.description,
          commentCount: video.comment_count,
        }, '[Phase1] New video discovered — inserting to DB (no enqueue)');
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
          oldCount: dbVideo.commentCount,
          newCount: video.comment_count,
        });
      } else {
        logger.info({
          awemeId: video.aweme_id,
          current: video.comment_count,
          stored: dbVideo.commentCount,
        }, '[Phase1] Kuaishou comment count unchanged');
      }
    }

    logger.info({ userId, videoCount: videos.length }, '[Phase1] Comparison done, upserting videos to database');
    await db.upsertVideosBatch(userId, videos);
    await db.truncateVideosByUser(userId, this.maxMonitorVideos);

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

    this.interceptor.clear(COMMENT_LIST_PATTERN);
    const commentListenerId = await this.interceptor.register(page, [COMMENT_LIST_PATTERN]);
    logger.info({ commentListenerId }, '[Phase3] Kuaishou comment API listener registered for entire queue');

    try {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        logger.info({ index: i + 1, total: queue.length, awemeId: item.awemeId }, '[Phase3] Processing kuaishou video in queue');

        const riskCheck = await this.detectRiskControlAsync(page);
        if (riskCheck.detected) {
          logger.error({ awemeId: item.awemeId, riskType: riskCheck.type }, '[Phase3] Kuaishou risk control detected — aborting queue processing');
          return { results, riskDetected: true, riskInfo: riskCheck };
        }

        this.interceptor.clear(COMMENT_LIST_PATTERN);

        const drawerOpened = await this.openSelectVideoDrawer(page);
        if (!drawerOpened) {
          logger.error({ awemeId: item.awemeId }, '[Phase3] Failed to open kuaishou drawer — skipping video');
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Failed to open drawer' });
          continue;
        }

        const clicked = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description);
        if (!clicked) {
          logger.error({ awemeId: item.awemeId }, '[Phase3] Failed to find/click video in kuaishou drawer — manually closing and skipping');
          await this.closeDrawer(page);
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Video not found in drawer' });
          continue;
        }

        const reactionDelay = 1200 + Math.random() * 1300;
        logger.info({ awemeId: item.awemeId, reactionDelay: Math.round(reactionDelay) }, '[Phase3] Reaction pause — drawer auto-closes after video selection');
        await HumanActions.wait(page, reactionDelay, reactionDelay + 100);

        const response = await this.waitForCommentResponse(page);

        if (!response) {
          logger.warn({ awemeId: item.awemeId }, '[Phase3] No kuaishou comment API response received');
          const drawerStillOpen = await this.isDrawerVisible(page);
          if (drawerStillOpen) {
            logger.info({ awemeId: item.awemeId }, '[Phase3] Drawer still open after no response — closing manually');
            await this.closeDrawer(page);
          }
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'No API response' });
        } else {
          const comments = this.parseCommentList(response.body);
          logger.info({ awemeId: item.awemeId, totalComments: comments.length }, '[Phase3] Kuaishou comments parsed from API response');

          const lastCommentTime = await db.getLastCommentTime(item.awemeId);
          const freshRootComments = comments.filter(
            c => c.create_time > lastCommentTime && (c.reply_id === '0' || c.reply_id === '' || c.reply_id === null)
          );

          // 先标记该视频所有旧评论为已通知
          await db.markCommentsAsNotified(item.awemeId);

          for (const comment of freshRootComments) {
            await db.upsertComment(item.awemeId, comment);
          }
          await db.updateCommentCount(item.awemeId, item.newCount);

          logger.info({
            awemeId: item.awemeId,
            allComments: comments.length,
            freshRootComments: freshRootComments.length,
            lastCommentTime,
          }, '[Phase3] Kuaishou comments saved to database');

          results.push({ awemeId: item.awemeId, success: true, comments: freshRootComments });
        }

        if (i < queue.length - 1) {
          const transitionDelay = 1200 + Math.random() * 1300;
          logger.info({ delayMs: Math.round(transitionDelay) }, '[Phase3] Transition pause before next video');
          await HumanActions.wait(page, transitionDelay, transitionDelay + 100);
        }

        if ((i + 1) % HumanActions.randomDelay(3, 5) === 0 && i < queue.length - 1) {
          const antiDetectDelay = HumanActions.randomDelay(10000, 20000);
          logger.info({ delayMs: antiDetectDelay, processed: i + 1, remaining: queue.length - i - 1 }, '[Phase3] Anti-detection pause');
          await HumanActions.wait(page, antiDetectDelay, antiDetectDelay + 100);
        }
      }
    } finally {
      if (commentListenerId) {
        this.interceptor.unregister(commentListenerId);
        logger.info('[Phase3] Kuaishou comment API listener unregistered');
      }
    }

    const elapsed = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    logger.info({ elapsed, total: queue.length, success: successCount, failed: failCount }, '[Phase3] Kuaishou queue processing complete');

    return { results, riskDetected: false };
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
    description: string
  ): Promise<boolean> {
    const MAX_SCROLL_ATTEMPTS_DRAWER = 20;
    const descLower = description.toLowerCase();
    const descPrefix = descLower.substring(0, Math.min(descLower.length, 25));

    logger.info({ awemeId, descPrefix }, '[Drawer] Searching for target video in kuaishou drawer');

    for (let scrollAttempt = 0; scrollAttempt <= MAX_SCROLL_ATTEMPTS_DRAWER; scrollAttempt++) {
      await HumanActions.wait(page, 400, 700);

      // 优先使用XPath精确定位（快手抽屉结构固定）
      const videoItemCss = this.xpathToCss(DRAWER_VIDEO_ITEM_XPATH);
      if (videoItemCss) {
        const elements = await HumanActions.queryElementsWithInfo(page, videoItemCss);
        if (elements && elements.length > 0) {
          for (const el of elements) {
            if (!el.visible) continue;

            // 尝试通过标题匹配
            const titleCss = this.xpathToCss(DRAWER_VIDEO_TITLE_XPATH);
            if (titleCss) {
              const titleElements = await HumanActions.queryElementsWithInfo(page, titleCss);
              if (titleElements && titleElements.length > 0) {
                for (const titleEl of titleElements) {
                  if (!titleEl.visible || !titleEl.text) continue;
                  const titleText = titleEl.text.toLowerCase();
                  const matchedExact = titleText.includes(descLower);
                  const matchedPartial = titleText.includes(descPrefix);
                  const matchedReverse = descLower.includes(titleText);

                  if (matchedExact || matchedPartial || matchedReverse) {
                    logger.info({ awemeId, titleText: titleEl.text, matchType: matchedExact ? 'exact' : matchedPartial ? 'partial' : 'reverse' }, '[Drawer] Found kuaishou video by title match (XPath)');

                    let clickNodeId = el.nodeId;
                    for (let level = 0; level < 2; level++) {
                      const parentId = await HumanActions.getNodeParentId(page, clickNodeId);
                      if (!parentId) break;
                      clickNodeId = parentId;
                    }

                    const boxModel = await HumanActions.getElementBoxModel(page, clickNodeId);
                    if (boxModel) {
                      const quad = boxModel.content;
                      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
                      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
                      await HumanActions.clickAtCoordinates(page, x, y);
                      return true;
                    }
                  }
                }
              }
            }

            // 通过元素文本匹配
            if (el.text) {
              const elText = el.text.toLowerCase();
              const matchedExact = elText.includes(descLower);
              const matchedPartial = elText.includes(descPrefix);

              if (matchedExact || matchedPartial) {
                logger.info({ awemeId, descPrefix, matchType: matchedExact ? 'exact' : 'partial' }, '[Drawer] Found kuaishou video by element text (XPath)');
                const boxModel = await HumanActions.getElementBoxModel(page, el.nodeId);
                if (boxModel) {
                  const quad = boxModel.content;
                  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
                  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
                  await HumanActions.clickAtCoordinates(page, x, y);
                  return true;
                }
              }
            }
          }
        }
      }

      // 回退：使用CSS选择器
      const videoItemDef = getSelector('drawer.video-item', PLATFORM);
      const videoItemSelectors = [videoItemDef.css, '[class*="video-item"]', '[class*="work-item"]', '[class*="content-item"]', '[class*="photo-item"]'].filter(Boolean) as string[];

      for (const itemSelector of videoItemSelectors) {
        const elements = await HumanActions.queryElementsWithInfo(page, itemSelector);
        if (!elements || elements.length === 0) continue;

        for (const el of elements) {
          if (!el.visible) continue;

          if (el.text) {
            const elText = el.text.toLowerCase();
            const matchedExact = elText.includes(descLower);
            const matchedPartial = elText.includes(descPrefix);

            if (matchedExact || matchedPartial) {
              logger.info({ awemeId, descPrefix, matchType: matchedExact ? 'exact' : 'partial' }, '[Drawer] Found kuaishou video by element text (CSS fallback)');
              const boxModel = await HumanActions.getElementBoxModel(page, el.nodeId);
              if (boxModel) {
                const quad = boxModel.content;
                const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
                const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
                await HumanActions.clickAtCoordinates(page, x, y);
                return true;
              }
            }
          }

          const dataPhotoId = el.attrs['data-photo-id'] || el.attrs['data-id'] || el.attrs['data-work-id'] || '';
          if (dataPhotoId && dataPhotoId === awemeId) {
            logger.info({ awemeId, matchType: 'data-attribute' }, '[Drawer] Found kuaishou video by data attribute');
            const boxModel = await HumanActions.getElementBoxModel(page, el.nodeId);
            if (boxModel) {
              const quad = boxModel.content;
              const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
              const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
              await HumanActions.clickAtCoordinates(page, x, y);
              return true;
            }
          }
        }
      }

      if (scrollAttempt < MAX_SCROLL_ATTEMPTS_DRAWER) {
        logger.info({ scrollAttempt }, '[Drawer] Video not in current viewport, scrolling kuaishou drawer');

        // 优先使用XPath定位滚动容器
        const scrollContainerCss = this.xpathToCss(DRAWER_SCROLL_CONTAINER_XPATH);
        const drawerScrollDef = getSelector('scroll.drawer', PLATFORM);
        const drawerScrollSelectors = [
          scrollContainerCss,
          drawerScrollDef.css,
          '[class*="sidesheet"] [class*="scroll"]',
          '[class*="drawer"] [class*="scroll"]',
        ].filter(Boolean) as string[];

        const scrollContainer = await HumanActions.cdpFindScrollContainer(page, drawerScrollSelectors);
        if (scrollContainer) {
          await HumanActions.cdpSmartScroll(page, [scrollContainer.sel], 250, 'down');
        } else {
          await HumanActions.cdpSmartScroll(page, [], 250, 'down');
        }
      }
    }

    // 最终回退：使用文本搜索（不依赖XPath或CSS结构）
    logger.info({ awemeId, descPrefix }, '[Drawer] XPath+CSS exhausted, trying text-based fallback');
    // 尝试通过空间过滤文本搜索找到视频（Y范围：抽屉区域通常在中上部）
    const textClicked = await HumanActions.cdpClickByTextFiltered(page, descPrefix.replace(/#/g, '').trim(), {
      timeout: 6000,
      yMin: 150,
      yMax: 700,
      minWidth: 50,
      minHeight: 15,
    });
    if (textClicked) {
      logger.info({ awemeId, descPrefix }, '[Drawer] Found and clicked video via text fallback');
      return true;
    }
    // 终极回退：全页面无过滤文本搜索
    const unfilteredClicked = await HumanActions.cdpClickByText(page, descPrefix.replace(/#/g, '').trim(), { timeout: 5000 });
    if (unfilteredClicked) {
      logger.info({ awemeId, descPrefix }, '[Drawer] Found and clicked video via unfiltered text');
      return true;
    }

    logger.warn({ awemeId, descPrefix, maxScrolls: MAX_SCROLL_ATTEMPTS_DRAWER }, '[Drawer] Kuaishou video not found after exhaustive search');
    return false;
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
}
