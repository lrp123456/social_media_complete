import { Page } from 'patchright';
import { RequestInterceptor, HumanActions, BrowserManager, ExitStrategy, PageType } from '@social-media/browser-core';
import { getSelector, getRandomExitSubmenuKey, getSubmenuKeyForPageType } from './menuSelectors';
import { resolveAndClick, tryClickBySelector } from './menuNavigator';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { isDebugModeEnabled, createReplySessionId, createManifest, saveDebugSnapshot, finishManifest, DebugManifest } from '../lib/replyDebugLogger';
import fs from 'fs';
import path from 'path';

const logger = createLogger('crawler:douyin');

// ── Local type definitions (ported from original ./types and ./interceptor) ──

export type QuerySource = 'work_list' | 'item_list';

export type VideoInfo = {
  aweme_id: string;
  description: string;
  create_time: number;
  comment_count: number;
  metrics: Record<string, any>;
  authorUid?: string;       // 新增：作者抖音 uid
  authorNickname?: string;  // 新增：作者昵称
};

export type CommentInfo = {
  cid: string;
  text: string;
  user_nickname: string;
  user_uid: string;
  digg_count: number;
  create_time: number;
  reply_id: string;
};

export interface CommentNode {
  cid: string;
  text: string;
  userNickname: string;
  userUid: string;
  createTime: number;
  diggCount: number;
  level: 1 | 2;
  rootId?: string;
  parentId?: string;
  replyToName?: string;
  replyId: string;
  subComments?: CommentNode[];
}

export interface RootCommentSnapshot {
  cid: string;
  text: string;
  replyCount: number;
  createTime: number;
  userUid: string;
  userNickname: string;
}

// ── Reply target descriptor (text + time for dual-criteria matching) ──
export interface ReplyTarget {
  text: string;
  createTime: number;
  level: 1 | 2;
  rootText?: string;
}

export type RiskControlDetection = {
  detected: boolean;
  type: string;
  evidence: string;
};

export interface InterceptedResponse {
  url: string;
  status: number;
  body: any;
  timestamp: number;
  hasMore?: boolean;
  cursor?: string;
}

// ── Constants ──

const DOUYIN_HOME = 'https://www.douyin.com';
const CREATOR_HOME = 'https://creator.douyin.com/creator-micro/home';

const WORK_LIST_PATTERN = '/work_list';
const ITEM_LIST_PATTERN = '/item/list';
const COMMENT_LIST_PATTERN = '/aweme/v1/web/comment/list/select';
const COMMENT_REPLY_PATTERN = '/aweme/v1/web/comment/list/reply'; // 子回复 API
const ALL_COMMENT_PATTERNS = [COMMENT_LIST_PATTERN, COMMENT_REPLY_PATTERN];

const MAX_SCROLL_ATTEMPTS = 30;
const MAX_SCROLL_NO_NEW_DATA = 10;

const RISK_CONTROL_KEYWORDS = ['captcha', 'login', '安全验证', '验证码', '账号异常', 'risk', 'verify'];
const RISK_CONTROL_URLS = ['/login', '/passport', '/verify', '/captcha'];

export interface CommentQueueItem {
  awemeId: string;
  description: string;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;  // true = 新视频首次采集（全量展开+建快照）
  _userId: number;        // 内部用，携带 userId
}

export interface CommentProcessResult {
  awemeId: string;
  success: boolean;
  comments: CommentInfo[];
  commentGroups?: Array<{
    rootComment: CommentNode;
    subReplies: CommentNode[];
    newInGroup: CommentNode[];
  }>;
  error?: string;
}

export interface CheckResult {
  hasUpdate: boolean;
  commentsQueue: CommentQueueItem[];
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

export class DouyinCrawler {
  private interceptor: RequestInterceptor;
  private listenerPageId: string | null = null;
  private commentListenerPageId: string | null = null;
  private currentMenuSection: 'content' | 'data_center' | 'activity' | 'unknown' = 'unknown';
  private page?: Page;

  constructor(private maxMonitorVideos: number = 20) {
    this.interceptor = new RequestInterceptor();
  }

  async warmUp(page: Page): Promise<void> {
    logger.info('Starting warm-up route - navigating to douyin.com homepage first');

    try {
      await page.goto(DOUYIN_HOME, { waitUntil: 'domcontentloaded' });
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

      logger.info('Warm-up completed - collected normal interaction fingerprints');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Warm-up failed, proceeding anyway');
    }
  }

  async navigateToCreatorHome(page: Page): Promise<void> {
    const currentUrl = page.url();

    if (currentUrl.includes('creator.douyin.com')) {
      logger.info({ currentUrl }, 'Already on douyin creator page, skipping navigation');
    } else {
      logger.info('Navigating to douyin creator home via click-based menu');
      // 尝试点击"创作者服务平台"链接（防风控）, 失败时回退到 goto
      const clicked = await resolveAndClick(page, 'nav.to-creator', 'douyin', { timeout: 10000 });
      if (clicked) {
        await HumanActions.wait(page, 2000, 4000);
        await HumanActions.pageLoadBehavior(page);
      } else {
        logger.warn('Click-based nav to creator failed, falling back to page.goto');
        await page.goto(CREATOR_HOME, { waitUntil: 'domcontentloaded' });
        HumanActions.clearCDPContext(page);
        await HumanActions.wait(page, 2000, 4000);
        await HumanActions.pageLoadBehavior(page);
      }
    }

    this.currentMenuSection = 'unknown';
    await BrowserManager.logPageHtml(page, 'after_navigateToCreatorHome');
    logger.info({ currentUrl: page.url() }, 'Ready on creator page');
  }

  async registerListener(page: Page, patterns: string[]): Promise<void> {
    this.interceptor.clearAll();

    for (const pattern of patterns) {
      const isItemList = pattern === ITEM_LIST_PATTERN;
      const isCommentList = pattern === COMMENT_LIST_PATTERN;
      this.interceptor.setValidationConfig(pattern, {
        expectedPageUrls: ['creator.douyin.com'],
        requiredItemFields: isCommentList ? ['id'] : (isItemList ? ['id', 'metrics', 'metrics.comment_count'] : ['id']),
        minItems: isCommentList ? 0 : 1,
        requiredUrlParams: isItemList ? ['metrics'] : undefined,
      });
    }

    this.listenerPageId = await this.interceptor.register(page, patterns);

    logger.info({ patterns, rejectionCount: this.interceptor.getRejectionLog().length }, 'Listener registered with validation configs');
  }

  unregisterListener(): void {
    if (this.listenerPageId) {
      const rejectionLog = this.interceptor.getRejectionLog();
      if (rejectionLog.length > 0) {
        logger.warn({ rejectionCount: rejectionLog.length, latestRejections: rejectionLog.slice(-5) }, 'Rejection log summary');
      }
      this.interceptor.unregister(this.listenerPageId);
      this.listenerPageId = null;
    }
    this.interceptor.clearAll();
  }

  /**
   * 注册评论 API 拦截器（Phase2 调用，在导航到评论管理页面之前）
   * 必须在页面加载前注册，才能捕获初始的评论 API 响应
   */
  async registerCommentListener(page: Page): Promise<void> {
    this.unregisterCommentListener();
    for (const p of ALL_COMMENT_PATTERNS) {
      this.interceptor.clear(p);
    }
    this.commentListenerPageId = await this.interceptor.register(page, ALL_COMMENT_PATTERNS);
    logger.info({ commentListenerPageId: this.commentListenerPageId }, 'Douyin comment API listener pre-registered (Phase2)');
  }

  unregisterCommentListener(): void {
    if (this.commentListenerPageId) {
      this.interceptor.unregister(this.commentListenerPageId);
      this.commentListenerPageId = null;
      logger.info('Douyin comment API listener unregistered');
    }
  }

  async fetchVideoListFromSource(page: Page, source: QuerySource): Promise<VideoInfo[]> {
    const pattern = source === 'work_list' ? WORK_LIST_PATTERN : ITEM_LIST_PATTERN;

    this.interceptor.clear(pattern);
    logger.info({ source, step: 'CLEAR_INITIAL' }, 'Cleared interceptor for fresh start');

    const onTarget = this.isOnTargetPage(page, source);
    logger.info({ source, onTarget, url: page.url() }, 'Target page detection');

    if (onTarget) {
      logger.info({ source, url: page.url() }, 'Already on target page — forcing F5 refresh to ensure fresh data');
      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 3000, 5000); // 延长等待，确保页面完全加载
      await HumanActions.pageLoadBehavior(page);
    } else {
      if (source === 'work_list') {
        await this.navigateToWorkList(page);
      } else {
        await this.navigateToItemListMenus(page);
      }
    }

    if (source !== 'work_list') {
      const tabClicked = await this.clickPostListTab(page);
      if (!tabClicked) {
        logger.warn({ source }, '[投稿列表] tab click failed, retrying after extra wait');
        await HumanActions.wait(page, 2000, 3000);
        await this.clickPostListTab(page);
      }
    }

    logger.info({ source, step: 'AFTER_TAB_CLICK', existingResponses: this.interceptor.getResponseCount(pattern) }, 'Tab click complete, waiting for target response');

    let initialResponse = await this.interceptor.waitForResponse(pattern, 15000);

    if (!initialResponse && source !== 'work_list') {
      logger.info({ source }, 'No target response after 15s, compensating with F5 refresh + re-click tab');
      await HumanActions.cdpF5Refresh(page);
      HumanActions.clearCDPContext(page);
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 4000);
      await this.clickPostListTab(page);
      logger.info({ source, step: 'AFTER_COMPENSATION', existingResponses: this.interceptor.getResponseCount(pattern) }, 'Compensation complete, waiting again');
      initialResponse = await this.interceptor.waitForResponse(pattern, 15000);
    }

    if (!initialResponse) {
      logger.error({
        source,
        step: 'NO_RESPONSE',
        totalResponsesInStore: this.interceptor.getResponseCount(pattern),
        rejectionLog: this.interceptor.getRejectionLog(5),
      }, 'No response captured after navigation');
      await BrowserManager.logPageHtml(page, `no_response_${source}`);
      throw new Error(`No response from ${source} after navigation`);
    }

    logger.info({ source, step: 'GOT_INITIAL', hasMore: initialResponse.hasMore, cursor: initialResponse.cursor }, 'Initial API response captured');

    const initialItems = this.interceptor.getCollectedItems(pattern);
    // 诊断日志：打印前5条视频的评论数字段（确认 parseVideoItem 提取是否正确）
    const sampleItems = initialItems.slice(0, 5).map((i: any) => ({
      aweme_id: i.aweme_id,
      desc: i.description?.slice(0, 30),
      comment_count: i.comment_count,
      metrics_keys: i.metrics ? Object.keys(i.metrics).slice(0, 10) : [],
      metrics_comment: i.metrics?.comment_count,
    }));
    logger.info({ source, step: 'INITIAL_ITEMS', initialCount: initialItems.length, sampleItems }, 'Initial video items parsed with comment diagnostics');

    await this.scrollToLoadMoreWithDualStop(page, pattern);

    const allItems = this.interceptor.getCollectedItems(pattern);
    const sliced = allItems.slice(0, this.maxMonitorVideos).map((item: any) => ({
      ...item,
      authorUid: item.author?.uid || '',
      authorNickname: item.author?.nickname || '',
    }));

    logger.info({
      source,
      step: 'FETCH_COMPLETE',
      totalCollected: allItems.length,
      totalResponses: this.interceptor.getResponseCount(pattern),
      finalCount: sliced.length,
      maxMonitor: this.maxMonitorVideos,
      awemeIds: sliced.map(i => i.aweme_id),
    }, 'Video list fetch completed');

