import { Page } from 'patchright';
import { RequestInterceptor, HumanActions, BrowserManager, ExitStrategy, PageType } from '@social-media/browser-core';
import { getSelector, getRandomExitSubmenuKey, getSubmenuKeyForPageType } from './menuSelectors';
import { resolveAndClick, tryClickBySelector } from './menuNavigator';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
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
const COMMENT_LIST_PATTERN = '/comment/list/select';

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
      const mainContentSelector = getSelector('scroll.main-content').css || '';

      if (mainContentSelector) {
        logger.info({ selector: mainContentSelector }, 'Attempting main content area scroll');
        await HumanActions.cdpSmartScroll(page, [mainContentSelector], 300, 'down');
        return;
      }

      logger.info('No main content selector configured, using viewport center scroll');
      await HumanActions.cdpSmartScroll(page, [], 400, 'down');

      await HumanActions.wait(page, 300, 800);
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Smart scroll failed, using CDP scroll fallback');
      await HumanActions.humanScroll(page, 300);
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
    const containerCss = containerDef.css || '[class*="container-sXKyMs"]';

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
      const rootCid = await page.evaluate((idx: number) => {
        const containers = document.querySelectorAll('[class*="container-sXKyMs"]');
        const el = containers[idx] as HTMLElement;
        return el?.dataset?.cid || '';
      }, containerIdx);
      if (!rootCid) continue;

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

      for (const sel of expandSelectors) {
        const btnClicked = await HumanActions.cdpClickByText(page, sel, { timeout: 3000 });
        if (btnClicked) {
          await HumanActions.wait(page, 500, 1000);
          expandedCount++;

          // 滚动评论区加载更多
          await HumanActions.humanScroll(page, 200, { minPause: 300, maxPause: 600 });

          const moreClicked = await HumanActions.cdpClickByText(page, 'text=/展开更多/', { timeout: 2000 });
          if (moreClicked) {
            await HumanActions.wait(page, 300, 600);
            expandedCount++;
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

    const containerCss = getSelector('comment.container')?.css || '[class*="container-sXKyMs"]';
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

      // 在容器内点击"查看 N 条回复"（限定在当前容器范围内，避免误点其他根评论的展开按钮）
      const clicked = await page.evaluate(({ idx, cssSel }: { idx: number; cssSel: string }) => {
        const containers = document.querySelectorAll(cssSel);
        const el = containers[idx] as HTMLElement;
        if (!el) return false;
        const btn = Array.from(el.querySelectorAll('*')).find(
          (e: Element) => /查看\d+条回复/.test(e.textContent || ''),
        );
        if (btn instanceof HTMLElement) { btn.click(); return true; }
        return false;
      }, { idx: containerIdx, cssSel: containerCss });

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
    const containerCss = containerDef.css || '[class*="container-sXKyMs"]';

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
    this.interceptor.clear(COMMENT_LIST_PATTERN);
    const commentListenerId = await this.interceptor.register(page, [COMMENT_LIST_PATTERN]);
    logger.info({ commentListenerId }, '[Phase3] Comment API listener registered for entire queue');

    try {
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        logger.info({ index: i + 1, total: queue.length, awemeId: item.awemeId }, '[Phase3] Processing video in queue');

        const riskCheck = await this.detectRiskControlAsync(page);
        if (riskCheck.detected) {
          logger.error({ awemeId: item.awemeId, riskType: riskCheck.type }, '[Phase3] Risk control detected — aborting queue processing');
          return { results, riskDetected: true, riskInfo: riskCheck };
        }

        this.interceptor.clear(COMMENT_LIST_PATTERN);

        // 打开"选择作品"抽屉 → 找到并点击视频
        const drawerOpened = await this.openSelectWorkDrawer(page);
        if (!drawerOpened) {
          logger.error({ awemeId: item.awemeId }, '[Phase3] Failed to open drawer — skipping video');
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Failed to open drawer' });
          continue;
        }

        const clicked = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description);
        if (!clicked) {
          logger.error({ awemeId: item.awemeId }, '[Phase3] Failed to find/click video in drawer — manually closing and skipping');
          await this.closeDrawer(page);
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'Video not found in drawer' });
          continue;
        }

        const reactionDelay = 1200 + Math.random() * 1300;
        logger.info({ awemeId: item.awemeId, reactionDelay: Math.round(reactionDelay) }, '[Phase3] Reaction pause — drawer auto-closes after video selection');
        await HumanActions.wait(page, reactionDelay, reactionDelay + 100);

        // 拦截评论 API 响应
        const response = await this.waitForCommentResponse(page);

        if (!response) {
          logger.warn({ awemeId: item.awemeId }, '[Phase3] No comment API response received');
          const drawerStillOpen = await this.isDrawerVisible(page);
          if (drawerStillOpen) {
            logger.info({ awemeId: item.awemeId }, '[Phase3] Drawer still open after no response — closing manually');
            await this.closeDrawer(page);
          }
          results.push({ awemeId: item.awemeId, success: false, comments: [], error: 'No API response' });
          continue;
        }

        // 从响应中解析根评论快照
        const currentSnapshots = this.parseRootCommentSnapshots(response.body);

        // 加载上次快照
        const lastSnapshots = await db.getRootCommentCounts(item.awemeId);

        // 获取 lastCheckTime 用于过滤新增评论
        const monitorStatus = await prisma.monitorStatus.findFirst({
          where: { accountId: String(item._userId), platform: 'douyin' },
          orderBy: { lastCheckTime: 'desc' },
        });
        const lastCheckTime = monitorStatus?.lastCheckTime?.getTime() || 0;

        const isFirstCrawl = item.isFirstCrawl || lastSnapshots.size === 0;

        if (isFirstCrawl) {
          // ════════════════════════════════════════
          // 首次采集：保存快照 + 全量展开 + isNew=0
          // ════════════════════════════════════════

          // 保存快照到 VideoRootCommentCount
          await db.upsertRootCommentCounts(item.awemeId, currentSnapshots.map(s => ({
            cid: s.cid,
            replyCount: s.replyCount,
          })));

          // 全量展开所有回复
          await this.expandAllReplies(page, item.awemeId, currentSnapshots.map(s => s.cid));

          // 重新等待 API 响应以获取 expandAllReplies 后加载的子回复数据
          const expandedResponse = await this.waitForCommentResponse(page);

          // DOM 解析评论树
          const domTree = await this.parseCommentTreeFromDOM(page);

          // 合并 API 数据到 DOM 节点（合并初始响应和展开后响应的数据）
          const apiComments = [
            ...(response.body?.comments || []),
            ...(expandedResponse?.body?.comments || []),
          ];
          const mergedTree = this.mergeApiDataToDOM(domTree, apiComments);

          // 展平为 upsertCommentTree 所需格式（snake_case）
          const allFlat: Array<{
            cid: string; text: string; user_nickname: string; user_uid: string;
            digg_count: number; create_time: number; reply_id: string;
            rootId?: string; parentId?: string; level: number; replyToName?: string;
          }> = [];

          const flattenNodes = (nodes: CommentNode[]) => {
            for (const node of nodes) {
              allFlat.push({
                cid: node.cid,
                text: node.text,
                user_nickname: node.userNickname,
                user_uid: node.userUid,
                digg_count: node.diggCount,
                create_time: node.createTime,
                reply_id: node.replyId || '0',
                rootId: node.rootId || undefined,
                parentId: node.parentId || undefined,
                level: node.level,
                replyToName: node.replyToName || undefined,
              });
              if (node.subComments && node.subComments.length > 0) {
                flattenNodes(node.subComments);
              }
            }
          };
          flattenNodes(mergedTree);

          // upsertCommentTree 创建时默认 isNew=1，首次采集需全部设为 0
          await db.upsertCommentTree(item.awemeId, allFlat);
          await prisma.comment.updateMany({
            where: { videoId: item.awemeId },
            data: { isNew: 0 },
          });

          await db.updateCommentCount(item.awemeId, item.newCount);

          logger.info({
            awemeId: item.awemeId,
            totalComments: allFlat.length,
            newComments: 0,
            isFirstCrawl: true,
          }, '[Phase3] First crawl complete — all comments saved as isNew=0');

          results.push({
            awemeId: item.awemeId,
            success: true,
            comments: [],
            commentGroups: [],
          } as any);
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

          // ── 3a. 新增根评论 ──
          for (const snapshot of currentSnapshots) {
            if (!dbRootCids.has(snapshot.cid)) {
              if (snapshot.createTime * 1000 > lastCheckTime) {
                const isAuthor = platformAuthorId ? snapshot.userUid === platformAuthorId : false;
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

          // ── 3b. 根评论 replyCount 增加 → 局部展开 ──
          for (const snapshot of currentSnapshots) {
            const lastCount = lastSnapshots.get(snapshot.cid);
            if (lastCount !== undefined && snapshot.replyCount > lastCount) {
              const replies = await this.expandRepliesForRoot(page, snapshot.cid);
              if (replies.length > 0) {
                const apiReplies = response.body.comments?.filter(
                  (c: any) => String(c.reply_id) === snapshot.cid
                ) || [];

                for (const reply of replies) {
                  const apiMatch = apiReplies.find((c: any) => c.text?.includes(reply.text.slice(0, 10)));
                  const createTime = apiMatch?.create_time || 0;
                  const userUid = apiMatch?.user?.uid || '';
                  const userNickname = apiMatch?.user?.nickname || '';

                  if (createTime * 1000 > lastCheckTime) {
                    const isAuthor = platformAuthorId ? userUid === platformAuthorId : false;
                    if (!isAuthor) {
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
          if (newCommentsToUpsert.length > 0) {
            await db.upsertCommentTree(item.awemeId, newCommentsToUpsert);
          }

          // ── 3f. 更新 commentCount ──
          await db.updateCommentCount(item.awemeId, item.newCount);

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
      if (commentListenerId) {
        this.interceptor.unregister(commentListenerId);
        logger.info('[Phase3] Comment API listener unregistered');
      }
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
      logger.info({ attempt }, '[Drawer] Attempting to open [选择作品] drawer');

      // 使用 tryClickBySelector 统一处理（text优先 + CSS回退）
      const clicked = await tryClickBySelector(page, selectWorkDef, { timeout: 10000 });

      if (clicked) {
        logger.info({ attempt }, '[Drawer] Button click succeeded, waiting for drawer');
        await HumanActions.wait(page, 1500, 3000);

        const drawerVisible = await this.isDrawerVisible(page);
        if (drawerVisible) {
          logger.info('[Drawer] Drawer confirmed visible');
          return true;
        }

        logger.warn({ attempt }, '[Drawer] Click succeeded but drawer not detected by selectors, proceeding anyway');
        return true;
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
      // 使用管理的选择器检测抽屉可见性
      const drawerSelectors = [
        getSelector('drawer.portal').css,
        getSelector('drawer.sidesheet').css,
        getSelector('drawer.content').css,
        '.semi-sidesheet-visible',
        '.semi-modal-content',
      ].filter(Boolean) as string[];

      for (const selector of drawerSelectors) {
        const visible = await HumanActions.cdpIsElementVisible(page, selector);
        if (visible) {
          logger.info({ selector }, 'Drawer detected as visible');
          return true;
        }
      }

      try {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        if (bodyText.includes('选择作品') && (bodyText.includes('评论数') || bodyText.includes('发布于'))) {
          logger.info('Drawer content detected via body text (选择作品 + 评论数/发布于)');
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
    const MAX_SCROLL_ATTEMPTS_DRAWER = 20;
    const descLower = description.toLowerCase();
    const descPrefix = descLower.substring(0, Math.min(descLower.length, 25));

    logger.info({ awemeId, descPrefix }, '[Drawer] Searching for target video in drawer');

    for (let scrollAttempt = 0; scrollAttempt <= MAX_SCROLL_ATTEMPTS_DRAWER; scrollAttempt++) {
      await HumanActions.wait(page, 400, 700);

      const containerElements = await HumanActions.queryElementsWithInfo(page, '.container-Lkxos9');
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
    const containerElements = await HumanActions.queryElementsWithInfo(page, '.container-Lkxos9');
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

      const titleEls = await HumanActions.queryElementsWithInfo(page, '.title-LUOP3b');
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

  private async scrollDrawerForMore(page: Page, scrollAttempt: number): Promise<void> {
    logger.info({ scrollAttempt }, '[Drawer] Scrolling drawer to load more videos');

    const drawerContentDef = getSelector('drawer.content');
    const drawerScrollSelectors = [
      drawerContentDef.css,
      '.semi-sidesheet-body > div:nth-child(2)',
      '.semi-sidesheet-body > div',
      '[class*="semi-sidesheet"] [class*="list"]',
      '[class*="semi-sidesheet"] [class*="scroll"]',
      '[class*="semi-sidesheet"] [class*="body"]',
    ].filter(Boolean) as string[];

    const scrollContainer = await HumanActions.cdpFindScrollContainer(page, drawerScrollSelectors);
    if (scrollContainer) {
      logger.info({ selector: scrollContainer.sel }, '[Drawer] Scrolling drawer container');
      await HumanActions.cdpSmartScroll(page, [scrollContainer.sel], 250, 'down');
    } else {
      logger.info('[Drawer] No scroll container found, trying CDP wheel on drawer body');
      const bodyCss = drawerContentDef.css || '.douyin-creator-interactive-sidesheet-body';
      await HumanActions.cdpSmartScroll(page, [bodyCss], 250, 'down');
    }

    await HumanActions.wait(page, 1000, 2000);
  }

  private async waitForCommentResponse(page: Page): Promise<InterceptedResponse | null> {
    const timeout = 20000;
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
}