    return sliced;
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
        }, 'Background daemon detected new data');
      }

      logger.info({
        step: 'SCROLL_ITERATION',
        totalScrolls,
        collectedCount,
        responseCount,
        maxMonitor: this.maxMonitorVideos,
        scrollsSinceNewData,
        dataExhausted: this.interceptor.hasDataExhausted(pattern),
      }, 'Scroll loop iteration (async dual-track)');

      if (collectedCount >= this.maxMonitorVideos) {
        logger.info({ collectedCount, maxMonitor: this.maxMonitorVideos, totalScrolls }, 'Quantity cap reached - stopping scroll');
        break;
      }

      if (this.interceptor.hasDataExhausted(pattern)) {
        logger.info({ totalScrolls, collectedCount }, 'Data exhausted (has_more=false) - stopping scroll');
        break;
      }

      if (scrollsSinceNewData >= MAX_SCROLL_NO_NEW_DATA) {
        logger.info({ totalScrolls, scrollsSinceNewData, collectedCount }, 'No new data after consecutive scrolls - stopping');
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
        }, 'New data arrived immediately after scroll');
      } else {
        scrollsSinceNewData++;
        logger.info({ step: 'SCROLL_NO_IMMEDIATE_DATA', totalScrolls, scrollsSinceNewData }, 'No immediate data after scroll - continuing rhythm');

        if (scrollsSinceNewData >= 4) {
          logger.info({ step: 'FALLBACK_KEY' }, 'Trying fallback CDP wheel scroll');
          await HumanActions.humanScroll(page, 400, {
            minPause: 300,
            maxPause: 800,
          });
          await HumanActions.wait(page, 1500, 3000);
          const fallbackCount = this.interceptor.getCollectedCount(pattern);
          if (fallbackCount > lastKnownCount) {
            scrollsSinceNewData = 0;
            lastKnownCount = fallbackCount;
            logger.info({ step: 'FALLBACK_KEY_OK' }, 'Fallback scroll triggered new data');
          } else {
            logger.info({ step: 'FALLBACK_KEY_FAIL' }, 'Fallback scroll did not trigger new data');
          }
        }
      }
    }

    logger.info({ step: 'SCROLL_LOOP_DONE', totalScrolls, finalCollected: this.interceptor.getCollectedCount(pattern), finalResponses: this.interceptor.getResponseCount(pattern) }, 'Scroll loop finished');
  }

  private async humanReadingPause(page: Page): Promise<void> {
    const readingDelay = 800 + Math.random() * 700;
    logger.debug({ readingDelay: Math.round(readingDelay) }, 'Human reading pause between scrolls');
    await HumanActions.wait(page, readingDelay, readingDelay + 100);
  }

  private async smartScrollListContainer(page: Page): Promise<void> {
    try {
      // 作品管理页使用 region_work_list_item 作为滚动容器（优先用 CSS fallback）
      const scrollRegionDef = getSelector('region.work-list-scroll');
      // entryToDef 把 primary 映射到 css，但 xpath 选择器不能被 querySelector 使用
      // 回退使用 card-gkf5WW 作为 CSS 选择器
      const mainContentSelector = (
        scrollRegionDef.css?.startsWith('.') || scrollRegionDef.css?.startsWith('#')
          ? scrollRegionDef.css
          : '.card-gkf5WW'
      );

      logger.info({ selector: mainContentSelector }, 'Attempting work-list scroll container');
      await HumanActions.cdpSmartScroll(page, [mainContentSelector], 300, 'down');

      await HumanActions.wait(page, 300, 800);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Smart scroll failed, using viewport center scroll');
      await HumanActions.cdpSmartScroll(page, [], 400, 'down');
      await HumanActions.wait(page, 300, 800);
    }
  }

  private async isSubmenuVisible(page: Page, submenuSelector: string): Promise<boolean> {
    try {
      const visible = await HumanActions.cdpIsElementVisible(page, submenuSelector);
      logger.info({ submenuSelector, visible }, 'Submenu visibility check via CDP DOM');
      return visible;
    } catch (error: any) {
      logger.warn({ submenuSelector, error: error.message }, 'isSubmenuVisible check failed');
      return false;
    }
  }

  private isOnTargetPage(page: Page, source: QuerySource): boolean {
    const url = page.url();

    if (source === 'item_list') {
      return url.includes('data-center') || url.includes('data_center') || url.includes('content_analysis');
    }
    if (source === 'work_list') {
      return url.includes('content/manage') || url.includes('work_manage');
    }
    return false;
  }

  private async navigateToItemListMenus(page: Page): Promise<void> {
    logger.info({ currentMenuSection: this.currentMenuSection }, 'Navigating to data-center content analysis');

    await HumanActions.thinkingPause(page, 400, 1000);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const clicked = await resolveAndClick(page, 'menu.data-center.content-analysis', 'douyin', { timeout: 10000 });

      if (clicked) {
        await HumanActions.wait(page, 1500, 2500);
        logger.info('Navigated to content analysis page');
        this.currentMenuSection = 'data_center';
        return;
      }

      logger.warn({ attempt }, 'Content analysis navigation failed, retrying');
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 1500, 2500);
    }

    logger.error('Menu navigation to content analysis failed after all retries');
  }

  private async clickPostListTab(page: Page): Promise<boolean> {
    logger.info('Clicking [投稿列表] tab');

    const postListDef = getSelector('page.post-list-tab');

    if (postListDef.css) {
      const appeared = await HumanActions.cdpWaitForSelector(page, postListDef.css, {
        state: 'visible',
        timeout: 8000,
        pollInterval: 400,
      });
      if (appeared) {
        await HumanActions.wait(page, 200, 500);
        const clicked = await HumanActions.cdpClick(page, postListDef.css, { timeout: 10000 });
        if (clicked) {
          logger.info('[投稿列表] tab clicked successfully via CSS');
          return true;
        }
        logger.warn('[投稿列表] CSS selector click failed, trying text fallback');
      } else {
        logger.warn('[投稿列表] tab not visible within timeout, trying text fallback');
      }
    }

    if (postListDef.text) {
      const textClicked = await HumanActions.cdpClickByTextFiltered(page, postListDef.text, {
        timeout: 10000,
        minWidth: 20,
        minHeight: 10,
      });
      if (textClicked) {
        logger.info('[投稿列表] tab clicked via text search');
        return true;
      }
    }

    logger.error('[投稿列表] tab click failed after all strategies — proceeding anyway');
    return false;
  }

  private async navigateToWorkList(page: Page): Promise<void> {
    logger.info({ currentMenuSection: this.currentMenuSection }, 'Navigating to work list');

    await HumanActions.thinkingPause(page, 800, 2000);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const clicked = await resolveAndClick(page, 'menu.content.work-manage', 'douyin', { timeout: 10000 });

      if (clicked) {
        await HumanActions.wait(page, 1500, 3000);
        logger.info('Navigated to work list page');
        this.currentMenuSection = 'content';
        return;
      }

      logger.warn({ attempt }, 'Work list navigation failed, retrying');
      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('Menu navigation to work list failed after all retries');
  }

  async executeExitStrategy(page: Page, currentPage: PageType, excludeSubmenuKey?: string): Promise<void> {
    const action = ExitStrategy.getNextPageAction(currentPage);
    const currentSubmenuKey = getSubmenuKeyForPageType(currentPage);
    const excludeKeys = [excludeSubmenuKey, currentSubmenuKey].filter(Boolean) as string[];
    logger.info({ currentPage, action, excludeKeys }, 'Executing exit strategy');

    if (action === 'refresh') {
      const exitAction = ExitStrategy.getRandomExitAction();
      logger.info({ exitAction }, 'Exit action chosen');

      if (exitAction === 'navigate_submenu') {
        // 尝试最多 3 个不同的子菜单，直到成功导航
        const triedKeys: string[] = [];
        let navigated = false;
        for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
          const submenuKey = getRandomExitSubmenuKey('douyin', ...excludeKeys, ...triedKeys);
          triedKeys.push(submenuKey);
          logger.info({ submenuKey, attempt }, 'Navigating to random submenu for exit');

          const urlBefore = page.url();
          const clicked = await resolveAndClick(page, submenuKey, 'douyin', { timeout: 8000 });
          await HumanActions.wait(page, 2000, 3000);
          const urlAfter = page.url();

          if (clicked && urlAfter !== urlBefore) {
            logger.info({ submenuKey, urlAfter }, 'Successfully navigated to submenu');
            this.currentMenuSection = 'unknown';
            navigated = true;
          } else {
            logger.warn({ submenuKey, clicked, urlBefore, urlAfter }, 'Submenu click did not navigate');
          }
        }

        if (!navigated) {
          // 所有子菜单都失败 → CDP F5 刷新 + idle wander
          logger.warn('All submenu navigations failed, falling back to CDP refresh + idle wander');
          await HumanActions.cdpF5Refresh(page);
          HumanActions.clearCDPContext(page);
          this.currentMenuSection = 'unknown';
          await HumanActions.wait(page, 2000, 3000);
          await HumanActions.randomBlankClick(page);
          await HumanActions.humanScroll(page, 100 + Math.random() * 200, { minPause: 200, maxPause: 600 });
          await HumanActions.wait(page, 1000, 2000);
        }
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
      // 切换数据源 — 尝试最多 3 个子菜单
      const triedKeys: string[] = [];
      let navigated = false;
      for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
        const submenuKey = getRandomExitSubmenuKey('douyin', ...excludeKeys, ...triedKeys);
        triedKeys.push(submenuKey);
        logger.info({ submenuKey, attempt }, 'Switching source — navigating to submenu');

        const urlBefore = page.url();
        const clicked = await resolveAndClick(page, submenuKey, 'douyin', { timeout: 8000 });
        await HumanActions.wait(page, 2000, 3000);
        const urlAfter = page.url();

        if (clicked && urlAfter !== urlBefore) {
          this.currentMenuSection = 'unknown';
          navigated = true;
        } else {
          logger.warn({ submenuKey, clicked }, 'Submenu navigation failed for switch source');
        }
      }

      if (!navigated) {
        logger.warn('All submenu navigations failed for switch source, falling back to CDP refresh');
        await HumanActions.cdpF5Refresh(page);
        HumanActions.clearCDPContext(page);
        this.currentMenuSection = 'unknown';
        await HumanActions.wait(page, 2000, 3000);
      }
    }

    logger.info({ finalUrl: page.url(), currentMenuSection: this.currentMenuSection }, 'Exit strategy completed — final page state');
  }

  async fetchCommentDetailsByClick(page: Page, awemeId: string): Promise<CommentInfo[]> {
    this.interceptor.clear(COMMENT_LIST_PATTERN);

    const listenerId = await this.interceptor.register(page, [COMMENT_LIST_PATTERN]);

    try {
      logger.info({ awemeId }, 'Attempting precise click on video row for comments');

      const videoRowSelector = `[data-aweme-id="${awemeId}"], [data-id="${awemeId}"], tr[data-row-key="${awemeId}"]`;
      const clicked = await HumanActions.cdpClick(page, videoRowSelector);

      if (!clicked) {
        logger.info({ awemeId }, 'Precise click selector not found, trying generic video row click');
        const genericSelector = '.video-list-item, .work-list-item, .content-table tr';
        await HumanActions.cdpClick(page, genericSelector);
      }

      await HumanActions.wait(page, 1500, 3000);

      const response = await this.interceptor.waitForResponse(COMMENT_LIST_PATTERN, 10000);
      if (!response) {
        logger.info({ awemeId }, 'No comment response received after click');
        return [];
      }

      const comments = this.parseCommentList(response.body);
      logger.info({ awemeId, totalComments: comments.length }, 'Comments parsed from response');
      return comments;
    } catch (error: any) {
      logger.info({ awemeId, error: error.message }, 'Failed to fetch comments by click');
      return [];
    } finally {
      this.interceptor.unregister(listenerId);
    }
  }

  private parseCommentList(body: any): CommentInfo[] {
    const comments = body.comments;
    if (!comments || !Array.isArray(comments)) return [];

    const rootComments = comments.filter((c: any) => {
      const replyId = c.reply_id ?? c.replyId ?? '0';
      return replyId === 0 || replyId === '0' || replyId === null || replyId === undefined;
    });

    logger.info({ totalReceived: comments.length, rootComments: rootComments.length }, 'Root comment filter applied');

    return rootComments.map((c: any) => ({
      cid: c.cid,
      text: c.text || '',
      user_nickname: c.user?.nickname || '',
      user_uid: c.user?.uid || '',
      digg_count: c.digg_count || 0,
      create_time: c.create_time,
      reply_id: String(c.reply_id ?? c.replyId ?? '0'),
    }));
  }

  /**
   * 从评论列表 API 响应中提取每条根评论的快照（cid + subCommentCount）
   * 用于后续增量对比检测
   * 抖音 API: /comment/list/select → { comments: [...] }
   */
  private parseRootCommentSnapshots(body: any): RootCommentSnapshot[] {
    const comments: any[] = body?.comments || [];
    return comments
      .filter((c: any) => {
        const replyId = c.reply_id ?? '0';
        return replyId === 0 || replyId === '0' || replyId === null;
      })
      .map((c: any) => ({
        cid: c.cid,
        text: c.text || '',
        replyCount: c.reply_comment_total ?? 0,
        createTime: c.create_time,
        userUid: c.user?.uid || '',
        userNickname: c.user?.nickname || '',
      }));
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

  private async expandAllReplies(page: Page, videoId: string, newRootCids: string[]): Promise<Map<string, number>> {
    const replyCounts = new Map<string, number>();
    logger.info({ videoId }, '[Expand] Starting reply expansion');

    const lastCounts = await db.getRootCommentCounts(videoId);

    const expandBtnDef = getSelector('comment.expand-replies');
    const expandSelectors = [
      expandBtnDef.text,
      'text=/查看\\d+条回复/',
      'text=/展开/',
    ].filter(Boolean) as string[];

    const containerDef = getSelector('comment.container');
    const containerCss = containerDef.css || '[data-cid]';

    const containers = await HumanActions.queryElementsWithInfo(page, containerCss);
    logger.info({ containerCount: containers.length }, '[Expand] Found comment containers');

    let expandedCount = 0;
    let skippedCount = 0;
    let containerIdx = 0;

    for (const container of containers) {
      const containerText = container.text || '';

      // 用 container 文本判断是否为根评论（子回复含"回复 @"）
      const isRootComment = !containerText.includes('回复 @');
      if (!isRootComment) continue;

      // 从容器 DOM 获取真实的 data-cid（而非文本截断的假 cid）
      let rootCid = await page.evaluate((idx: number) => {
        const containers = document.querySelectorAll('[data-cid]');
        const el = containers[idx] as HTMLElement;
        return el?.dataset?.cid || '';
      }, containerIdx);
      if (!rootCid) {
        // data-cid 不可用（抖音前端可能更新），用文本片段作为 fallback 标识
        rootCid = containerText.slice(0, 25).replace(/\s+/g, '').toLowerCase() || `fallback-${containerIdx}`;
        logger.info({ rootCid, containerIdx }, '[Expand] data-cid missing, using text fallback');
      }

      const lastCount = lastCounts.get(rootCid);
      const isNewRoot = newRootCids.includes(rootCid);

      // 检查是否有展开按钮（"查看N条回复"）
      const hasExpandBtn = containerText.match(/查看\d+条回复/);
      const currentReplyCount = hasExpandBtn ? parseInt(hasExpandBtn[0].replace(/\D/g, ''), 10) || 0 : 0;

      replyCounts.set(rootCid, currentReplyCount);

      if (!isNewRoot && lastCount !== undefined && currentReplyCount === lastCount) {
        skippedCount++;
        containerIdx++;
        continue;
      }

      // 先将当前根评论容器滚动到视口内（直接操作 scrollTop，避免 wheel 事件抖动）
      await this.scrollCommentArea(page, 100);
      await HumanActions.wait(page, 400, 800);

      for (const sel of expandSelectors) {
        const btnClicked = await HumanActions.cdpClickByText(page, sel, { timeout: 3000 });
        if (btnClicked) {
          await HumanActions.wait(page, 500, 1000);
          expandedCount++;

          // 滚动评论区加载更多
          await HumanActions.humanScroll(page, 200, { minPause: 300, maxPause: 600 });

          // 循环点击"查看N条回复"直到所有回复加载完毕（超过10条回复时每次只加载10条）
          // 抖音的加载更多按钮文本与首次展开相同："查看N条回复"
          let loadMoreRounds = 0;
          const MAX_LOAD_MORE = 10;
          while (loadMoreRounds < MAX_LOAD_MORE) {
            // 先将"查看N条回复"按钮滚动到视口内
            const btnFound = await page.evaluate(() => {
              const all = Array.from(document.querySelectorAll('*'));
              const btn = all.find((el) => {
                const t = (el.textContent || '').trim();
                return /^查看\d+条回复$/.test(t) && el instanceof HTMLElement && el.children.length === 0;
              });
              return !!btn;
            });
            if (!btnFound) break;
            await this.scrollCommentArea(page, 150);
            await HumanActions.wait(page, 300, 600);

            const moreClicked = await this.clickExpandButton(page);
            if (!moreClicked) break;
            loadMoreRounds++;
            await HumanActions.wait(page, 500, 1000);
            await HumanActions.humanScroll(page, 150, { minPause: 200, maxPause: 400 });
          }
          if (loadMoreRounds > 0) {
            expandedCount += loadMoreRounds;
            logger.info({ videoId, rootCid, loadMoreRounds }, '[Expand] Loaded more replies');
          }
          break;
        }
      }

      if (expandedCount % 5 === 0) {
        await HumanActions.wait(page, 1000, 2000);
      }

      containerIdx++;
    }

    logger.info({ videoId, expandedCount, skippedCount, total: containers.length }, '[Expand] Expansion complete');
    return replyCounts;
  }

  /**
   * 只展开一条根评论下的所有子回复（局部展开，用于增量检测）
   * 返回该 root 下新提取到的子回复 DOM 节点信息
   */
  private async expandRepliesForRoot(
    page: Page,
    rootCid: string,
  ): Promise<Array<{ text: string; replyToName: string }>> {
    const replies: Array<{ text: string; replyToName: string }> = [];

    const containerCss = getSelector('comment.container')?.css || '[data-cid]';
    const containers = await HumanActions.queryElementsWithInfo(page, containerCss);
    logger.info({ containerCount: containers.length, rootCid }, '[ExpandRepliesForRoot] Found containers, searching for target');

    // 定位目标 root 的容器（通过文本前缀匹配 rootCid）
    for (let containerIdx = 0; containerIdx < containers.length; containerIdx++) {
      const container = containers[containerIdx];
      const containerText = container.text || '';
      const containerKey = containerText.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
      if (containerKey !== rootCid) continue;

      logger.info({ rootCid }, '[ExpandRepliesForRoot] Found target root container');

      // 检查是否有展开按钮
      const hasExpandBtn = containerText.match(/查看\d+条回复/);
      if (!hasExpandBtn) {
        logger.info({ rootCid }, '[ExpandRepliesForRoot] No expand button — no replies');
        break;
      }

      // 先将当前根评论容器滚动到视口内（直接操作 scrollTop）
      await this.scrollCommentArea(page, 100);
      await HumanActions.wait(page, 400, 800);

      // 在容器内点击"查看 N 条回复"
      const clicked = await this.clickExpandButton(page);

      if (clicked) {
        await HumanActions.wait(page, 500, 1000);
        logger.info({ rootCid }, '[ExpandRepliesForRoot] Container-scoped expand button clicked');
      }

      // 等待子回复 DOM 渲染
      await HumanActions.wait(page, 500, 1000);

      // 提取子回复 DOM 文本
      const subReplies = await page.$$eval('[class*="reply-list"] > div, [class*="reply-list"] > * > div, [class*="sub-comment"] > div, [class*="sub-comment"] > * > div', (els) =>
        els.map((el) => {
          const text = el.textContent?.trim() || '';
          const replyToMatch = text.match(/回复\s*@?(\S+)/);
          return { text, replyToName: replyToMatch?.[1] || '' };
        })
      );

      replies.push(...subReplies);
      logger.info({ rootCid, replyCount: subReplies.length }, '[ExpandRepliesForRoot] Extracted sub-replies');
      break;
    }

    return replies;
  }

  /**
   * 将 API 响应数据（create_time, digg_count, user 信息）合并到 DOM 树节点
   */
  private mergeApiDataToDOM(domNodes: CommentNode[], apiComments: any[]): CommentNode[] {
    for (const node of domNodes) {
      const apiMatch = apiComments.find((c: any) => {
        const apiCid = c.cid || c.comment_id || '';
        return apiCid === node.cid;
      });
      if (apiMatch) {
        node.createTime = apiMatch.create_time || apiMatch.createTime || node.createTime;
        node.diggCount = apiMatch.digg_count || apiMatch.diggCount || node.diggCount || 0;
        node.userUid = apiMatch.user?.uid || apiMatch.userUid || '';
        node.userNickname = apiMatch.user?.nickname || apiMatch.userNickname || node.userNickname || '';
      }
      if (node.subComments) {
        this.mergeApiDataToDOM(node.subComments, apiComments);
      }
    }
    return domNodes;
  }

  private async parseCommentTreeFromDOM(page: Page): Promise<CommentNode[]> {
    const containerDef = getSelector('comment.container');
    const containerCss = containerDef.css || '[data-cid]';

    const result = await page.evaluate((sel: string) => {
      const containers = document.querySelectorAll(sel);
      const comments: any[] = [];
      const seenCids = new Set<string>();

      containers.forEach((c: Element) => {
        const cid = (c as HTMLElement).dataset.cid || '';
        if (!cid || seenCids.has(cid)) return;
        seenCids.add(cid);

        const textEl = c.querySelector('[class*="comment-content-text"]');
        const text = textEl?.textContent?.trim() || '';

        const replyToEl = c.querySelector('[class*="reply-to"]');
        const isSub = !!replyToEl;
        const replyToName = replyToEl?.textContent?.replace(/^回复\s*@/, '').trim() || '';

        const nicknameEl = c.querySelector('[class*="user-name"], [class*="nickname"], [class*="author-name"]');
        const userNickname = nicknameEl?.textContent?.trim() || '';

        const comment: any = {
          cid,
          text,
          userNickname,
          userUid: '',
          createTime: 0,
          diggCount: 0,
          level: isSub ? 2 : 1,
          replyToName,
          replyId: '0',
          subComments: [],
        };

        if (isSub) {
          const replyList = c.closest('[class*="reply-list"]');
          if (replyList) {
            const rootContainer = replyList.closest(sel);
            if (rootContainer) {
              comment.rootId = (rootContainer as HTMLElement).dataset.cid || '';
            }
          }
        } else {
          const replyList = c.querySelector('[class*="reply-list"]');
          if (replyList) {
            const subContainers = replyList.querySelectorAll(sel);
            subContainers.forEach((sub: Element) => {
              const subCid = (sub as HTMLElement).dataset.cid || '';
              if (!subCid) return;
              const subText = sub.querySelector('[class*="comment-content-text"]')?.textContent?.trim() || '';
              const subReplyTo = sub.querySelector('[class*="reply-to"]')?.textContent?.replace(/^回复\s*@/, '').trim() || '';
              const subNick = sub.querySelector('[class*="user-name"], [class*="nickname"]')?.textContent?.trim() || '';
              comment.subComments.push({
                cid: subCid,
                text: subText,
                userNickname: subNick,
                userUid: '',
                createTime: 0,
                diggCount: 0,
                level: 2,
                rootId: cid,
                parentId: '',
                replyToName: subReplyTo,
                replyId: '0',
              });
            });
          }
        }

        comments.push(comment);
      });

      return comments;
    }, containerCss);

    return result;
  }

  async captureRiskScene(page: Page, userId: number, riskType: string): Promise<{ screenshotPath: string | null; htmlPath: string | null }> {
    const sceneDir = path.resolve(process.cwd(), 'data', 'risk_scenes');
    if (!fs.existsSync(sceneDir)) {
      fs.mkdirSync(sceneDir, { recursive: true });
    }

    const timestamp = Date.now();
    const baseName = `risk_${userId}_${riskType}_${timestamp}`;
    let screenshotPath: string | null = null;
    let htmlPath: string | null = null;

    try {
      const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
      screenshotPath = path.join(sceneDir, `${baseName}.png`);
      fs.writeFileSync(screenshotPath, screenshotBuffer);
      logger.info({ screenshotPath, sizeKB: Math.round(screenshotBuffer.length / 1024) }, 'Risk scene screenshot saved');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to capture risk scene screenshot');
    }

    try {
      const html = await HumanActions.cdpGetBodyText(page);
      htmlPath = path.join(sceneDir, `${baseName}.html.txt`);
      fs.writeFileSync(htmlPath, html);
      logger.info({ htmlPath, length: html.length }, 'Risk scene HTML text saved');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Failed to capture risk scene HTML');
    }

    return { screenshotPath, htmlPath };
  }

  async checkForUpdates(
    page: Page,
    userId: number,
    userWindowId: string,
    source: QuerySource
  ): Promise<CheckResult> {
    logger.info({ userId, source }, '[Phase1] Starting update check — collection only mode');

    const riskCheck = await this.detectRiskControlAsync(page);
    if (riskCheck.detected) {
      logger.error({ userId, riskType: riskCheck.type, evidence: riskCheck.evidence }, '[Phase1] Risk control detected before check');
      return {
        hasUpdate: false,
        commentsQueue: [],
        updatedVideos: [],
        riskControlDetected: true,
        riskControlInfo: riskCheck,
      };
    }

    // 查询当前用户，判断是否需要提取平台作者 ID
    const user = await db.getUserById(userId);
    let needAuthorId = !user?.platformAuthorId; // 如果还没存过 authorId 就标记需要提取

    logger.info({ userId }, '[Phase1] Fetching video list from source');
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

    // 抖音两个数据源可能因 item_id/aweme_id 不同导致同一视频被误判为新视频
    // 按 description+createTime 归一化 ID
    const titleToDbId = new Map<string, string>();
    for (const dv of dbVideos) {
      const key = `${dv.description}|${dv.createTime}`;
      titleToDbId.set(key, dv.id);
    }

    for (const v of videos) {
      const key = `${v.description}|${v.create_time}`;
      const existingId = titleToDbId.get(key);
      if (existingId && existingId !== v.aweme_id) {
        logger.info({ oldId: v.aweme_id, normalizedId: existingId, description: v.description?.slice(0, 30) }, '[Phase1] Douyin ID normalized (cross-source dedup)');
        v.aweme_id = existingId;
      }
    }

    logger.info({ userId, dbVideoCount: dbVideos.length, fetchedCount: videos.length }, '[Phase1] Comparing with database records (pre-upsert)');

    const commentsQueue: CommentQueueItem[] = [];

    for (const video of videos) {
      const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
      if (!dbVideo) {
        // 新视频首次入库：如果有评论，入队获取（ID归一化已修复跨源重复）
        if (video.comment_count > 0) {
          logger.info({
            awemeId: video.aweme_id,
            description: video.description,
            commentCount: video.comment_count,
          }, '[Phase1] New video with comments — enqueuing for initial fetch');
          commentsQueue.push({
            awemeId: video.aweme_id,
            description: video.description,
            oldCount: 0,
            newCount: video.comment_count,
            isFirstCrawl: true,
            _userId: userId,
          });
        } else {
          logger.info({ awemeId: video.aweme_id, description: video.description }, '[Phase1] New video with no comments — skipping');
        }

        // 提取作者 ID
        if (needAuthorId && video.authorUid) {
          const userForUpdate = await db.getUserById(userId);
          if (userForUpdate && !userForUpdate.platformAuthorId) {
            await prisma.user.update({
              where: { id: userId },
              data: {
                platformAuthorId: video.authorUid,
                platformAuthorName: video.authorNickname || '',
              },
            });
            needAuthorId = false;
            logger.info({ userId, authorUid: video.authorUid }, '[Phase1] Extracted platform author ID');
          }
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
        }, '[Phase1] Comment count increased — enqueuing for comment fetch (NO click on list page)');

        commentsQueue.push({
          awemeId: video.aweme_id,
          description: video.description,
          oldCount: dbVideo.commentCount,
          newCount: video.comment_count,
          isFirstCrawl: false,
          _userId: userId,
        });
      } else {
        // 评论数未变，但检查是否需要首次深度爬取（无 VideoRootCommentCount 记录）
        const snapshots = await db.getRootCommentCounts(video.aweme_id);
        if (snapshots.size === 0 && video.comment_count > 0) {
          logger.info({
            awemeId: video.aweme_id,
            description: video.description,
          }, '[Phase1] Existing video without snapshots — enqueuing for initial deep crawl');
          commentsQueue.push({
            awemeId: video.aweme_id,
            description: video.description,
            oldCount: dbVideo.commentCount,
            newCount: video.comment_count,
            isFirstCrawl: true,
            _userId: userId,
          });
        } else {
          logger.info({
            awemeId: video.aweme_id,
            current: video.comment_count,
            stored: dbVideo.commentCount,
          }, '[Phase1] Comment count unchanged');
        }
      }
    }

    // 如果循环中未提取到 authorId（所有视频都已入库），从第一个有 authorUid 的视频提取
    if (needAuthorId) {
      for (const video of videos) {
        if (video.authorUid) {
          await prisma.user.update({
            where: { id: userId },
            data: { platformAuthorId: video.authorUid, platformAuthorName: video.authorNickname || '' },
          });
          logger.info({ userId, authorUid: video.authorUid }, '[Phase1] Extracted platform author ID (fallback)');
          break;
        }
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
      logger.error({ userId, riskType: postRiskCheck.type }, '[Phase1] Risk control detected after check');
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
    logger.info('[Phase2] Navigating to comment management page');

    await HumanActions.thinkingPause(page, 800, 2000);

    await this.ensureSidebarReady(page);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const bodyText = await HumanActions.cdpGetBodyText(page);
      const alreadyOnCommentPage = bodyText.includes('评论管理')
        && (bodyText.includes('选择作品') || bodyText.includes('评论列表'));

      if (alreadyOnCommentPage) {
        logger.info({ attempt }, '[Phase2] Already on comment management page');
        return true;
      }

      const commentClicked = await resolveAndClick(page, 'menu.interact.comment-manage', 'douyin', { timeout: 10000 });

      if (commentClicked) {
        logger.info('[Phase2] [评论管理] clicked, waiting for page load');
        await HumanActions.wait(page, 3000, 5000);

        const loaded = await this.waitForCommentManagePage(page);
        if (loaded) {
          logger.info('[Phase2] Comment management page loaded successfully');
          return true;
        }
        logger.warn({ attempt }, '[Phase2] Page elements not fully loaded after click');
      } else {
        logger.warn({ attempt }, '[Phase2] All [评论管理] click attempts failed');
      }

      this.currentMenuSection = 'unknown';
      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('[Phase2] Navigation to comment management failed after all retries');
    return false;
  }

  private async ensureSidebarReady(page: Page): Promise<void> {
    try {
      const sidebarDef = getSelector('region.sidebar');
      const sidebarCss = sidebarDef.css || '.douyin-creator-master-navigation-list';
      const sidebarVisible = await HumanActions.cdpIsElementVisible(page, sidebarCss);
      if (sidebarVisible) return;

      logger.info('[Phase2] Sidebar not fully rendered, clicking home to reset');
      const homeDef = getSelector('menu.home');
      const homeClicked = await HumanActions.cdpClick(page, homeDef.css || '#douyin-creator-master-menu-nav-home', { timeout: 6000 });
      if (homeClicked) {
        await HumanActions.wait(page, 2000, 3500);
      }
    } catch {}
  }

  private async waitForCommentManagePage(page: Page): Promise<boolean> {
    const startTime = Date.now();
    const timeout = 30000;

    while (Date.now() - startTime < timeout) {
      const url = page.url();
      const isCommentPage = url.includes('comment') || url.includes('interact');

      if (isCommentPage) {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        if (bodyText.includes('评论管理') || bodyText.includes('选择作品')) {
          return true;
        }
      }

      const selectWorkVisible = await HumanActions.cdpIsElementVisible(page, 'button:has-text("选择作品")');
      if (selectWorkVisible) return true;

      await HumanActions.wait(page, 800, 1500);
    }

    return false;
  }

  async processCommentsQueue(
    page: Page,
    queue: CommentQueueItem[]
  ): Promise<{ results: CommentProcessResult[]; riskDetected: boolean; riskInfo?: RiskControlDetection }> {
    const results: CommentProcessResult[] = [];
    const startTime = Date.now();

    logger.info({ queueLength: queue.length }, '[Phase3] Starting comment queue processing');

    this.page = page;
    logger.info({ existingListener: this.commentListenerPageId }, '[Phase3] Using pre-registered comment listener from Phase2');

    try {
      // ── 优先处理默认选中视频（页面加载时已显示的评论）──
      // 检查拦截器中是否已有评论 API 响应（默认选中视频的评论数据）
      const existingResp = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
      if (existingResp.length > 0) {
        const defaultComments = existingResp[existingResp.length - 1].body?.comments || [];
        const defaultAwemeIds = [...new Set(defaultComments.map((c: any) => c.aweme_id))];
        // 将队列中匹配默认视频的项移到首位（后续 PreCheck 会直接跳过抽屉）
        for (const awemeId of defaultAwemeIds) {
          const idx = queue.findIndex(item => item.awemeId === awemeId);
          if (idx > 0) {
            const [item] = queue.splice(idx, 1);
            queue.unshift(item);
            logger.info({ awemeId, defaultIdx: idx }, '[Phase3] 默认选中视频已在队列中，移到首位优先处理（无需抽屉）');
            break;
          } else if (idx === 0) {
            logger.info({ awemeId }, '[Phase3] 默认选中视频已是队列首位');
            break;
          }
        }
      } else {
        // 无默认响应，清空拦截器准备下一阶段
        this.interceptor.clear(COMMENT_LIST_PATTERN);
        this.interceptor.clear(COMMENT_REPLY_PATTERN);
      }

      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        logger.info({ index: i + 1, total: queue.length, awemeId: item.awemeId }, '[Phase3] Processing video in queue');

        const riskCheck = await this.detectRiskControlAsync(page);
        if (riskCheck.detected) {
          logger.error({ awemeId: item.awemeId, riskType: riskCheck.type }, '[Phase3] Risk control detected — aborting queue processing');
          return { results, riskDetected: true, riskInfo: riskCheck };
        }

        // ── 快速预检：判断当前页面已加载的评论是否属于目标视频 ──
        // 注意：先检查拦截器已缓存的响应再清空，避免丢失页面初始加载的评论数据
        let allResponses: any[] = [];
        {
          const preCheckStart = Date.now();

          // 先检查拦截器是否已有评论 API 响应（页面加载时默认视频的评论可能已被缓存）
          const existingCommentResp = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
          if (existingCommentResp.length > 0) {
            const latestResp = existingCommentResp[existingCommentResp.length - 1];
            const preComments = latestResp.body?.comments || [];
            const hasTarget = preComments.some((c: any) => c.aweme_id === item.awemeId);
            if (hasTarget) {
              logger.info({ awemeId: item.awemeId, preCheckMs: Date.now() - preCheckStart }, '[Phase3] Target video already loaded (interceptor has response), skipping drawer');
              allResponses = await this.collectAllCommentResponses(page);
            } else {
              logger.info({ awemeId: item.awemeId, preCheckMs: Date.now() - preCheckStart }, '[Phase3] Pre-check: interceptor response for different video, clearing');
              this.interceptor.clear(COMMENT_LIST_PATTERN);
              this.interceptor.clear(COMMENT_REPLY_PATTERN);
            }
          }

          if (allResponses.length === 0) {
            // 无匹配的缓存响应，检查页面 DOM
            const commentInfo = await page.evaluate(() => {
              const commentEls = document.querySelectorAll('[data-cid]');
              const textEls = document.querySelectorAll('[class*="comment-content-text"]');
              return { cidCount: commentEls.length, textCount: textEls.length };
            });
            const hasCommentContent = commentInfo.cidCount > 0 || commentInfo.textCount > 0;
            logger.info({
              awemeId: item.awemeId,
              cidCount: commentInfo.cidCount,
              textCount: commentInfo.textCount,
              preCheckMs: Date.now() - preCheckStart,
            }, '[Phase3] Pre-check: comment content on page');

            if (hasCommentContent) {
              // 页面有评论内容但拦截器无匹配响应 → 直接开抽屉，不浪费时间滚动触发 API
              this.interceptor.clear(COMMENT_LIST_PATTERN);
              this.interceptor.clear(COMMENT_REPLY_PATTERN);
              logger.info({ awemeId: item.awemeId, preCheckMs: Date.now() - preCheckStart }, '[Phase3] Pre-check: page has comments but no matching API response, opening drawer');
            } else {
              logger.info({ awemeId: item.awemeId }, '[Phase3] Pre-check: no comment content on page, opening drawer directly');
            }
          }
        }

        if (allResponses.length === 0) {
          // 打开"选择作品"抽屉 → 找到并点击视频
          const drawerT0 = Date.now();
          const drawerOpened = await this.openSelectWorkDrawer(page);
          logger.info({ awemeId: item.awemeId, drawerMs: Date.now() - drawerT0 }, '[Phase3] Drawer open completed');
          if (!drawerOpened) {
            logger.error({ awemeId: item.awemeId }, '[Phase3] Failed to open drawer — skipping video');
            results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Failed to open drawer' });
            continue;
          }

          const clickT0 = Date.now();
          const clicked = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description);
          logger.info({ awemeId: item.awemeId, clickMs: Date.now() - clickT0, clicked }, '[Phase3] Drawer video click completed');
          if (!clicked) {
            logger.error({ awemeId: item.awemeId }, '[Phase3] Failed to find/click video in drawer — manually closing and skipping');
            await this.closeDrawer(page);
            results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Video not found in drawer' });
            continue;
          }

          const reactionDelay = 1200 + Math.random() * 1300;
          logger.info({ awemeId: item.awemeId, reactionDelay: Math.round(reactionDelay) }, '[Phase3] Reaction pause — drawer auto-closes after video selection');
          await HumanActions.wait(page, reactionDelay, reactionDelay + 100);

          // 拦截并收集所有分页的评论 API 响应（滚动加载直到 has_more=false）
          const collectT0 = Date.now();
          allResponses = await this.collectAllCommentResponses(page);
          logger.info({ awemeId: item.awemeId, collectMs: Date.now() - collectT0, responseCount: allResponses.length }, '[Phase3] Comment API collection completed');
        }

        if (allResponses.length === 0) {
          logger.warn({ awemeId: item.awemeId }, '[Phase3] No comment API response received');
          const drawerStillOpen = await this.isDrawerVisible(page);
          if (drawerStillOpen) {
            logger.info({ awemeId: item.awemeId }, '[Phase3] Drawer still open after no response — closing manually');
            await this.closeDrawer(page);
          }
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'No API response' });
          continue;
        }

        // 合并所有分页的 comments
        const allComments = allResponses.flatMap((r: any) => r.body?.comments || []);
        const wrappedBody = { comments: allComments };
        const pageCommentCounts = allResponses.map((r: any, i: number) => ({
          page: i + 1,
          comments: (r.body?.comments || []).length,
          has_more: r.body?.has_more,
          cursor: r.body?.cursor,
        }));
        logger.info({ awemeId: item.awemeId, pages: allResponses.length, totalComments: allComments.length, pageCommentCounts }, '[Tree] API response pages merged');

        // 从合并后的全量数据解析快照
        const currentSnapshots = this.parseRootCommentSnapshots(wrappedBody);
        logger.info({
          awemeId: item.awemeId,
          snapshotCount: currentSnapshots.length,
          totalResponses: allResponses.length,
          totalComments: allComments.length,
          bodyKeys: allResponses.length > 0 && allResponses[0].body ? Object.keys(allResponses[0].body).join(',') : 'null',
        }, '[Phase3] Root comment snapshots parsed from merged API responses');

        // 加载上次快照
        const lastSnapshots = await db.getRootCommentCounts(item.awemeId);

        // 获取 lastCheckTime 用于过滤新增评论
        const monitorStatus = await prisma.monitorStatus.findFirst({
          where: { accountId: String(item._userId), platform: 'douyin' },
          orderBy: { lastCheckTime: 'desc' },
        });
        const lastCheckTime = monitorStatus?.lastCheckTime?.getTime() || 0;

        const isFirstCrawl = item.isFirstCrawl || lastSnapshots.size === 0;
        logger.info({
          awemeId: item.awemeId,
          isFirstCrawl,
          queueFlag: item.isFirstCrawl,
          snapshotCount: lastSnapshots.size,
          lastCheckTime: lastCheckTime ? new Date(lastCheckTime).toISOString() : 'none',
          newCommentCount: item.newCount,
        }, '[Tree] Decision: isFirstCrawl=%s, proceeding to %s path', isFirstCrawl, isFirstCrawl ? 'first' : 'incremental');

        // ════════════════════════════════════════
        // 公共：展开子回复 + 收集 API 数据（首次和增量都用）
        // ════════════════════════════════════════

        // 使用智能滚动+展开函数处理评论区
        // 始终运行 SmartScroll——即使当前快照显示无回复，滚动过程中可能出现新按钮
        const rootsWithReplies = currentSnapshots.filter(s => s.replyCount > 0).length;
        logger.info({ awemeId: item.awemeId, rootsWithReplies, snapshotCount: currentSnapshots.length }, '[Tree] SmartScroll check: %d roots have replies out of %d snapshots', rootsWithReplies, currentSnapshots.length);
          // 诊断：检查展开按钮是否已渲染到 DOM
          const btnDiagnostic = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            let totalMatches = 0;
            let leafMatches = 0;
            const positions: Array<{ text: string; top: number; visible: boolean }> = [];
            const viewportH = window.innerHeight;
            for (const el of all) {
              const t = (el.textContent || '').trim();
              if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
              totalMatches++;
              const isLeaf = !Array.from(el.children).some(child =>
                /^查看\d+条回复$/.test((child.textContent || '').trim())
              );
              if (!isLeaf) continue;
              leafMatches++;
              const rect = el.getBoundingClientRect();
              positions.push({ text: t, top: Math.round(rect.top), visible: rect.top >= 0 && rect.bottom <= viewportH });
            }
            return { totalMatches, leafMatches, positions };
          });
          logger.info({ awemeId: item.awemeId, rootsWithReplies, btnTotalMatches: btnDiagnostic.totalMatches, btnLeafMatches: btnDiagnostic.leafMatches, btnPositions: btnDiagnostic.positions }, '[Phase3] Pre-SmartScroll expand button diagnostic');

          logger.info({ awemeId: item.awemeId, rootsWithReplies }, '[Phase3] Starting smart scroll and expand');
          const expandT0 = Date.now();
          const expandResult = await this.smartScrollAndExpandReplies(page, item.awemeId);
          logger.info({
            awemeId: item.awemeId,
            expandMs: Date.now() - expandT0,
            totalExpanded: expandResult.totalExpanded,
            totalLoadedMore: expandResult.totalLoadedMore,
            scrollRounds: expandResult.scrollRounds,
          }, '[Phase3] Smart scroll and expand complete');

        // 收集扩展期间拦截器累积的所有响应（select + reply 两个 pattern）
        const allCapturedResponses: any[] = [];
        const responseByPattern: Record<string, number> = {};
        for (const p of ALL_COMMENT_PATTERNS) {
          const resp = this.interceptor.getResponses(p);
          allCapturedResponses.push(...resp);
          responseByPattern[p] = resp.length;
        }
        const expandedComments = allCapturedResponses.flatMap((r: any) => r.body?.comments || []);
        const existingCids = new Set(allComments.map((c: any) => c.cid));
        const trulyNew = expandedComments.filter((c: any) => !existingCids.has(c.cid));
        const allApiComments: any[] = [...allComments, ...trulyNew];

        logger.info({
          awemeId: item.awemeId,
          responseByPattern,
          totalResponses: allCapturedResponses.length,
          expandedTotal: expandedComments.length,
          trulyNew,
          duplicateCount: expandedComments.length - trulyNew.length,
        }, '[Tree] Sub-reply responses collected after expand: %d total, %d truly new', expandedComments.length, trulyNew.length);

        if (isFirstCrawl) {
          // ════════════════════════════════════════
          // 首次采集：保存快照 + isNew=0
          // ════════════════════════════════════════

          logger.info({ awemeId: item.awemeId, snapshotCount: currentSnapshots.length }, '[Tree] Phase3a: saving root snapshots');
          await db.upsertRootCommentCounts(item.awemeId, currentSnapshots.map(s => ({
            cid: s.cid, replyCount: s.replyCount,
          })));

          // 从 API 数据构建评论树
          const rootComments = allApiComments.filter((c: any) => {
            const replyId = c.reply_id ?? '0';
            return replyId === 0 || replyId === '0' || replyId === null;
          });
          const subReplies = allApiComments.filter((c: any) => {
            const replyId = c.reply_id ?? '0';
            return replyId !== 0 && replyId !== '0' && replyId !== null;
          });
          logger.info({ awemeId: item.awemeId, apiTotal: allApiComments.length, roots: rootComments.length, subs: subReplies.length }, '[Tree] Phase3b: comment tree split — roots=%d subs=%d', rootComments.length, subReplies.length);

          const allFlat: Array<{
            cid: string; text: string; user_nickname: string; user_uid: string;
            digg_count: number; create_time: number; reply_id: string;
            rootId?: string; parentId?: string; level: number; replyToName?: string;
          }> = [];

          for (const root of rootComments) {
            allFlat.push({
              cid: root.cid, text: root.text || '',
              user_nickname: root.user?.nickname || '', user_uid: root.user?.uid || '',
              digg_count: root.digg_count || 0, create_time: root.create_time,
              reply_id: '0', level: 1,
            });
          }
          for (const sub of subReplies) {
            const replyId = String(sub.reply_id ?? '0');
            allFlat.push({
              cid: sub.cid, text: sub.text || '',
              user_nickname: sub.user?.nickname || '', user_uid: sub.user?.uid || '',
              digg_count: sub.digg_count || 0, create_time: sub.create_time,
              reply_id: replyId, rootId: replyId, parentId: replyId,
              level: 2, replyToName: sub.reply_to_username || '',
            });
          }

          const dbStart = Date.now();
          await db.upsertCommentTree(item.awemeId, allFlat);
          await prisma.comment.updateMany({ where: { videoId: item.awemeId }, data: { isNew: 0 } });
          await db.updateCommentCount(item.awemeId, item.newCount);
          const dbMs = Date.now() - dbStart;

          logger.info({ awemeId: item.awemeId, totalComments: allFlat.length, roots: rootComments.length, subs: subReplies.length, isFirstCrawl: true, dbWriteMs: dbMs }, '[Tree] Phase3c: first crawl DB write complete — all comments saved as isNew=0 (%dms)', dbMs);

          results.push({ awemeId: item.awemeId, success: true, comments: [], commentGroups: [] } as any);
        } else {
          // ════════════════════════════════════════
          // 后续增量检测：对比快照 + 新增/变更加载
          // ════════════════════════════════════════

          const newCommentsToUpsert: Array<{
            cid: string; text: string; user_nickname: string; user_uid: string;
            digg_count: number; create_time: number; reply_id: string;
            rootId?: string; parentId?: string; level: number; replyToName?: string;
          }> = [];

          const apiRootCids = new Set(currentSnapshots.map(s => s.cid));
          const dbRootCids = new Set(lastSnapshots.keys());

          // 获取作者 ID 用于过滤（作者的评论不计为新增）
          const currentUser = await db.getUserById(item._userId!);
          const platformAuthorId = currentUser?.platformAuthorId;

          logger.info({
            awemeId: item.awemeId,
            apiRootCount: apiRootCids.size,
            dbRootCount: dbRootCids.size,
            authorFilter: !!platformAuthorId,
            lastCheckTime: lastCheckTime ? new Date(lastCheckTime).toISOString() : 'none',
          }, '[Tree] Incremental: starting comparison — API roots=%d DB roots=%d', apiRootCids.size, dbRootCids.size);

          // ── 3a. 新增根评论 ──
          let newRootsFrom3a = 0;
          for (const snapshot of currentSnapshots) {
            if (!dbRootCids.has(snapshot.cid)) {
              if (snapshot.createTime * 1000 > lastCheckTime) {
                const isAuthor = platformAuthorId ? snapshot.userUid === platformAuthorId : false;
                newRootsFrom3a++;
                newCommentsToUpsert.push({
                  cid: snapshot.cid,
                  text: snapshot.text,
                  user_nickname: snapshot.userNickname,
                  user_uid: snapshot.userUid,
                  digg_count: 0,
                  create_time: snapshot.createTime,
                  reply_id: '0',
                  rootId: undefined,
                  parentId: undefined,
                  level: 1,
                  replyToName: undefined,
                });
              }
            }
          }

          logger.info({ awemeId: item.awemeId, newRootsFrom3a }, '[Tree] Incremental 3a: new root comments found=%d', newRootsFrom3a);

          // ── 3b-0. 将 trulyNew 中的子评论直接计入 newSubs ──
          let newSubsFromTrulyNew = 0;
          for (const c of trulyNew) {
            const replyId = c.reply_id ?? '0';
            const isSub = replyId !== 0 && replyId !== '0' && replyId !== null;
            if (!isSub) continue;
            const createTime = c.create_time || 0;
            if (createTime * 1000 <= lastCheckTime) continue;
            const isAuthor = platformAuthorId ? (c.user?.uid || '') === platformAuthorId : false;
            if (isAuthor) continue;
            newSubsFromTrulyNew++;
            newCommentsToUpsert.push({
              cid: String(c.cid || ''),
              text: c.text || '',
              user_nickname: c.user?.nickname || '',
              user_uid: c.user?.uid || '',
              digg_count: c.digg_count || 0,
              create_time: createTime,
              reply_id: String(replyId),
              rootId: String(replyId),
              parentId: String(replyId),
              level: 2,
              replyToName: c.reply_to_reply_id ? undefined : undefined,
            });
          }
          if (newSubsFromTrulyNew > 0) {
            logger.info({ awemeId: item.awemeId, count: newSubsFromTrulyNew }, '[Tree] Incremental 3b-0: new subs from API interceptor=%d', newSubsFromTrulyNew);
          }

          // ── 3b. 根评论 replyCount 增加 → 局部展开 ──
          let rootsWithReplyIncrease = 0;
          let newSubsFrom3b = 0;
          for (const snapshot of currentSnapshots) {
            const lastCount = lastSnapshots.get(snapshot.cid);
            if (lastCount !== undefined && snapshot.replyCount > lastCount) {
              rootsWithReplyIncrease++;
              const diff = snapshot.replyCount - lastCount;
              logger.info({ awemeId: item.awemeId, rootCid: snapshot.cid, oldReplyCount: lastCount, newReplyCount: snapshot.replyCount, diff }, '[Tree] Incremental 3b: replyCount increased for root');
              const replies = await this.expandRepliesForRoot(page, snapshot.cid);
              if (replies.length > 0) {
                const apiReplies = (allApiComments || []).filter(
                  (c: any) => String(c.reply_id) === snapshot.cid
                );

                for (const reply of replies) {
                  const apiMatch = apiReplies.find((c: any) => c.text?.includes(reply.text.slice(0, 10)));
                  const createTime = apiMatch?.create_time || 0;
                  const userUid = apiMatch?.user?.uid || '';
                  const userNickname = apiMatch?.user?.nickname || '';

                  if (createTime * 1000 > lastCheckTime) {
                    const isAuthor = platformAuthorId ? userUid === platformAuthorId : false;
                    if (!isAuthor) {
                      newSubsFrom3b++;
                      newCommentsToUpsert.push({
                        cid: apiMatch?.cid || '',
                        text: reply.text,
                        user_nickname: userNickname,
                        user_uid: userUid,
                        digg_count: apiMatch?.digg_count || 0,
                        create_time: createTime,
                        reply_id: snapshot.cid,
                        rootId: snapshot.cid,
                        parentId: snapshot.cid,
                        level: 2,
                        replyToName: reply.replyToName,
                      });
                    }
                  }
                }
              }
            }
          }

          // ── 3c. 清理已不存在的 rootCid ──
          await db.deleteStaleRootCounts(item.awemeId, currentSnapshots.map(s => s.cid));

          // ── 3d. 更新快照 ──
          await db.upsertRootCommentCounts(item.awemeId, currentSnapshots.map(s => ({
            cid: s.cid,
            replyCount: s.replyCount,
          })));

          // ── 3e. 新评论入库（isNew=1 由 upsertCommentTree 自动设置）──
          const dbStart = Date.now();
          if (newCommentsToUpsert.length > 0) {
            await db.upsertCommentTree(item.awemeId, newCommentsToUpsert);
          }

          // ── 3f. 更新 commentCount ──
          await db.updateCommentCount(item.awemeId, item.newCount);
          const dbMs = Date.now() - dbStart;

          logger.info({
            awemeId: item.awemeId,
            totalSnapshots: currentSnapshots.length,
            newRoots: newRootsFrom3a,
            newSubs: newSubsFromTrulyNew + newSubsFrom3b,
            rootsWithReplyIncrease,
            totalNewComments: newCommentsToUpsert.length,
            isFirstCrawl: false,
            dbWriteMs: dbMs,
          }, '[Tree] Incremental complete: %d new roots + %d new subs (%d from API + %d from expand) = %d total, DB write %dms', newRootsFrom3a, newSubsFromTrulyNew + newSubsFrom3b, newSubsFromTrulyNew, newSubsFrom3b, newCommentsToUpsert.length, dbMs);

          // 构建 commentGroups 用于返回（只包含有新增的组）
          const involvedRootCids = new Set<string>();
          for (const n of newCommentsToUpsert) {
            if (n.level === 1) involvedRootCids.add(n.cid);
            if (n.level === 2 && n.rootId) involvedRootCids.add(n.rootId);
          }

          const commentGroups: Array<{
            rootComment: CommentNode;
            subReplies: CommentNode[];
            newInGroup: CommentNode[];
          }> = [];

          for (const snapshot of currentSnapshots) {
            if (involvedRootCids.has(snapshot.cid)) {
              const groupNew = newCommentsToUpsert.filter(n =>
                n.cid === snapshot.cid || n.rootId === snapshot.cid
              );
              commentGroups.push({
                rootComment: {
                  cid: snapshot.cid,
                  text: snapshot.text,
                  userNickname: snapshot.userNickname,
                  userUid: snapshot.userUid,
                  createTime: snapshot.createTime,
                  diggCount: 0,
                  level: 1,
                  replyId: '0',
                  subComments: [],
                },
                subReplies: [],
                newInGroup: groupNew.map(n => ({
                  cid: n.cid,
                  text: n.text,
                  userNickname: n.user_nickname,
                  userUid: n.user_uid,
                  createTime: n.create_time,
                  diggCount: n.digg_count || 0,
                  level: n.level as 1 | 2,
                  rootId: n.rootId || undefined,
                  parentId: n.parentId || undefined,
                  replyToName: n.replyToName || undefined,
                  replyId: n.reply_id || '0',
                  subComments: [],
                })),
              });
            }
          }

          logger.info({
            awemeId: item.awemeId,
            totalSnapshots: currentSnapshots.length,
            newComments: newCommentsToUpsert.length,
            isFirstCrawl: false,
          }, '[Phase3] Incremental detection complete');

          results.push({
            awemeId: item.awemeId,
            success: true,
            comments: newCommentsToUpsert as any,
            commentGroups,
          } as any);
        }

      // 每个视频处理后关闭抽屉（抽屉打开时会自动定位到按钮，无需手动回顶）
      const closeT0 = Date.now();
      await this.closeDrawer(page).catch(() => {});
      logger.info({ awemeId: item.awemeId, closeMs: Date.now() - closeT0 }, '[Phase3] Drawer close completed');

      if (i < queue.length - 1) {
        const transitionDelay = 1200 + Math.random() * 1300;
        logger.info({ delayMs: Math.round(transitionDelay) }, '[Phase3] Transition pause before next video (human reaction time)');
        await HumanActions.wait(page, transitionDelay, transitionDelay + 100);
      }

        if ((i + 1) % HumanActions.randomDelay(3, 5) === 0 && i < queue.length - 1) {
          const antiDetectDelay = HumanActions.randomDelay(10000, 20000);
          logger.info({ delayMs: antiDetectDelay, processed: i + 1, remaining: queue.length - i - 1 }, '[Phase3] Anti-detection pause');
          await HumanActions.wait(page, antiDetectDelay, antiDetectDelay + 100);
        }
      }
    } finally {
      logger.info('[Phase3] Comment queue processing finished');
    }

    const elapsed = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    logger.info({ elapsed, total: queue.length, success: successCount, failed: failCount }, '[Phase3] Queue processing complete');

    return { results, riskDetected: false };
  }

  private async openSelectWorkDrawer(page: Page): Promise<boolean> {
    const maxRetries = 2;
    const selectWorkDef = getSelector('page.select-work-btn');

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const attemptT0 = Date.now();
      logger.info({ attempt }, '[Drawer] Attempting to open [选择作品] drawer');

      // 回顶部：hover 到主内容区域 → 鼠标滚轮向上滚
      const scrollT0 = Date.now();
      await HumanActions.withCDPContext(page, async (ctx) => {
        const viewport = await ctx.cdp.getLayoutViewport();
        const hoverX = Math.round(viewport.clientWidth * 0.6 + (Math.random() - 0.5) * 100);
        const hoverY = Math.round(viewport.clientHeight * 0.4 + (Math.random() - 0.5) * 100);
        await ctx.mouse.moveTo({ x: hoverX, y: hoverY });
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        for (let i = 0; i < 20; i++) {
          await ctx.mouse.dispatchWheel(0, -(300 + Math.random() * 200));
          await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
        }
      });
      await HumanActions.wait(page, 500, 1000);
      logger.info({ scrollMs: Date.now() - scrollT0 }, '[Drawer] Scroll-to-top completed');

      // 精确定位评论管理页的"选择作品"按钮
      const clickT0 = Date.now();
      const clicked = await HumanActions.cdpClick(
        page,
        '.container-AFENbv button.douyin-creator-interactive-button-primary, .header-TONxG8 button',
        { timeout: 8000 }
      );
      logger.info({ clickMs: Date.now() - clickT0, clicked }, '[Drawer] Button click completed');

      if (clicked) {
        const waitT0 = Date.now();
        await HumanActions.wait(page, 1500, 3000);
        logger.info({ waitMs: Date.now() - waitT0 }, '[Drawer] Post-click wait completed');

        const detectT0 = Date.now();
        const drawerVisible = await this.isDrawerVisible(page);
        logger.info({ detectMs: Date.now() - detectT0, visible: drawerVisible }, '[Drawer] Visibility check completed');
        if (drawerVisible) {
          const contentT0 = Date.now();
          const contentLoaded = await this.waitForDrawerContent(page);
          logger.info({ contentMs: Date.now() - contentT0, loaded: contentLoaded }, '[Drawer] Content load wait completed');
          if (contentLoaded) {
            logger.info({ attemptMs: Date.now() - attemptT0 }, '[Drawer] Drawer confirmed visible with content loaded');
            return true;
          }
          logger.warn({ attempt }, '[Drawer] Drawer visible but content not loaded — retrying');
        } else {
          logger.warn({ attempt }, '[Drawer] Click succeeded but drawer not detected — retrying');
        }
        // 不 return true，继续重试
      } else {
        logger.warn({ attempt }, '[Drawer] All click methods failed');
        await HumanActions.wait(page, 1000, 2000);
      }
    }

    logger.error('[Drawer] Failed to open drawer after all retries');
    return false;
  }

  private async isDrawerVisible(page: Page): Promise<boolean> {
    try {
      // 检测抽屉遮罩层：通过 evaluate 判断元素是否存在且宽高 > 0
      const hasMask = await page.evaluate(() => {
        const maskSelectors = [
          '.douyin-creator-interactive-sidesheet-mask',
          '[class*="semi-sidesheet-mask"]',
          '[class*="drawer-mask"]',
          '[class*="sidesheet-mask"]',
        ];
        for (const sel of maskSelectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 50) {
              return true;
            }
          }
        }
        return false;
      });
      if (hasMask) {
        logger.info('Drawer detected: mask element visible');
        return true;
      }

      // 回退：检测抽屉侧面板或内容区
      const drawerSelectors = [
        getSelector('drawer.portal').css,
        getSelector('drawer.sidesheet').css,
        getSelector('drawer.content').css,
      ].filter(Boolean) as string[];

      for (const selector of drawerSelectors) {
        const visible = await HumanActions.cdpIsElementVisible(page, selector);
        if (visible) {
          logger.info({ selector }, 'Drawer detected: panel element visible');
          return true;
        }
      }

      // 最终回退：检查 body 是否有 overflow:hidden（抽屉打开时 body 会被锁定）
      const bodyOverflow = await page.evaluate(() => {
        const body = document.body;
        const style = body?.getAttribute('style') || '';
        return style.includes('overflow: hidden') || style.includes('overflow:hidden');
      });
      if (bodyOverflow) {
        // body 被锁定但需要排除正常页面滚动锁定
        // 检查是否有 video-info 元素（抽屉内特有）
        const hasVideoInfo = await page.evaluate(() => {
          return document.querySelectorAll('.video-info, [class*="douyin-creator-interactive-list-items"] > div').length > 0;
        });
        if (hasVideoInfo) {
          logger.info('Drawer detected: body locked + video items present');
          return true;
        }
      }

      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        // "选择作品" 在主页面就存在，不能作为抽屉判断依据
        // 改用抽屉内特有的视频条目文本（"发布于" + "评论数" 同时出现说明是抽屉视频列表）
        if (bodyText.includes('发布于') && bodyText.includes('评论数') && bodyText.includes('选择作品')) {
          // 额外检查：主页面评论区通常不会有"发布于"文字，只有抽屉视频列表才有
          const hasDrawerVideoItems = await page.evaluate(() => {
            // 检查是否有抽屉特有的视频条目（非主页面内容）
            const items = document.querySelectorAll('[class*="video-item"], [class*="douyin-creator-interactive-list-items"] > div, [class*="work-item"]');
            return items.length > 0;
          });
          if (hasDrawerVideoItems) {
            logger.info('Drawer content detected via body text + video items');
            return true;
          }
        }
      } catch {}

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Wait for drawer video list content to load.
   * Checks for video item containers inside the drawer.
   */
  private async waitForDrawerContent(page: Page): Promise<boolean> {
    const maxWait = 8000;
    const interval = 500;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const hasContent = await page.evaluate(() => {
        // Check for any video item containers in the drawer
        const selectors = [
          '[class*="douyin-creator-interactive-list-items"] > div',
          '[class*="video-item"]',
          '[class*="work-item"]',
          '[class*="content-item"]',
          '.video-info',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) return true;
        }
        return false;
      });

      if (hasContent) {
        logger.info({ elapsed: Date.now() - start }, '[Drawer] Video items detected in drawer');
        return true;
      }

      await HumanActions.wait(page, interval, interval + 100);
    }

    logger.warn({ elapsed: Date.now() - start }, '[Drawer] Timed out waiting for video items');
    return false;
  }

  private async closeDrawer(page: Page): Promise<boolean> {
    try {
      const maskDef = getSelector('drawer.mask');
      if (maskDef.css) {
        const maskVisible = await HumanActions.cdpIsElementVisible(page, maskDef.css);
        if (maskVisible) {
          await HumanActions.cdpClick(page, maskDef.css, { timeout: 5000 });
          await HumanActions.wait(page, 800, 1500);
        }
      }

      let drawerGone = !(await this.isDrawerVisible(page));

      if (!drawerGone) {
        const confirmDef = getSelector('drawer.confirm-btn');
        const confirmSelectors = [confirmDef.css, ...(confirmDef.text ? [`button:has-text("${confirmDef.text}")`] : [])].filter(Boolean) as string[];
        for (const selector of confirmSelectors) {
          const clicked = await HumanActions.cdpClick(page, selector, { timeout: 3000 });
          if (clicked) {
            await HumanActions.wait(page, 800, 1500);
            drawerGone = !(await this.isDrawerVisible(page));
            if (drawerGone) break;
          }
        }
      }

      if (!drawerGone) {
        await HumanActions.cdpKeyPress(page, 'Escape', 'Escape', 27);
        await HumanActions.wait(page, 800, 1500);
        drawerGone = !(await this.isDrawerVisible(page));
      }

      if (drawerGone) {
        logger.info('[Drawer] Drawer closed successfully');
      } else {
        logger.warn('[Drawer] Drawer may still be visible after close attempts');
      }
      return drawerGone;
    } catch (error: any) {
      logger.warn({ error: error.message }, '[Drawer] Error closing drawer');
      return false;
    }
  }

  private async findAndClickVideoInDrawer(
    page: Page,
    awemeId: string,
    description: string
  ): Promise<boolean> {
    const MAX_SCROLL_ATTEMPTS_DRAWER = 25;
    const descLower = description.toLowerCase();
    const descPrefix = descLower.substring(0, Math.min(descLower.length, 25));

    logger.info({ awemeId, descPrefix }, '[Drawer] Searching for target video in drawer');

    for (let scrollAttempt = 0; scrollAttempt <= MAX_SCROLL_ATTEMPTS_DRAWER; scrollAttempt++) {
      await HumanActions.wait(page, 400, 700);

      const containerSelector = getSelector('drawer.video-item').css || '[class*="douyin-creator-interactive-list-items"] > div';
      const containerElements = await HumanActions.queryElementsWithInfo(page, containerSelector);
      if (!containerElements || containerElements.length === 0) {
        logger.info({ scrollAttempt }, '[Drawer] No video containers found in current viewport');
        if (scrollAttempt < MAX_SCROLL_ATTEMPTS_DRAWER) {
          await this.scrollDrawerForMore(page, scrollAttempt);
        }
        continue;
      }

      logger.info({ count: containerElements.length, scrollAttempt }, '[Drawer] Found video containers');

      let matchedContainer: { nodeId: number; text: string } | null = null;
      let matchType = '';

      for (const container of containerElements) {
        const containerText = container.text || '';
        const matchedExact = containerText.includes(descLower);
        const matchedPartial = containerText.includes(descPrefix);
        const matchedReverse = descLower.length > 5 && containerText.length > 5 && descLower.includes(containerText.substring(0, Math.min(containerText.length, 25)));

        if (matchedExact || matchedPartial || matchedReverse) {
          matchedContainer = { nodeId: container.nodeId, text: containerText };
          matchType = matchedExact ? 'exact' : matchedPartial ? 'partial' : 'reverse';
          break;
        }
      }

      if (!matchedContainer) {
        logger.info({ scrollAttempt, containerCount: containerElements.length }, '[Drawer] No match in current containers, scrolling for more');
        if (scrollAttempt < MAX_SCROLL_ATTEMPTS_DRAWER) {
          await this.scrollDrawerForMore(page, scrollAttempt);
        }
        continue;
      }

      logger.info({ awemeId, matchType, text: matchedContainer.text.substring(0, 50) }, '[Drawer] Found matching video — stopping scroll, attempting click');

      const clicked = await HumanActions.cdpClickNode(page, matchedContainer.nodeId);
      if (clicked) {
        logger.info('[Drawer] Successfully clicked video via cdpClickNode');
        return true;
      }

      logger.info('[Drawer] Direct cdpClickNode failed, trying re-query + click');
      await HumanActions.wait(page, 500, 1000);

      const reClicked = await this.tryClickMatchedContainer(page, descLower, descPrefix);
      if (reClicked) return true;

      logger.warn({ awemeId }, '[Drawer] Match found but click failed after scrollIntoView + re-query — giving up on this video to avoid flicker');
      return false;
    }

    logger.warn({ awemeId, descPrefix, maxScrolls: MAX_SCROLL_ATTEMPTS_DRAWER }, '[Drawer] Video not found after exhaustive search');
    return false;
  }

  private async tryClickMatchedContainer(page: Page, descLower: string, descPrefix: string): Promise<boolean> {
    const containerSelector = getSelector('drawer.video-item').css || '[class*="douyin-creator-interactive-list-items"] > div';
    const containerElements = await HumanActions.queryElementsWithInfo(page, containerSelector);
    if (!containerElements) return false;

    for (const container of containerElements) {
      const containerText = container.text || '';
      const matched = containerText.includes(descLower) || containerText.includes(descPrefix);
      if (!matched) continue;

      logger.info({ text: containerText.substring(0, 50) }, '[Drawer] Matched container, attempting cdpClickNode');

      const clicked = await HumanActions.cdpClickNode(page, container.nodeId);
      if (clicked) {
        logger.info('[Drawer] Successfully clicked video container via cdpClickNode');
        return true;
      }

      logger.info('[Drawer] Container click failed, trying title node');

      const titleSelector = getSelector('drawer.video-title').css || '[class*="douyin-creator-interactive-list-items"] [class*="title-"]';
      const titleEls = await HumanActions.queryElementsWithInfo(page, titleSelector);
      if (titleEls) {
        for (const titleEl of titleEls) {
          if (titleEl.text && (titleEl.text.includes(descLower) || titleEl.text.includes(descPrefix))) {
            const titleClicked = await HumanActions.cdpClickNode(page, titleEl.nodeId);
            if (titleClicked) {
              logger.info('[Drawer] Successfully clicked title node via cdpClickNode');
              return true;
            }
          }
        }
      }

      break;
    }

    return false;
  }

  /**
   * 滚动抽屉：hover 到抽屉容器 → 模拟鼠标滚轮
   */
  private async scrollDrawerForMore(page: Page, scrollAttempt: number): Promise<void> {
    logger.info({ scrollAttempt }, '[Drawer] Scrolling drawer to load more videos');

    const drawerSelectors = [
      '.douyin-creator-interactive-sidesheet-body',
      '[class*="sidesheet-body"]',
      'ul.douyin-creator-interactive-list-items',
      '.drawer__content',
    ];

    await HumanActions.withCDPContext(page, async (ctx) => {
      // 0. 刷新 CDP DOM 树（抽屉刚打开，旧树可能找不到抽屉容器）
      await ctx.dom.refreshDocument();

      // 1. 找到抽屉滚动容器
      let containerRect: { x: number; y: number; width: number; height: number } | null = null;
      for (const sel of drawerSelectors) {
        const nodeId = await ctx.cdp.querySelector(sel);
        if (nodeId && nodeId > 0) {
          const box = await ctx.cdp.getBoxModel(nodeId);
          if (box && box.width > 0 && box.height > 0) {
            containerRect = {
              x: box.content[0],
              y: box.content[1],
              width: box.width,
              height: box.height,
            };
            logger.info({ selector: sel }, '[Drawer] Found scrollable drawer container');
            break;
          }
        }
      }

      if (!containerRect) {
        logger.warn('[Drawer] No scrollable drawer container found');
        return;
      }

      // 2. hover 到抽屉容器底部区域（滚动方向向下，鼠标靠近底部更容易触发滚动）
      const hoverX = Math.round(containerRect.x + containerRect.width * (0.3 + Math.random() * 0.4));
      const hoverY = Math.round(containerRect.y + containerRect.height * (0.6 + Math.random() * 0.2));
      await ctx.mouse.moveTo({ x: hoverX, y: hoverY });
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

      // 3. 分段滚动：每次滚 150-250px，段间等待 500-800ms 让无限滚动加载新内容
      const segments = 2 + Math.floor(Math.random() * 2); // 2-3 段
      for (let seg = 0; seg < segments; seg++) {
        const segAmount = 150 + Math.random() * 100;
        let remaining = segAmount;
        while (remaining > 0) {
          const step = Math.min(50 + Math.random() * 50, remaining);
          await ctx.mouse.dispatchWheel(0, step);
          remaining -= step;
          await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
        }
        // 段间等待，让无限滚动触发加载
        if (seg < segments - 1) {
          await new Promise(r => setTimeout(r, 500 + Math.random() * 300));
        }
      }

      logger.info({ segments }, '[Drawer] Drawer scrolled incrementally via hover + wheel');
    });

    await HumanActions.wait(page, 1000, 2000);
  }

  /**
   * 点击视口内的"查看N条回复"按钮（page.evaluate 定位 + CDP 鼠标点击）
   * 不用 cdpClickByText，因为 performSearch 不支持正则匹配
   * @returns 点击的按钮文本，或 null
   */
  private async clickExpandButton(page: Page): Promise<string | null> {
    const btnPos = await page.evaluate(() => {
      const viewportH = window.innerHeight;
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
        const isLeaf = !Array.from(el.children).some(child =>
          /^查看\d+条回复$/.test((child.textContent || '').trim())
        );
        if (!isLeaf) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top >= 0 && rect.bottom <= viewportH && rect.width > 0 && rect.height > 0) {
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), text: t };
        }
      }
      return null;
    });

    if (!btnPos) return null;

    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.mouse.moveTo({ x: btnPos.x, y: btnPos.y });
      await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
      await ctx.mouse.clickAt(btnPos.x, btnPos.y);
    });

    logger.info({ text: btnPos.text, x: btnPos.x, y: btnPos.y }, '[Expand] Clicked expand button');
    return btnPos.text;
  }

  /**
   * 滚动评论区加载所有分页的评论 API 响应
   * 抖音评论 API /comment/list/select 每页返回最多 ~10 条，
   * 需要通过滚动触发后续分页请求，直到 has_more === 0
   */
  /**
   * Scroll the comment-area container by setting its scrollTop directly.
   * This is far more reliable than `End` key + cdpSmartScroll because:
   *  - `End` key scrolls the PAGE (body), not the comment scroll container
   *  - cdpSmartScroll selectors (`[class*="comment"] [class*="scroll"]`) may resolve
   *    to individual `[data-cid]` elements (not scrollable) → falls back to page scroll
   *  - Direct scrollTop always targets the correct overflow container
   */
  /**
   * 滚动评论容器：hover 到容器上 → 模拟鼠标滚轮
   * 比直接修改 scrollTop 更拟人，且滚动事件精准命中目标容器
   */
  private async scrollCommentArea(page: Page, direction: 'bottom' | 'top' | number): Promise<boolean> {
    const t0 = Date.now();
    const selectors = [
      '.douyin-creator-interactive-tabs-content',
      '[class*="tabs-content"][class*="top"]',
      '[class*="tabs-pane-active"]',
    ];

    return await HumanActions.withCDPContext(page, async (ctx) => {
      // 0. 刷新 CDP DOM 树（抽屉关闭后页面结构变化，旧树找不到容器）
      const t1 = Date.now();
      await ctx.dom.refreshDocument();
      const t2 = Date.now();
      logger.info({ refreshMs: t2 - t1 }, '[scrollCommentArea] refreshDocument');

      // 1. 找到评论滚动容器
      let containerRect: { x: number; y: number; width: number; height: number } | null = null;
      for (const sel of selectors) {
        const nodeId = await ctx.cdp.querySelector(sel);
        if (nodeId && nodeId > 0) {
          const box = await ctx.cdp.getBoxModel(nodeId);
          if (box && box.width > 0 && box.height > 0) {
            containerRect = {
              x: box.content[0],
              y: box.content[1],
              width: box.width,
              height: box.height,
            };
            break;
          }
        }
      }

      const t3 = Date.now();
      logger.info({ queryMs: t3 - t2 }, '[scrollCommentArea] querySelector loop');

      if (!containerRect) {
        logger.warn('[scrollCommentArea] Container not found, falling back to cdpSmartScroll');
        await HumanActions.cdpSmartScroll(page, selectors, direction === 'top' ? 99999 : direction === 'bottom' ? 99999 : Math.abs(direction), direction === 'top' ? 'up' : 'down');
        return true;
      }

      // 2. hover 到容器中心（带随机偏移，模拟人类鼠标位置）
      const hoverX = Math.round(containerRect.x + containerRect.width * (0.3 + Math.random() * 0.4));
      const hoverY = Math.round(containerRect.y + containerRect.height * (0.3 + Math.random() * 0.4));
      await ctx.mouse.moveTo({ x: hoverX, y: hoverY });
      const t4 = Date.now();
      logger.info({ hoverMs: t4 - t3 }, '[scrollCommentArea] mouse hover');
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

      // 3. 模拟鼠标滚轮（减少 CDP 调用次数，每次滚动量增大）
      if (direction === 'top') {
        // 5-8 次向上滚，每次 1000-2000px（CDP mouseWheel 支持大 delta）
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

      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      logger.info({ direction, totalMs: Date.now() - t0 }, '[scrollCommentArea] Completed');
      return true;
    });
  }

  /**
   * 智能滚动评论区并展开所有回复
   * 整合滚动加载和展开回复功能，确保所有评论内容完整加载
   * @param page 浏览器页面
   * @param awemeId 视频ID（用于日志）
   * @returns 展开的回复数量统计
   */
  private async smartScrollAndExpandReplies(page: Page, awemeId: string): Promise<{
    totalExpanded: number;
    totalLoadedMore: number;
    scrollRounds: number;
  }> {
    const result = { totalExpanded: 0, totalLoadedMore: 0, scrollRounds: 0 };
    const MAX_SCROLL_ROUNDS = 30;
    const MAX_EXPAND_ROUNDS = 20;
    const MAX_LOAD_MORE_PER_ROOT = 10;
    const processedCids = new Set<string>();

    const smartT0 = Date.now();
    logger.info({ awemeId }, '[SmartScroll] Starting intelligent comment scroll and expand');

    // 重置评论区滚动到顶部
    await this.scrollCommentArea(page, 'top');
    await HumanActions.wait(page, 500, 800);
    logger.info({ awemeId, topScrollMs: Date.now() - smartT0 }, '[SmartScroll] Scroll-to-top completed');

    // 预扫描：检查是否有展开按钮被隐藏在视窗外
    // 如果有，通过 cdpSmartScroll 滚动评论区域将按钮带到可见位置
    const preScrollResult = await page.evaluate(() => {
      const viewportH = window.innerHeight;
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
        const isLeaf = !Array.from(el.children).some(child =>
          /^查看\d+条回复$/.test((child.textContent || '').trim())
        );
        if (!isLeaf) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > viewportH) {
          return { found: true, scrolled: true, top: Math.round(rect.top) };
        }
      }
      return { found: false };
    });

    if (preScrollResult.found && preScrollResult.scrolled) {
      // 向下滚动评论区域以将按钮带入视窗（直接操作 scrollTop，避免 wheel 事件滚页面 body）
      await this.scrollCommentArea(page, 300);
      logger.info({ awemeId, buttonTop: preScrollResult.top }, '[SmartScroll] Expand button outside viewport, scrolled into view');
      await HumanActions.wait(page, 500, 800);
    }

    for (let scrollRound = 0; scrollRound < MAX_SCROLL_ROUNDS; scrollRound++) {
      result.scrollRounds = scrollRound + 1;
      logger.info({ awemeId, scrollRound: scrollRound + 1 }, '[SmartScroll] Scroll round starting');

      // ════════════════════════════════════════
      // 阶段1：检测并点击视窗内的展开按钮
      // ════════════════════════════════════════
      let expandClicked = 0;
      for (let expandRound = 0; expandRound < MAX_EXPAND_ROUNDS; expandRound++) {
        // 诊断：统计所有"查看N条回复"按钮的匹配和过滤情况（只读）
        const expandResult = await page.evaluate(() => {
          const viewportH = window.innerHeight;

          // 找到评论滚动容器
          const scrollContainer = (
            document.querySelector('.douyin-creator-interactive-tabs-content') ||
            document.querySelector('[class*="tabs-pane-active"]')
          ) as HTMLElement | null;
          const containerRect = scrollContainer?.getBoundingClientRect();

          // Diagnostic: count ALL text matches and track why they're filtered
          let totalMatches = 0;
          let leafMatches = 0;
          let viewportFiltered = 0;
          let containerFiltered = 0;
          const diagnostics: Array<{ text: string; top: number; bottom: number; containerTop: number; containerBottom: number; reason: string }> = [];

          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            const t = (el.textContent || '').trim();
            // 匹配"查看N条回复"格式
            if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
            totalMatches++;

            // 检查是否是叶子元素（避免重复点击父容器）
            const isLeaf = !Array.from(el.children).some(child =>
              /^查看\d+条回复$/.test((child.textContent || '').trim())
            );
            if (!isLeaf) continue;
            leafMatches++;

            // 检查元素是否在视窗内 且 在滚动容器的可见区域内
            const rect = el.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > viewportH) {
              viewportFiltered++;
              diagnostics.push({ text: t, top: Math.round(rect.top), bottom: Math.round(rect.bottom), containerTop: containerRect ? Math.round(containerRect.top) : -1, containerBottom: containerRect ? Math.round(containerRect.bottom) : -1, reason: 'viewport' });
              continue;
            }
            if (containerRect && (rect.top < containerRect.top || rect.bottom > containerRect.bottom)) {
              containerFiltered++;
              diagnostics.push({ text: t, top: Math.round(rect.top), bottom: Math.round(rect.bottom), containerTop: Math.round(containerRect.top), containerBottom: Math.round(containerRect.bottom), reason: 'container' });
              continue;
            }
          }
          return { totalMatches, leafMatches, viewportFiltered, containerFiltered, diagnostics };
        });

        // Log diagnostics for debugging expand button detection
        if (expandRound === 0 && expandResult.totalMatches > 0) {
          logger.info({
            awemeId,
            totalMatches: expandResult.totalMatches,
            leafMatches: expandResult.leafMatches,
            viewportFiltered: expandResult.viewportFiltered,
            containerFiltered: expandResult.containerFiltered,
          }, '[SmartScroll] Expand button scan diagnostics');
          if (expandResult.diagnostics.length > 0) {
            logger.info({ awemeId, diagnostics: expandResult.diagnostics }, '[SmartScroll] Filtered expand buttons detail');
          }
        }

        // 用 page.evaluate 找到视口内展开按钮的坐标，再用 CDP 鼠标点击
        let clicked = 0;
        const btnPos = await page.evaluate(() => {
          const viewportH = window.innerHeight;
          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            const t = (el.textContent || '').trim();
            if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
            const isLeaf = !Array.from(el.children).some(child =>
              /^查看\d+条回复$/.test((child.textContent || '').trim())
            );
            if (!isLeaf) continue;
            const rect = el.getBoundingClientRect();
            if (rect.top >= 0 && rect.bottom <= viewportH && rect.width > 0 && rect.height > 0) {
              return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                text: t,
              };
            }
          }
          return null;
        });

        if (btnPos) {
          // CDP 鼠标点击：先 hover 到按钮 → 等待 → 点击
          const cdpClicked = await HumanActions.withCDPContext(page, async (ctx) => {
            await ctx.mouse.moveTo({ x: btnPos.x, y: btnPos.y });
            await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
            await ctx.mouse.clickAt(btnPos.x, btnPos.y);
            return true;
          });
          if (cdpClicked) {
            clicked = 1;
            logger.info({ text: btnPos.text, x: btnPos.x, y: btnPos.y }, '[SmartScroll] Expand button clicked via CDP');
          }
        }
        if (clicked === 0) break;

        expandClicked += clicked;
        result.totalExpanded += clicked;
        logger.info({ awemeId, expandRound: expandRound + 1, clicked, total: result.totalExpanded }, '[SmartScroll] Expand buttons clicked');

        await HumanActions.wait(page, 1500, 2500);

        // ════════════════════════════════════════
        // 阶段2：处理超过10条回复的多次展开
        // ════════════════════════════════════════
        for (let loadMore = 0; loadMore < MAX_LOAD_MORE_PER_ROOT; loadMore++) {
          // 先检查是否有展开按钮存在（只读）
          const hasMoreBtn = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            for (const el of all) {
              const t = (el.textContent || '').trim();
              if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
              const isLeaf = !Array.from(el.children).some(child =>
                /^查看\d+条回复$/.test((child.textContent || '').trim())
              );
              if (isLeaf) return true;
            }
            return false;
          });

          if (!hasMoreBtn) break;

          // 先滚动评论区域使按钮可见（直接操作 scrollTop）
          await this.scrollCommentArea(page, 150);

          // 使用 page.evaluate + CDP 鼠标点击
          const moreClicked = await this.clickExpandButton(page);

          if (!moreClicked) break;

          result.totalLoadedMore++;
          logger.info({ awemeId, loadMoreRound: loadMore + 1 }, '[SmartScroll] Loaded more replies');
          await HumanActions.wait(page, 800, 1500);
        }
      }

      // ════════════════════════════════════════
      // 阶段3：滚动评论区加载更多内容
      // ════════════════════════════════════════
      const scrollHeight = await page.evaluate(() => {
        const container = document.querySelector('.douyin-creator-interactive-tabs-content') as HTMLElement | null;
        return container ? { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop, clientHeight: container.clientHeight } : null;
      });

      if (!scrollHeight) {
        logger.warn({ awemeId }, '[SmartScroll] Comment container not found, stopping');
        break;
      }

      const wasAtBottom = scrollHeight.scrollTop + scrollHeight.clientHeight >= scrollHeight.scrollHeight - 10;

      // 如果已经在底部且没有展开新内容，说明已加载完所有评论
      // 但在第一轮且没有展开任何按钮时，先做一次完整的滚动搜索（可能按钮在下方）
      if (wasAtBottom && expandClicked === 0) {
        if (scrollRound === 0 && result.totalExpanded === 0) {
          // 第一轮就到底了且没有展开按钮 — 可能是按钮在折叠区域
          // 检查DOM中是否有未展开的按钮（不管是否在可视区域）
          const hiddenBtnCount = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('*')).filter(el => {
              const t = (el.textContent || '').trim();
              if (!/^查看\d+条回复$/.test(t)) return false;
              if (!(el instanceof HTMLElement)) return false;
              const isLeaf = !Array.from(el.children).some(child =>
                /^查看\d+条回复$/.test((child.textContent || '').trim())
              );
              return isLeaf;
            }).length;
          });
          if (hiddenBtnCount > 0) {
            logger.info({ awemeId, hiddenBtnCount }, '[SmartScroll] Hidden expand buttons found, scrolling to reveal');
            // 滚动到评论区域中间位置来揭示隐藏的按钮
            await this.scrollCommentArea(page, 300);
            await HumanActions.wait(page, 500, 800);
            continue;
          }
        }
        logger.info({ awemeId, scrollRound: scrollRound + 1 }, '[SmartScroll] Reached bottom with no new content — all comments loaded');
        break;
      }

      // 滚动一个视窗高度的距离
      const scrollAmount = scrollHeight.clientHeight * 0.8;
      await this.scrollCommentArea(page, scrollAmount);
      await HumanActions.wait(page, 1000, 1500);

      // 记录当前页面评论数（用于诊断）
      const currentCids = await page.evaluate(() => {
        const containers = document.querySelectorAll('[data-cid]');
        return Array.from(containers).map(el => el.getAttribute('data-cid')).filter(Boolean) as string[];
      });
      currentCids.forEach(cid => processedCids.add(cid));

      // 记录本轮结束后仍有展开按钮的 cid（这些下一轮仍可展开）
      const remainingExpandCids = await page.evaluate(() => {
        const expandable: string[] = [];
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const t = (el.textContent || '').trim();
          if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
          const isLeaf = !Array.from(el.children).some(child =>
            /^查看\d+条回复$/.test((child.textContent || '').trim())
          );
          if (!isLeaf) continue;
          const parent = el.closest('[data-cid]');
          const cid = parent?.getAttribute('data-cid');
          if (cid) expandable.push(cid);
        }
        return [...new Set(expandable)];
      });

      logger.info({ awemeId, scrollRound: scrollRound + 1, expandClicked, totalCids: processedCids.size, remainingExpandable: remainingExpandCids.length, remainingCids: remainingExpandCids }, '[SmartScroll] Scroll round complete');
    }

    // 最终记录
    const finalCids = await page.evaluate(() => {
      const containers = document.querySelectorAll('[data-cid]');
      return containers.length;
    });

    logger.info({
      awemeId,
      totalExpanded: result.totalExpanded,
      totalLoadedMore: result.totalLoadedMore,
      scrollRounds: result.scrollRounds,
      totalComments: finalCids,
    }, '[SmartScroll] Smart scroll and expand complete');

    return result;
  }

  private async collectAllCommentResponses(page: Page): Promise<InterceptedResponse[]> {
    const allResponses: InterceptedResponse[] = [];
    let response = await this.waitForCommentResponse(page);
    if (!response) return [];
    allResponses.push(response);

    const MAX_COMMENT_PAGES = 10;
    for (let pageNum = 1; pageNum < MAX_COMMENT_PAGES; pageNum++) {
      const lastResp = allResponses[allResponses.length - 1];
      const hasMore = lastResp?.body?.has_more ?? 0;
      if (!hasMore) {
        logger.info({ pages: allResponses.length }, '[Phase3] All comment pages loaded');
        break;
      }

      logger.info({ page: pageNum + 1, cursor: lastResp?.body?.cursor }, '[Phase3] Scrolling to load more comments');

      // Scroll the comment-area container to its bottom via direct scrollTop.
      // This reliably triggers pagination because it targets the actual overflow
      // container instead of relying on `End` key (which may hit the page body).
      const scrolled = await this.scrollCommentArea(page, 'bottom');
      if (!scrolled) {
        // Fallback: End key + cdpSmartScroll (for unusual DOM layouts)
        logger.warn('[Phase3] Comment scroll container not found — falling back to End key');
        await HumanActions.cdpKeyPress(page, 'End', 'End', 35);
        await HumanActions.wait(page, 300, 500);
        await HumanActions.cdpSmartScroll(page, [
          '.douyin-creator-interactive-tabs-content',
          '[class*="tabs-pane-active"]',
        ], 500, 'down');
      }
      await HumanActions.wait(page, 1500, 2500);

      response = await this.waitForCommentResponse(page);
      if (response) {
        allResponses.push(response);
      } else {
        logger.info({ page: pageNum + 1 }, '[Phase3] No more comment responses');
        break;
      }
    }

    return allResponses;
  }

  private async waitForCommentResponse(page: Page, timeout: number = 20000): Promise<InterceptedResponse | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const responses = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
      if (responses.length > 0) {
        const latest = responses[responses.length - 1];
        logger.info({ awemeId: '(current)', responseTime: Date.now() - startTime }, '[Phase3] Comment API response captured');
        return latest;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    logger.warn({ timeout }, '[Phase3] Comment API response wait timed out');
    return null;
  }

  /** Short-timeout variant for the pre-check phase (avoids wasting 20s when comments are stale). */
  private async waitForCommentResponseShort(page: Page, timeout: number = 5000): Promise<InterceptedResponse | null> {
    return this.waitForCommentResponse(page, timeout);
  }

  // ════════════════════════════════════════
  // 回复评论（拟人化 CDP 操作）
  // ════════════════════════════════════════

  /**
   * 拟人化回复评论（支持一级评论和子评论）—— 双重确认（文本 + 时间）
   *
   * @param target 回复目标（文本、创建时间、层级、所属根评论文本）
   * @param replyText AI 生成的回复内容
   */
  async replyToComment(
    page: Page,
    target: ReplyTarget,
    replyText: string,
  ): Promise<boolean> {
    logger.info({
      text: target.text.slice(0, 30),
      level: target.level,
      createTime: target.createTime,
      rootText: target.rootText?.slice(0, 30),
    }, '[Reply] Starting douyin reply (dual-criteria)');

    // ── 调试模式初始化 ──
    const debugEnabled = await isDebugModeEnabled();
    let manifest: DebugManifest | null = null;
    let sessionId = '';
    let stepIdx = 0;

    if (debugEnabled) {
      sessionId = createReplySessionId(target);
      manifest = createManifest(sessionId, {
        text: target.text,
        level: target.level,
        createTime: target.createTime,
        rootText: target.rootText,
      });
      logger.info({ sessionId }, '[Reply] Debug mode enabled, snapshots will be saved');
    }

    const snap = async (label: string, extra?: Record<string, any>) => {
      if (manifest) {
        stepIdx++;
        await saveDebugSnapshot({ page, stepLabel: label, sessionId, stepIndex: stepIdx, manifest, extra });
      }
    };

    try {
      await HumanActions.thinkingPause(page, 800, 2000);
      await snap('reply_start');

      const foundCoords = await this.scrollExpandAndFindTarget(page, target, snap);

      if (!foundCoords) {
        await snap('target_not_found');
        logger.warn({ text: target.text.slice(0, 40), level: target.level }, '[Reply] Target not found');
        if (manifest) finishManifest(manifest, false);
        return false;
      }

      await snap('target_found', { x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) });
      logger.info({ x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) }, '[Reply] Target located, clicking reply');

      // ── 点击”回复”按钮 ──
      let clickedReplyBtn = false;
      let inputClicked = false;
      if (foundCoords.x > 0 && foundCoords.y > 0) {
        // 先 hover 到评论区域，触发回复按钮显示
        await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.mouse.moveTo({ x: foundCoords.x, y: foundCoords.y });
          await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        });
        await HumanActions.wait(page, 500, 1000);
        await snap('hover_target', { x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) });

        // 诊断：hover 后页面上有哪些”回复”元素
        const replyBtnDiag = await page.evaluate(function() {
          var all = document.querySelectorAll('*');
          var replyEls = [];
          for (var i = 0; i < all.length; i++) {
            var t = (all[i].textContent || '').trim();
            if (t === '回复') {
              var r = all[i].getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                replyEls.push({
                  tag: all[i].tagName,
                  cls: (all[i].className || '').toString().slice(0, 60),
                  x: Math.round(r.left + r.width / 2),
                  y: Math.round(r.top + r.height / 2),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                });
              }
            }
          }
          var editables = document.querySelectorAll('[contenteditable=”true”]');
          var editableInfo = [];
          for (var j = 0; j < editables.length; j++) {
            var er = editables[j].getBoundingClientRect();
            if (er.width > 0 && er.height > 0) {
              editableInfo.push({
                tag: editables[j].tagName,
                cls: (editables[j].className || '').toString().slice(0, 60),
                x: Math.round(er.left + er.width / 2),
                y: Math.round(er.top + er.height / 2),
              });
            }
          }
          return { replyEls: replyEls, editables: editableInfo };
        });
        logger.info({ replyBtnDiag }, '[Reply] 回复按钮诊断');

        // 尝试找到并点击回复按钮
        if (replyBtnDiag.replyEls.length > 0) {
          // 用 CSS 选择器点击第一个回复按钮（更可靠）
          clickedReplyBtn = await HumanActions.cdpClick(page, '.item-M3fSkJ', { timeout: 3000 });
          if (!clickedReplyBtn) {
            // 回退：用坐标点击
            var btn = replyBtnDiag.replyEls[0];
            await HumanActions.withCDPContext(page, async (ctx) => {
              await ctx.mouse.clickAt(btn.x, btn.y);
            });
            clickedReplyBtn = true;
          }
          logger.info({ clicked: clickedReplyBtn }, '[Reply] 点击了回复按钮');
          await snap('click_reply_btn', { clicked: clickedReplyBtn });

          // 立即检查并点击 contenteditable（它短暂出现后会消失）
          inputClicked = await page.evaluate(function() {
            var editables = document.querySelectorAll('[contenteditable="true"]');
            for (var i = 0; i < editables.length; i++) {
              var r = editables[i].getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                editables[i].focus();
                editables[i].click();
                return true;
              }
            }
            return false;
          });
          if (inputClicked) {
            logger.info('[Reply] 立即点击了 contenteditable');
            await HumanActions.wait(page, 300, 600);
            await snap('input_focused', { immediate: true });
          }
        }
        if (!clickedReplyBtn) {
          clickedReplyBtn = await HumanActions.cdpClickByText(page, '回复', { timeout: 3000 });
        }
        if (!clickedReplyBtn) {
          await HumanActions.withCDPContext(page, async (ctx) => {
            await ctx.mouse.clickAt(foundCoords.x, foundCoords.y);
          });
          clickedReplyBtn = true;
        }
      }

      // 如果回复按钮点击后没找到输入框，再试一次
      if (!inputClicked) {
        await HumanActions.wait(page, 500, 1000);
        inputClicked = await page.evaluate(function() {
          var editables = document.querySelectorAll('[contenteditable="true"]');
          for (var i = 0; i < editables.length; i++) {
            var r = editables[i].getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              editables[i].focus();
              editables[i].click();
              return true;
            }
          }
          return false;
        });
      }

      if (!inputClicked) {
        logger.error('[Reply] Reply input not found');
        return false;
      }

      // ── 拟人化输入 ──
      await HumanActions.safeCDPType(page, replyText);
      await HumanActions.wait(page, 500, 1200);
      await snap('text_typed', { textLength: replyText.length });

      // ── 点击发送 ──
      // 先在 contenteditable 附近查找提交按钮（返回坐标，用 CDP 点击）
      const submitBtnCoords = await page.evaluate(function() {
        var editables = document.querySelectorAll('[contenteditable=”true”]');
        for (var i = 0; i < editables.length; i++) {
          var r = editables[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            var parent = editables[i].parentElement;
            for (var depth = 0; depth < 8 && parent; depth++) {
              var btns = parent.querySelectorAll('button, [role=”button”], [class*=”btn”]');
              for (var j = 0; j < btns.length; j++) {
                var t = (btns[j].textContent || '').trim();
                if (t === '发送' || t === '发布' || t === '回复') {
                  var br = btns[j].getBoundingClientRect();
                  if (br.width > 0 && br.height > 0 && !btns[j].disabled) {
                    return { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2), text: t };
                  }
                }
              }
              parent = parent.parentElement;
            }
          }
        }
        return null;
      });

      let submitClicked = false;
      if (submitBtnCoords) {
        logger.info({ submitBtnCoords }, '[Reply] 找到提交按钮');
        await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.mouse.moveTo({ x: submitBtnCoords.x, y: submitBtnCoords.y });
          await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
          await ctx.mouse.clickAt(submitBtnCoords.x, submitBtnCoords.y);
        });
        submitClicked = true;
        logger.info('[Reply] 通过坐标点击了提交按钮');
      } else {
        // 回退：用 CSS 选择器
        const submitSelectors = [
          '[class*=”reply-content”] button.douyin-creator-interactive-button-primary:not([class*=”disabled”])',
          '[class*=”footer”] button.douyin-creator-interactive-button-primary:not([class*=”disabled”])',
        ];
        for (const sel of submitSelectors) {
          submitClicked = await HumanActions.cdpClick(page, sel, { timeout: 3000 });
          if (submitClicked) { logger.info({ selector: sel }, '[Reply] Submit clicked'); break; }
        }
        if (!submitClicked) {
          submitClicked = await HumanActions.cdpClickByText(page, '发送', { timeout: 5000 });
          if (submitClicked) logger.info('[Reply] Submit clicked via text');
        }
      }
      if (!submitClicked) logger.warn('[Reply] Submit not found, but text was typed');

      await HumanActions.wait(page, 2000, 4000);
      await snap('submit_clicked', { clicked: submitClicked });

      // 验证回复是否成功（检查是否有错误提示或回复是否消失）
      const verifyResult = await page.evaluate(function() {
        // 检查是否有错误提示
        var errorEls = document.querySelectorAll('[class*="error"], [class*="fail"], [class*="toast"]');
        for (var i = 0; i < errorEls.length; i++) {
          var t = (errorEls[i].innerText || '').trim();
          if (t.length > 0 && t.length < 100) return { error: t };
        }
        // 检查 contenteditable 是否还有内容（成功后应该清空）
        var editables = document.querySelectorAll('[contenteditable="true"]');
        for (var j = 0; j < editables.length; j++) {
          var r = editables[j].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { editableText: (editables[j].innerText || '').slice(0, 50) };
          }
        }
        return { editableText: 'none' };
      });
      logger.info({ verifyResult }, '[Reply] 提交后验证');
      await snap('verify_result', verifyResult);

      await HumanActions.betweenActionsPause(page);

      logger.info({ text: target.text.slice(0, 30), level: target.level }, '[Reply] Douyin reply completed');
      if (manifest) finishManifest(manifest, true);
      return true;
    } catch (err: any) {
      await snap('error', { message: err.message });
      logger.error({ error: err.message, text: target.text.slice(0, 30) }, '[Reply] Douyin reply failed');
      if (manifest) finishManifest(manifest, false);
      return false;
    }
  }

  /**
   * 缓慢滚动评论区，通过文本+时间双重确认找到目标评论的”回复”按钮坐标。
   *
   * 子评论 (level=2)：先找到匹配 rootText+时间的根评论容器 → 只展开该容器的子评论 → 搜索目标子评论
   * 一级评论 (level=1)：直接匹配文本+时间
   *
   * 关键：不盲目展开所有”查看N条回复”，只展开匹配 rootText 的根评论。
   */
  private async scrollExpandAndFindTarget(
    page: Page,
    target: ReplyTarget,
    snap?: (label: string, extra?: Record<string, any>) => Promise<void>,
  ): Promise<{ x: number; y: number } | null> {
    const MAX_SCROLL = 30;
    const TIME_WINDOW = 60;
    const isSub = target.level === 2;

    const startT0 = Date.now();
    logger.info({ text: target.text.slice(0, 30), time: target.createTime, isSub }, '[Reply::Find] Start (root-first expand)');

    await this.scrollCommentArea(page, 'top');
    await HumanActions.wait(page, 500, 800);
    await snap?.('scroll_to_top');

    for (let scrollRound = 0; scrollRound < MAX_SCROLL; scrollRound++) {
      logger.info({ scrollRound: scrollRound + 1 }, '[Reply::Find] Scroll round');
      await snap?.('scroll_round_' + (scrollRound + 1));

      // ── 搜索当前视窗中匹配 rootText+time 的根评论容器 ──
      // 实际 DOM 结构（2026-06-09 验证）：
      //   <div>                                    ← 无 class 的评论包装器
      //     <span class="douyin-creator-interactive-checkbox">
      //     <span class="douyin-creator-interactive-avatar">
      //     <div class="content-FM0UMi">           ← 内容包装器（hash 类名）
      //       <div>
      //         <div class="username-aLgaNB">      ← 用户名
      //         <div class="time-NRtTXO">          ← 时间（格式："05月28日 08:34"）
      //         <div class="comment-content-text-JvmAKq"> ← 评论正文
      //         <div class="operations-WFV7Am">    ← 操作按钮区
      //           <div class="item-M3fSkJ">回复</div>
      // 注意：评论没有带 class 的外层容器，需通过子元素反查
      let rootContainer: any = await page.evaluate(
        (params) => {
          var searchText = params.searchText;
          var targetTime = params.targetTime;
          var timeWindow = params.timeWindow;
          var isSubReply = params.isSubReply;
          var rootText = params.rootText;

          var vh = window.innerHeight;

          var containerSelectors = ['[class*="container-sXKyMs"]', '[class*="reply-item"]', '[class*="comment-item"]', '[class*="comment-content-text"]'];
          for (var si = 0; si < containerSelectors.length; si++) {
            var containers = document.querySelectorAll(containerSelectors[si]);
            for (var ci = 0; ci < containers.length; ci++) {
              var container = containers[ci];
              var text = (container.innerText || '').toLowerCase();
              if (!text || text.length < 2) continue;

              // 内联提取发布时间戳（不使用函数，避免 esbuild __name 注入）
              var time = null;
              var t = container.innerText || '';
              var m = t.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
              if (m) { time = Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000); }
              if (time === null) {
                m = t.match(/发布于\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
                if (m) { time = Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000); }
              }
              if (time === null) {
                m = t.match(/发布于\s*(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
                if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
              }
              if (time === null) {
                m = t.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
                if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
              }
              if (time === null) {
                m = t.match(/(\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
                if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
              }
            }
          }

          // 策略：通过评论正文元素 [class*="comment-content-text-"] 定位每条评论
          var textEls = document.querySelectorAll('[class*="comment-content-text-"]');

          for (var ti = 0; ti < textEls.length; ti++) {
            var textEl = textEls[ti] as HTMLElement;
            var commentText = (textEl.innerText || '').trim();
            if (!commentText || commentText.length < 1) continue;

            // 向上查找评论包装器（找到包含操作按钮或时间的父级 div）
            var commentWrapper = textEl.parentElement;
            var maxDepth = 10;
            while (commentWrapper && maxDepth > 0) {
              maxDepth--;
              // 找到包含操作区（回复按钮）的容器
              var hasOps = commentWrapper.querySelector('[class*="operations-"], [class*="action"]');
              var hasTime = commentWrapper.querySelector('[class*="time-"]');
              var hasCheckbox = commentWrapper.querySelector('.douyin-creator-interactive-checkbox, [class*="checkbox"]');
              if ((hasOps && hasTime) || hasCheckbox) break;
              commentWrapper = commentWrapper.parentElement;
            }
            if (!commentWrapper) continue;

            // 从评论包装器中提取时间（内联，不使用函数）
            var timeEl = commentWrapper.querySelector('[class*="time-"]');
            var timeText = timeEl ? (timeEl.innerText || '') : '';
            var time = null;
            var m2 = timeText.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
            if (m2) { time = Math.floor(new Date(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5]).getTime() / 1000); }
            if (time === null) {
              m2 = timeText.match(/发布于\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
              if (m2) { time = Math.floor(new Date(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5]).getTime() / 1000); }
            }
            if (time === null) {
              m2 = timeText.match(/发布于\s*(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
              if (m2) { time = Math.floor(new Date(new Date().getFullYear(), +m2[1] - 1, +m2[2], +m2[3], +m2[4]).getTime() / 1000); }
            }
            if (time === null) {
              m2 = timeText.match(/(\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
              if (m2) { time = Math.floor(new Date(new Date().getFullYear(), +m2[1] - 1, +m2[2], +m2[3], +m2[4]).getTime() / 1000); }
            }

            var textOk = commentText.toLowerCase().indexOf(searchText) >= 0 || searchText.indexOf(commentText.toLowerCase().slice(0, Math.min(commentText.length, 40))) >= 0;
            var timeOk = time !== null && Math.abs(time - targetTime) <= timeWindow;

            if (isSubReply) {
              var rootOk = rootText && commentText.toLowerCase().indexOf(rootText) >= 0;
              if (!rootOk) continue;
              if (!timeOk) continue;

              // 找到根评论后，在其内搜索子评论（子评论也使用 [class*="comment-content-text-"]）
              var subTextEls = commentWrapper.querySelectorAll('[class*="comment-content-text-"]');
              for (var si = 0; si < subTextEls.length; si++) {
                if (subTextEls[si] === textEl) continue; // 跳过根评论自身
                var subText = (subTextEls[si].innerText || '').trim().toLowerCase();
                if (subText.indexOf(searchText) >= 0) {
                  // 找到匹配的子评论，定位其回复按钮
                  var subParent = subTextEls[si].closest('[class*="content-"]')?.parentElement;
                  if (subParent) {
                    var opsArea = subParent.querySelector('[class*="operations-"]');
                    if (!opsArea) opsArea = subTextEls[si].closest('[class*="content-"]')?.querySelector('[class*="operations-"]') || null;
                  }
                  // 直接在子评论的兄弟节点中查找操作区
                  var siblingOps = subTextEls[si].parentElement?.querySelector('[class*="operations-"]');
                  if (siblingOps) {
                    var items = siblingOps.querySelectorAll('[class*="item-"]');
                    for (var ri = 0; ri < items.length; ri++) {
                      if ((items[ri].textContent || '').trim() === '回复') {
                        var r = items[ri].getBoundingClientRect();
                        if (r.left > 0 && r.top > 0 && r.top <= vh) {
                          (subTextEls[si] as HTMLElement).scrollIntoView({ behavior: 'instant', block: 'center' });
                          return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), needExpand: false };
                        }
                      }
                    }
                  }
                }
              }

              // 子评论未找到或尚未展开，返回根评论坐标以便展开
              commentWrapper.scrollIntoView({ behavior: 'instant', block: 'center' });
              var rect = commentWrapper.getBoundingClientRect();
              return {
                found: true, needExpand: true, isRoot: true,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                expandX: -1, expandY: -1,
              };
            } else {
              if (textOk && timeOk) {
                commentWrapper.scrollIntoView({ behavior: 'instant', block: 'center' });
                // 在该评论包装器内查找“回复”按钮
                var opsArea = commentWrapper.querySelector('[class*="operations-"]');
                if (opsArea) {
                  var items = opsArea.querySelectorAll('[class*="item-"]');
                  for (var ri = 0; ri < items.length; ri++) {
                    if ((items[ri].textContent || '').trim() === '回复') {
                      var r = items[ri].getBoundingClientRect();
                      if (r.left > 0 && r.top > 0 && r.top <= vh)
                        return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), needExpand: false };
                    }
                  }
                }
                var rect = commentWrapper.getBoundingClientRect();
                return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), needExpand: false };
              }
            }
          }
          return { found: false, needExpand: false };
        },
        { searchText: target.text.toLowerCase(), targetTime: target.createTime, timeWindow: TIME_WINDOW, isSubReply: isSub, rootText: (target.rootText || '').toLowerCase() },
      );

      // 如果主搜索未找到，尝试简单文本匹配（评论管理页面结构不同）
      if (!rootContainer.found) {
        logger.info('[Reply::Find] 主搜索未找到，尝试简单文本匹配');
        const simpleMatch = await page.evaluate(
          (params) => {
            var searchText = params.searchText;
            var vh = window.innerHeight;
            var textEls = document.querySelectorAll('[class*="comment-content-text"]');
            for (var i = 0; i < textEls.length; i++) {
              var el = textEls[i];
              var text = (el.innerText || '').trim().toLowerCase();
              if (!text) continue;
              if (text.indexOf(searchText) >= 0 || searchText.indexOf(text) >= 0) {
                // 找到匹配的评论文本，向上查找回复按钮
                var parent = el.parentElement;
                for (var depth = 0; depth < 10 && parent; depth++) {
                  var ops = parent.querySelector('[class*="operations-"], [class*="action-"]');
                  if (ops) {
                    var items = ops.querySelectorAll('[class*="item-"]');
                    for (var ri = 0; ri < items.length; ri++) {
                      if ((items[ri].textContent || '').trim() === '回复') {
                        var r = items[ri].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                          return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                        }
                      }
                    }
                  }
                  parent = parent.parentElement;
                }
                // 没找到回复按钮，返回元素坐标
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                var rect = el.getBoundingClientRect();
                return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
              }
            }
            return { found: false, x: 0, y: 0 };
          },
          { searchText: target.text.toLowerCase() },
        );
        if (simpleMatch.found) {
          logger.info('[Reply::Find] 简单文本匹配成功');
          rootContainer = { found: true, x: simpleMatch.x, y: simpleMatch.y, needExpand: false };
        }
      }

      if (rootContainer.found) {
        if (!rootContainer.needExpand) {
          // 直接找到了目标（一级评论或已展开的子评论）
          logger.info({ scrollRound, elapsedMs: Date.now() - startT0 }, '[Reply::Find] Target found directly');
          return { x: rootContainer.x, y: rootContainer.y };
        }

        // 需要展开这个根评论的子评论
        logger.info({ scrollRound }, '[Reply::Find] Found matching root, expanding its sub-comments');

        // 点击根评论容器内的”查看N条回复”按钮
        let expanded = false;
        // 用 CDP 在容器坐标附近点击展开按钮
        const btnText = await this.clickExpandButton(page);
        await snap?.('expand_sub_replies', { btnText });
        if (!btnText) {
          // 回退：在容器坐标处点击任何”查看N条回复”
          await HumanActions.withCDPContext(page, async (ctx) => {
            await ctx.mouse.moveTo({ x: rootContainer.x, y: rootContainer.y });
            await new Promise(r => setTimeout(r, 100));
          });
          // 尝试文本点击
          await HumanActions.cdpClickByText(page, /查看\d+条回复/, { timeout: 3000 });
        }

        expanded = true;
        await HumanActions.wait(page, 1000, 2000);

        // 展开后搜索子评论
        const subResult = await page.evaluate(
          (params) => {
            var searchText = params.searchText;
            var targetTime = params.targetTime;
            var timeWindow = params.timeWindow;
            var rootText = params.rootText;
            var vh = window.innerHeight;

            // 抖音子评论DOM: 每条子评论也用 [class*="comment-content-text-"] 显示文本
            // 在同一页面的所有评论文本元素中搜索（展开后子评论已渲染到DOM中）
            var textEls = document.querySelectorAll('[class*="comment-content-text-"]');
            for (var i = 0; i < textEls.length; i++) {
              var textEl = textEls[i];
              var commentText = (textEl.innerText || '').trim();
              if (!commentText || commentText.length < 2) continue;
              var commentLower = commentText.toLowerCase();

              // 如果指定了rootText，子评论必须在包含rootText的评论wrapper内
              if (rootText) {
                var wrapper = textEl.parentElement;
                var found_root = false;
                while (wrapper) {
                  if ((wrapper.innerText || '').toLowerCase().indexOf(rootText) >= 0) {
                    if (wrapper.querySelector('input[type="checkbox"]') || (wrapper.getAttribute('class') || '').indexOf('comment-wrapper') >= 0) {
                      found_root = true;
                      break;
                    }
                  }
                  wrapper = wrapper.parentElement;
                }
                if (!found_root) continue;
              }

              if (commentLower.indexOf(searchText) >= 0) {
                // 向上找到评论wrapper（包含整条评论的容器）
                var commentWrapper = textEl.parentElement;
                while (commentWrapper && !commentWrapper.querySelector('[class*="time-"]')) {
                  commentWrapper = commentWrapper.parentElement;
                }
                if (!commentWrapper) continue;

                // 从wrapper内的time元素提取时间
                var timeEl = commentWrapper.querySelector('[class*="time-"]');
                var timeText = timeEl ? (timeEl.innerText || '').trim() : '';
                var time = null;
                var m;

                // YYYY/MM/DD HH:MM 或 YYYY-MM-DD HH:MM
                m = timeText.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
                if (m) { time = Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000); }

                // 发布于 YYYY年MM月DD日 HH:MM
                if (time === null) {
                  m = timeText.match(/发布于\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000); }
                }

                // 发布于 MM月DD日 HH:MM
                if (time === null) {
                  m = timeText.match(/发布于\s*(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
                }

                // MM月DD日 HH:MM（抖音评论最常见格式）
                if (time === null) {
                  m = timeText.match(/(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
                }

                // MM/DD HH:MM
                if (time === null) {
                  m = timeText.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
                }

                var timeOk = time !== null && Math.abs(time - targetTime) <= timeWindow;
                if (!timeOk) continue;

                // 找到回复按钮: 在wrapper内找 [class*="operations-"] > [class*="item-"] 且文本为"回复"
                textEl.scrollIntoView({ behavior: 'instant', block: 'center' });
                var opsContainers = commentWrapper.querySelectorAll('[class*="operations-"]');
                for (var oi = 0; oi < opsContainers.length; oi++) {
                  var opItems = opsContainers[oi].querySelectorAll('[class*="item-"]');
                  for (var ri = 0; ri < opItems.length; ri++) {
                    if ((opItems[ri].innerText || '').trim() === '回复') {
                      var r = opItems[ri].getBoundingClientRect();
                      if (r.left > 0 && r.top > 0 && r.top <= vh)
                        return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                    }
                  }
                }
                // 回退：返回评论文本元素坐标
                var r2 = textEl.getBoundingClientRect();
                return { found: true, x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) };
              }
            }
            return { found: false, x: 0, y: 0 };
          },
          { searchText: target.text.toLowerCase(), targetTime: target.createTime, timeWindow: TIME_WINDOW, rootText: (target.rootText || '').toLowerCase() },
        );

        if (subResult.found) {
          logger.info({ scrollRound, elapsedMs: Date.now() - startT0 }, '[Reply::Find] Sub-comment found after expand');
          return { x: subResult.x, y: subResult.y };
        }

        // 加载更多（如果子评论超过10条）
        for (let lm = 0; lm < 10; lm++) {
          const hasMore = await page.evaluate(function() {
            var all = document.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              var t = (all[i].textContent || '').trim();
              if (/^查看\d+条回复$/.test(t) && all[i] instanceof HTMLElement) {
                var isLeaf = true;
                for (var j = 0; j < all[i].children.length; j++) {
                  if (/^查看\d+条回复$/.test((all[i].children[j].textContent || '').trim())) { isLeaf = false; break; }
                }
                if (isLeaf) return true;
              }
            }
            return false;
          });
          if (!hasMore) break;

          await this.scrollCommentArea(page, 150);
          await this.clickExpandButton(page);
          await HumanActions.wait(page, 800, 1500);

          const foundMore = await page.evaluate(
            (params) => {
              var searchText = params.searchText;
              var targetTime = params.targetTime;
              var timeWindow = params.timeWindow;
              var rootText = params.rootText;
              var vh = window.innerHeight;
              // 抖音子评论DOM: 每条子评论也用 [class*="comment-content-text-"] 显示文本
              var textEls = document.querySelectorAll('[class*="comment-content-text-"]');
              for (var i = 0; i < textEls.length; i++) {
                var textEl = textEls[i];
                var commentText = (textEl.innerText || '').trim();
                if (!commentText || commentText.length < 2) continue;
                var commentLower = commentText.toLowerCase();
                if (commentLower.indexOf(searchText) < 0) continue;

                // 如果指定了rootText，检查评论上下文
                if (rootText) {
                  var wrapper = textEl.parentElement;
                  var found_root = false;
                  while (wrapper) {
                    if ((wrapper.innerText || '').toLowerCase().indexOf(rootText) >= 0) {
                      if (wrapper.querySelector('input[type="checkbox"]') || (wrapper.getAttribute('class') || '').indexOf('comment-wrapper') >= 0) {
                        found_root = true;
                        break;
                      }
                    }
                    wrapper = wrapper.parentElement;
                  }
                  if (!found_root) continue;
                }

                // 向上找到评论wrapper
                var commentWrapper = textEl.parentElement;
                while (commentWrapper && !commentWrapper.querySelector('[class*="time-"]')) {
                  commentWrapper = commentWrapper.parentElement;
                }
                if (!commentWrapper) continue;

                // 从wrapper内的time元素提取时间
                var timeEl = commentWrapper.querySelector('[class*="time-"]');
                var timeText = timeEl ? (timeEl.innerText || '').trim() : '';
                var time = null;
                var m;

                // YYYY/MM/DD HH:MM 或 YYYY-MM-DD HH:MM
                m = timeText.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
                if (m) { time = Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000); }

                // 发布于 YYYY年MM月DD日 HH:MM
                if (time === null) {
                  m = timeText.match(/发布于\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000); }
                }

                // 发布于 MM月DD日 HH:MM
                if (time === null) {
                  m = timeText.match(/发布于\s*(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
                }

                // MM月DD日 HH:MM（抖音评论最常见格式）
                if (time === null) {
                  m = timeText.match(/(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
                }

                // MM/DD HH:MM
                if (time === null) {
                  m = timeText.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
                  if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
                }

                if (time === null || Math.abs(time - targetTime) > timeWindow) continue;

                // 找到回复按钮: [class*="operations-"] > [class*="item-"] 且文本为"回复"
                textEl.scrollIntoView({ behavior: 'instant', block: 'center' });
                var opsContainers = commentWrapper.querySelectorAll('[class*="operations-"]');
                for (var oi = 0; oi < opsContainers.length; oi++) {
                  var opItems = opsContainers[oi].querySelectorAll('[class*="item-"]');
                  for (var ri = 0; ri < opItems.length; ri++) {
                    if ((opItems[ri].innerText || '').trim() === '回复') {
                      var r = opItems[ri].getBoundingClientRect();
                      if (r.left > 0 && r.top > 0 && r.top <= vh)
                        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                    }
                  }
                }
                // 回退：返回评论文本元素坐标
                var r2 = textEl.getBoundingClientRect();
                return { x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) };
              }
              return null;
            },
            { searchText: target.text.toLowerCase(), targetTime: target.createTime, timeWindow: TIME_WINDOW, rootText: (target.rootText || '').toLowerCase() },
          );
          if (foundMore) { logger.info({ lm }, '[Reply::Find] Found after load-more'); return foundMore; }
        }

        // 这个根评论展开后没找到目标子评论 — 继续滚动找下一个匹配的根评论
        logger.info({ scrollRound }, '[Reply::Find] Target not in this root, continuing scroll');
      }

      // ── 诊断：页面上有哪些可滚动容器和评论元素 ──
      if (scrollRound === 0) {
        const diag = await page.evaluate(function() {
          // 找所有有滚动能力的容器
          var scrollables = [];
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 50) {
              scrollables.push({
                tag: el.tagName,
                cls: (el.className || '').toString().slice(0, 80),
                sh: el.scrollHeight, st: el.scrollTop, ch: el.clientHeight,
                childCount: el.children.length,
              });
            }
          }
          // 找评论相关元素
          var commentEls = document.querySelectorAll('[class*="comment"], [class*="reply"], [data-cid]');
          // 检查目标文本是否存在
          var bodyText = document.body.innerText || '';
          return {
            scrollables: scrollables.slice(0, 10),
            commentElCount: commentEls.length,
            hasRootText: bodyText.indexOf('美丽动人') >= 0,
            hasTargetText: bodyText.indexOf('谢谢') >= 0,
            bodyLen: bodyText.length,
          };
        });
        logger.info({ diag }, '[Reply::Find] Page diagnostic');
      }

      // ── 先尝试点击"展开更多评论"按钮（评论管理页面分页机制） ──
      const expandMoreClicked = await page.evaluate(function() {
        var btns = document.querySelectorAll('span, div, button, a');
        for (var i = 0; i < btns.length; i++) {
          var t = (btns[i].textContent || '').trim();
          if (t === '展开更多评论' || t === '展开更多' || t === '查看更多评论') {
            var el = btns[i];
            // 检查可见性
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.click();
              return true;
            }
          }
        }
        return false;
      });
      if (expandMoreClicked) {
        logger.info({ scrollRound: scrollRound + 1 }, '[Reply::Find] Clicked "展开更多评论"');
        await HumanActions.wait(page, 1500, 2500);
        continue; // 重新搜索，不滚动
      }

      // ── 滚动加载更多 ──
      const sh = await page.evaluate(function() {
        var c = document.querySelector('.douyin-creator-interactive-tabs-content');
        return c ? { sh: c.scrollHeight, st: c.scrollTop, ch: c.clientHeight } : null;
      });
      if (!sh) { logger.warn('[Reply::Find] Container gone'); break; }

      logger.info({ scrollRound: scrollRound + 1, scrollTop: sh.st, clientHeight: sh.ch, scrollHeight: sh.sh }, '[Reply::Find] Scroll state');

      if (sh.st + sh.ch >= sh.sh - 10) {
        logger.info({ scrollRound: scrollRound + 1 }, '[Reply::Find] Bottom reached');
        break;
      }

      await this.scrollCommentArea(page, sh.ch * 0.6);
      await HumanActions.wait(page, 1000, 1500);
    }

    // ── 最终全扫描 ──
    logger.info({ elapsedMs: Date.now() - startT0 }, '[Reply::Find] Exhaustive, final sweep');
    await this.scrollCommentArea(page, 'top');
    await HumanActions.wait(page, 500, 800);

    // 最后再搜索一遍（一级评论 or 已展开的子评论）
    const finalResult = await page.evaluate(
      (params) => {
        var searchText = params.searchText;
        var targetTime = params.targetTime;
        var timeWindow = params.timeWindow;
        var isSub = params.isSub;
        var rootText = params.rootText;
        var vh = window.innerHeight;
        var sels = ['[class*=”comment-content-text”]', '[class*=”content-”][class*=”text”]', 'div[data-cid] div[class*=”text”]', '[class*=”reply-item”]', '[class*=”sub-reply”]', '[class*=”comment-item”]', '[class*=”container-sXKyMs”]'];
        for (var si = 0; si < sels.length; si++) {
          var els = document.querySelectorAll(sels[si]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            var text = (el.innerText || '').toLowerCase();
            if (!text || text.length < 2) continue;
            if (text.indexOf(searchText) < 0 && searchText.indexOf(text.slice(0, Math.min(text.length, 30))) < 0) continue;
            if (isSub && rootText && text.indexOf(rootText) < 0) continue;
            // 内联提取时间
            var time = null;
            var t = el.innerText || '';
            var m = t.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
            if (m) { time = Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000); }
            if (time === null) {
              m = t.match(/发布于\s*(\d{1,2})[\/\-.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
              if (m) { time = Math.floor(new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime() / 1000); }
            }
            if (time !== null && Math.abs(time - targetTime) > timeWindow) continue;

            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            // 向上查找”回复”按钮
            var parent = el;
            for (var level = 0; level < 6 && parent; level++, parent = parent.parentElement) {
              var ops = parent.querySelector('[class*=”operations”], [class*=”operation”], [class*=”action”]');
              if (ops) {
                var items = ops.querySelectorAll('[class*=”item-”], [class*=”action-item”], [class*=”item”]');
                for (var ri = 0; ri < items.length; ri++) {
                  if ((items[ri].innerText || '').trim() === '回复') {
                    var r = items[ri].getBoundingClientRect();
                    if (r.left > 0 && r.top > 0 && r.top <= vh)
                      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                  }
                }
              }
            }
            var r2 = el.getBoundingClientRect();
            return { x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) };
          }
        }
        return null;
      },
      { searchText: target.text.toLowerCase(), targetTime: target.createTime, timeWindow: TIME_WINDOW, isSub: isSub, rootText: (target.rootText || '').toLowerCase() },
    );

    return finalResult;
  }
}
