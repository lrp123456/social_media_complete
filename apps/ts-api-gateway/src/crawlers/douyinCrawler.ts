import { Page } from 'patchright';
import { RequestInterceptor, HumanActions, BrowserManager, ExitStrategy, PageType } from '@social-media/browser-core';
import { getSelector, getRandomExitSubmenuKey, getSubmenuKeyForPageType } from './menuSelectors';
import { getSelectorReader } from '../lib/selectorStore';
import { resolveAndClick, tryClickBySelector } from './menuNavigator';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { isDebugModeEnabled, createReplySessionId, createManifest, saveDebugSnapshot, finishManifest, DebugManifest } from '../lib/replyDebugLogger';
import { recordSelectorTry } from '../lib/taskExecutionRecorder';
import { isDescriptionMatch } from './timeParser';
import { getCommentCrawlDecision, getRootCidSetForIncremental, shouldCompareReplyCounts, truncateToNewest, ROOT_COMMENT_RETRY_LIMIT } from '../services/commentCrawlRules';
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
  isPinned: boolean;        // 新增：是否置顶
};

export type CommentInfo = {
  cid: string;
  text: string;
  user_nickname: string;
  user_uid: string;
  digg_count: number;
  create_time: number;
  reply_id: string;
  label_type?: number;
  label_text?: string;
  imageUrls?: string[];
};

export interface CommentNode {
  cid: string;
  text: string;
  userNickname: string;
  userUid: string;
  isAuthor?: boolean;
  createTime: number;
  diggCount: number;
  level: 1 | 2;
  rootId?: string;
  parentId?: string;
  replyToName?: string;
  replyId: string;
  subComments?: CommentNode[];
  imageUrls?: string[];
}

export interface RootCommentSnapshot {
  cid: string;
  text: string;
  replyCount: number;
  createTime: number;
  userUid: string;
  userNickname: string;
  labelType?: number;
  imageUrls?: string[];
}

// 引用共享回复目标接口
import { ReplyTarget } from './replyTypes';
export { ReplyTarget };

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
const COMMENT_LIST_PATTERN_V2 = '/aweme/v1/creator/comment/list'; // 抖音创作者平台新 API 端点（301→200 重定向）
const COMMENT_REPLY_PATTERN = '/aweme/v1/web/comment/list/reply'; // 子回复 API
const ALL_COMMENT_PATTERNS = [COMMENT_LIST_PATTERN, COMMENT_LIST_PATTERN_V2, COMMENT_REPLY_PATTERN];
const COMMENT_LIST_PATTERNS = [COMMENT_LIST_PATTERN, COMMENT_LIST_PATTERN_V2]; // 所有评论列表 pattern

const MAX_SCROLL_ATTEMPTS = 30;
const MAX_SCROLL_NO_NEW_DATA = 10;

const RISK_CONTROL_KEYWORDS = ['captcha', 'login', '安全验证', '验证码', '账号异常', 'risk', 'verify'];
const RISK_CONTROL_URLS = ['/login', '/passport', '/verify', '/captcha'];

export interface CommentQueueItem {
  awemeId: string;
  description: string;
  createTime: number;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;  // true = 新视频首次采集（全量展开+建快照）
  _userId: number;        // 内部用，携带 userId
  isPinned?: boolean;     // 是否置顶
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
  private awemeIdToViewCount: Map<string, number> = new Map();
  private awemeIdToIsPinned: Map<string, boolean> = new Map();

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
      const isCommentList = COMMENT_LIST_PATTERNS.includes(pattern);
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

    // 从 raw responses 中提取 authorUid 和 view_count（增量构建，供滚动循环和后处理共用）
    // 抖音 item_list 实际字段：item.user_id（字符串），不是嵌套的 author 对象
    // 抖音 work_list 字段可能不同（item.author?.uid），都做兼容
    const awemeIdToAuthor = new Map<string, { uid: string; nickname: string }>();
    const awemeIdToIsPinned = new Map<string, boolean>();
    const awemeIdToViewCount = new Map<string, number>();
    const privateAwemeIds = new Set<string>();

    /** 从 raw responses 中增量更新 viewCount map，返回当前公开视频数 */
    const updateViewCountMapAndGetPublicCount = (): number => {
      const rawResponses = this.interceptor.getResponses(pattern) || [];
      for (const resp of rawResponses) {
        const body = (resp as any)?.body;
        if (!body || typeof body !== 'object') continue;
        const rawItems: any[] =
          (Array.isArray(body.items) ? body.items : null) ||
          (Array.isArray(body.video_list) ? body.video_list : null) ||
          (Array.isArray(body.aweme_list) ? body.aweme_list : null) ||
          (Array.isArray(body.item_list) ? body.item_list : null) ||
          (Array.isArray(body.data?.items) ? body.data.items : null) ||
          (Array.isArray(body.data?.list) ? body.data.list : null) ||
          (Array.isArray(body.data?.aweme_list) ? body.data.aweme_list : null) ||
          (Array.isArray(body.data?.videoList) ? body.data.videoList : null) ||
          [];
        for (const raw of rawItems) {
          const id = raw.aweme_id || raw.item_id || raw.id;
          const uid = raw.user_id || raw.author?.uid || raw.author_id;
          if (id && uid) {
            awemeIdToAuthor.set(String(id), {
              uid: String(uid),
              nickname: raw.author?.nickname || raw.user_name || raw.nickname || '',
            });
          }
          if (id) {
            awemeIdToIsPinned.set(String(id), raw.is_pinned === true);
          }
          const viewCount = raw.metrics?.view_count;
          if (id && viewCount !== undefined) {
            awemeIdToViewCount.set(String(id), Number(viewCount));
            if (Number(viewCount) === 0) {
              privateAwemeIds.add(String(id));
            }
          }
        }
      }
      // 公开视频数 = 已收集总数 - 已知非公开数
      const collectedCount = this.interceptor.getCollectedCount(pattern);
      const publicCount = collectedCount - privateAwemeIds.size;
      return publicCount;
    };

    // 初始更新一次，获取初始公开视频数
    const initialPublicCount = updateViewCountMapAndGetPublicCount();
    logger.info({ source, collected: initialItems.length, publicCount: initialPublicCount, privateCount: privateAwemeIds.size }, '[Phase1] Initial view count map built');

    // 传入公开视频计数回调，让滚动循环用公开视频数判断是否停止
    await this.scrollToLoadMoreWithDualStop(page, pattern, updateViewCountMapAndGetPublicCount);

    const allItems = this.interceptor.getCollectedItems(pattern);

    logger.info(
      { source, mapSize: awemeIdToAuthor.size, sampleAuthor: awemeIdToAuthor.size > 0 ? Array.from(awemeIdToAuthor.values())[0] : null },
      '[Phase1] Author extraction from raw responses',
    );

    // 先过滤非公开，再截断到 maxMonitorVideos（确保返回的公开视频数尽量达到目标）
    const enriched = allItems.map((item: any) => {
      const author = awemeIdToAuthor.get(String(item.aweme_id));
      return {
        ...item,
        authorUid: author?.uid || '',
        authorNickname: author?.nickname || '',
        isPinned: awemeIdToIsPinned.get(String(item.aweme_id)) || false,
      };
    });

    // 非公开视频过滤：metrics.view_count === 0 视为非公开
    const filtered = enriched.filter((item: any) => {
      const viewCount = awemeIdToViewCount.get(String(item.aweme_id));
      if (viewCount === 0) {
        logger.info({ awemeId: item.aweme_id }, '[Phase1] 过滤非公开视频（view_count=0）');
        return false;
      }
      return true; // viewCount 为 undefined 时视为公开（字段缺失不等于非公开）
    });

    logger.info({
      source,
      step: 'FETCH_COMPLETE',
      totalCollected: allItems.length,
      totalResponses: this.interceptor.getResponseCount(pattern),
      finalCount: filtered.length,
      privateFiltered: enriched.length - filtered.length,
      maxMonitor: this.maxMonitorVideos,
      awemeIds: filtered.map(i => i.aweme_id),
    }, 'Video list fetch completed');

    this.awemeIdToViewCount = awemeIdToViewCount;
    this.awemeIdToIsPinned = awemeIdToIsPinned;
    return filtered;
  }

  /**
   * 滚动加载视频列表，支持双停止条件：
   * 1. 公开视频数达到 maxMonitorVideos（通过 getPublicCount 回调计算）
   * 2. 连续无新数据
   *
   * @param getPublicCount 可选回调，返回当前已收集的公开视频数（过滤非公开后）
   *                      如果不提供，则使用原始 collectedCount 作为停止条件
   */
  private async scrollToLoadMoreWithDualStop(
    page: Page,
    pattern: string,
    getPublicCount?: () => number,
  ): Promise<void> {
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
        }, 'Background daemon detected new data');
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
      }, 'Scroll loop iteration (async dual-track)');

      // 使用公开视频数判断是否达到目标数量
      if (publicCount >= this.maxMonitorVideos) {
        logger.info({ collectedCount, publicCount, maxMonitor: this.maxMonitorVideos, totalScrolls }, 'Public video quantity cap reached - stopping scroll');
        break;
      }

      if (this.interceptor.hasDataExhausted(pattern)) {
        logger.info({ totalScrolls, collectedCount, publicCount }, 'Data exhausted (has_more=false) - stopping scroll');
        break;
      }

      if (scrollsSinceNewData >= MAX_SCROLL_NO_NEW_DATA) {
        logger.info({ totalScrolls, scrollsSinceNewData, collectedCount, publicCount }, 'No new data after consecutive scrolls - stopping');
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
          publicCount: getPublicCount ? getPublicCount() : postScrollCount,
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

    logger.info({
      step: 'SCROLL_LOOP_DONE',
      totalScrolls,
      finalCollected: this.interceptor.getCollectedCount(pattern),
      finalPublic: getPublicCount ? getPublicCount() : this.interceptor.getCollectedCount(pattern),
      finalResponses: this.interceptor.getResponseCount(pattern),
    }, 'Scroll loop finished');
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
    for (const p of COMMENT_LIST_PATTERNS) {
      this.interceptor.clear(p);
    }

    const listenerId = await this.interceptor.register(page, COMMENT_LIST_PATTERNS);

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

      const response = await this.waitForCommentResponse(page, 10000);
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

  /**
   * 从 API 评论对象中提取图片 URL 列表
   * 支持 image_list (新格式) 和 imageList (旧格式)
   */
  private extractImageUrls(c: any): string[] | undefined {
    const imageList = c.image_list || c.imageList;
    if (imageList && Array.isArray(imageList) && imageList.length > 0) {
      const urls = imageList
        .map((img: any) => {
          const urlList = img.url_list || img.urlList;
          if (urlList && Array.isArray(urlList) && urlList.length > 0) {
            return urlList[0];
          }
          return null;
        })
        .filter((url: string | null) => url !== null) as string[];
      return urls.length > 0 ? urls : undefined;
    }
    return undefined;
  }

  private parseCommentList(body: any): CommentInfo[] {
    // 支持 comment_info_list 和 comments 两种格式
    const comments = body.comment_info_list || body.comments;
    if (!comments || !Array.isArray(comments)) return [];

    // 判断是否为 comment_info_list 格式（新格式）
    const isNewFormat = !!body.comment_info_list;

    const rootComments = comments.filter((c: any) => {
      let replyId: string;
      if (isNewFormat) {
        replyId = '0'; // comment_info_list 中的评论总是根评论
      } else {
        replyId = String(c.reply_id ?? c.replyId ?? '0');
      }
      return replyId === '0' || replyId === null || replyId === undefined;
    });

    logger.info({ totalReceived: comments.length, rootComments: rootComments.length, format: isNewFormat ? 'comment_info_list' : 'comments' }, 'Root comment filter applied');

    return rootComments.map((c: any) => {
      const imageUrls = this.extractImageUrls(c);

      if (isNewFormat) {
        return {
          cid: c.comment_id || '',
          text: c.text || '',
          user_nickname: c.user_info?.screen_name || '',
          user_uid: c.user_info?.user_id || '',
          digg_count: parseInt(String(c.digg_count || '0'), 10),
          create_time: parseInt(String(c.create_time || '0'), 10),
          reply_id: '0',
          label_type: c.label_type ?? 0,
          label_text: c.label_text || '',
          imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
        };
      }

      return {
        cid: c.cid,
        text: c.text || '',
        user_nickname: c.user?.nickname || '',
        user_uid: c.user?.uid || '',
        digg_count: c.digg_count || 0,
        create_time: c.create_time,
        reply_id: String(c.reply_id ?? c.replyId ?? '0'),
        label_type: c.label_type ?? 0,
        label_text: c.label_text || '',
        imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
      };
    });
  }

  /**
   * 从评论列表 API 响应中提取每条根评论的快照（cid + subCommentCount）
   * 用于后续增量对比检测
   * 抖音 API: /comment/list/select → { comments: [...] }
   * 新格式: /comment/list/select → { comment_info_list: [...] }
   */
  private parseRootCommentSnapshots(body: any): RootCommentSnapshot[] {
    // 支持 comment_info_list 和 comments 两种格式
    const comments: any[] = body?.comment_info_list || body?.comments || [];
    const isNewFormat = !!body?.comment_info_list;

    return comments
      .filter((c: any) => {
        if (isNewFormat) {
          return true; // comment_info_list 中的评论总是根评论
        }
        const replyId = c.reply_id ?? '0';
        return replyId === '0' || replyId === 0 || replyId === null;
      })
      .map((c: any) => {
        const imageUrls = this.extractImageUrls(c);
        if (isNewFormat) {
          return {
            cid: c.comment_id || '',
            text: c.text || '',
            replyCount: c.reply_comment_total ?? 0,
            createTime: parseInt(String(c.create_time || '0'), 10),
            userUid: c.user_info?.user_id || '',
            userNickname: c.user_info?.screen_name || '',
            labelType: c.label_type ?? 0,
            imageUrls,
          };
        }
        return {
          cid: c.cid,
          text: c.text || '',
          replyCount: c.reply_comment_total ?? 0,
          createTime: c.create_time,
          userUid: c.user?.uid || '',
          userNickname: c.user?.nickname || '',
          labelType: c.label_type ?? 0,
          imageUrls,
        };
      });
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

  /**
   * 检测抖音二次验证面板（"身份验证" + "接收短信验证码"）
   */
  async detectSecondVerify(page: Page): Promise<boolean> {
    try {
      const bodyText = await HumanActions.cdpGetBodyText(page);
      return bodyText.includes('身份验证') && bodyText.includes('接收短信验证码');
    } catch { return false; }
  }

  /**
   * 点击"接收短信验证码"按钮，触发短信发送
   */
  async triggerSmsVerify(page: Page): Promise<boolean> {
    try {
      const clicked = await HumanActions.cdpClickByText(page, '接收短信验证码', { timeout: 5000 });
      if (clicked) {
        logger.info('[SecondVerify] Clicked 接收短信验证码');
        await HumanActions.wait(page, 2000, 3000);
        return true;
      }
      logger.warn('[SecondVerify] Failed to click 接收短信验证码');
      return false;
    } catch (err: any) {
      logger.error({ err: err.message }, '[SecondVerify] triggerSmsVerify failed');
      return false;
    }
  }

  /**
   * 填入验证码并提交
   */
  async submitVerifyCode(page: Page, code: string): Promise<boolean> {
    try {
      // 查找验证码输入框 — 抖音通常用 input[type="tel"] 或带 placeholder 的 input
      const inputSelectors = [
        'input[type="tel"]',
        'input[placeholder*="验证码"]',
        'input[placeholder*="请输入"]',
        'input[maxlength="6"]',
        'input[type="text"]',
        'input[type="number"]',
      ];
      let filled = false;
      for (const sel of inputSelectors) {
        const inputs = await page.$$(sel);
        for (const input of inputs) {
          const isVisible = await input.isVisible().catch(() => false);
          if (!isVisible) continue;
          const currentValue = await input.inputValue().catch(() => '');
          if (currentValue.length > 0) continue; // 跳过已填的
          await input.fill(code);
          await HumanActions.wait(page, 500, 1000);
          filled = true;
          logger.info({ selector: sel }, '[SecondVerify] Code filled');
          break;
        }
        if (filled) break;
      }
      if (!filled) {
        logger.error('[SecondVerify] No suitable input found for verify code');
        return false;
      }

      // 查找提交按钮
      const submitTexts = ['发送', '确认', '提交', '验证', '确定'];
      let submitted = false;
      for (const text of submitTexts) {
        submitted = await HumanActions.cdpClickByText(page, text, { timeout: 3000 });
        if (submitted) {
          logger.info({ text }, '[SecondVerify] Submit button clicked');
          await HumanActions.wait(page, 2000, 3000);
          break;
        }
      }
      if (!submitted) {
        // 尝试 CSS 选择器
        const btn = await page.$('button[type="submit"], button[class*="submit"], button[class*="confirm"]');
        if (btn) { await btn.click(); submitted = true; }
      }
      return submitted;
    } catch (err: any) {
      logger.error({ err: err.message }, '[SecondVerify] submitVerifyCode failed');
      return false;
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

        // 合并图片数据
        const imageList = apiMatch.image_list || apiMatch.imageList;
        if (imageList && Array.isArray(imageList) && imageList.length > 0) {
          const urls = imageList
            .map((img: any) => {
              const urlList = img.url_list || img.urlList;
              if (urlList && Array.isArray(urlList) && urlList.length > 0) {
                return urlList[0];
              }
              return null;
            })
            .filter((url: string | null) => url !== null);
          if (urls.length > 0) {
            node.imageUrls = urls;
          }
        }
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

    // syncPlatformAuthorId 会处理首次绑定 + 自愈检测，不需要 needAuthorId 标志

    logger.info({ userId }, '[Phase1] Fetching video list from source');
    let videos = await this.fetchVideoListFromSource(page, source);
    const fetchedCount = videos.length;
    videos = truncateToNewest(videos, this.maxMonitorVideos);
    logger.info({ userId, fetched: fetchedCount, monitored: videos.length, cap: this.maxMonitorVideos }, '[Phase1] Truncated to newest N videos');

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

    // 批量查询根评论 count（level=1），用于判断 root_comments_missing
    let rootCountMap = new Map<string, number>();
    try {
      const rootCounts = await prisma.comment.groupBy({
        by: ['videoId'],
        where: { videoId: { in: dbVideos.map(v => v.id) }, level: 1 },
        _count: { id: true },
      });
      rootCountMap = new Map(rootCounts.map(r => [r.videoId, r._count.id]));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[Phase1] Failed to batch query root comment counts, defaulting to 0');
    }

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

    // 动态剔除：已入库视频变为非公开（view_count=0）时从数据库删除
    const awemeIdToViewCount = this.awemeIdToViewCount;
    const awemeIdToIsPinned = this.awemeIdToIsPinned;
    for (const dbVideo of dbVideos) {
      const freshItem = videos.find((f: any) => f.aweme_id === dbVideo.id);
      if (!freshItem) {
        const viewCount = awemeIdToViewCount.get(dbVideo.id);
        if (viewCount === 0) {
          logger.info({ awemeId: dbVideo.id }, '[Phase1] 已入库视频变为非公开，剔除');
          await prisma.video.delete({ where: { id: dbVideo.id } });
        }
      }
    }

    const commentsQueue: CommentQueueItem[] = [];

    for (const video of videos) {
      const dbVideo = dbVideos.find(v => v.id === video.aweme_id);
      const decision = getCommentCrawlDecision({
        currentCount: video.comment_count,
        storedCount: dbVideo?.commentCount,
        rootCommentCount: dbVideo ? (rootCountMap.get(dbVideo.id) ?? 0) : 0,
        retryCount: dbVideo?.rootCommentRetryCount ?? 0,
      });

      if (!dbVideo) {
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

        if (decision.shouldQueue) {
          logger.info({
            awemeId: video.aweme_id,
            description: video.description,
            commentCount: video.comment_count,
            reason: decision.reason,
          }, '[Phase1] New video with comments — enqueuing for initial fetch');
          commentsQueue.push({
            awemeId: video.aweme_id,
            description: video.description,
            createTime: video.create_time,
            oldCount: 0,
            newCount: video.comment_count,
            isFirstCrawl: decision.isFirstCrawl,
            _userId: userId,
            isPinned: awemeIdToIsPinned.get(video.aweme_id) || false,
          });
        } else {
          logger.info({ awemeId: video.aweme_id, description: video.description, reason: decision.reason }, '[Phase1] New video with no comments — skipping');
        }

        if (video.authorUid) {
          await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
        }
        continue;
      }

      if (decision.shouldQueue) {
        const diff = video.comment_count - dbVideo.commentCount;
        if (decision.reason === 'root_comments_missing') {
          logger.info({
            awemeId: video.aweme_id,
            description: video.description?.slice(0, 30),
            currentCount: video.comment_count,
            rootCommentCount: rootCountMap.get(dbVideo?.id || '') ?? 0,
            retryCount: dbVideo?.rootCommentRetryCount ?? 0,
          }, '[Phase1] Root comments missing — enqueuing for retry');
        }
        logger.info({
          awemeId: video.aweme_id,
          description: video.description,
          oldCount: dbVideo.commentCount,
          newCount: video.comment_count,
          diff,
          reason: decision.reason,
        }, '[Phase1] Comment count changed — enqueuing for comment fetch (NO click on list page)');

        commentsQueue.push({
          awemeId: video.aweme_id,
          description: video.description,
          createTime: video.create_time,
          oldCount: dbVideo.commentCount,
          newCount: video.comment_count,
          isFirstCrawl: decision.isFirstCrawl,
          _userId: userId,
          isPinned: awemeIdToIsPinned.get(video.aweme_id) || false,
        });
      } else {
        logger.info({
          awemeId: video.aweme_id,
          current: video.comment_count,
          stored: dbVideo.commentCount,
          reason: decision.reason,
        }, '[Phase1] Comment count unchanged');
        // 评论数未变但根评论缺失且已达到重试上限 → 放弃
        const rootCommentCount = rootCountMap.get(dbVideo?.id || '') ?? 0;
        const retryCount = dbVideo?.rootCommentRetryCount ?? 0;
        if (video.comment_count > 0 && rootCommentCount === 0 && retryCount >= ROOT_COMMENT_RETRY_LIMIT) {
          logger.info({
            awemeId: video.aweme_id,
            retryCount,
            limit: ROOT_COMMENT_RETRY_LIMIT,
          }, '[Phase1] Root comments missing but retry limit reached — giving up');
        }
      }
    }

    // 如果循环中未提取到 authorId（所有视频都已入库），从第一个有 authorUid 的视频提取
    for (const video of videos) {
      if (video.authorUid) {
        await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
        break;
      }
    }

    logger.info({ userId, videoCount: videos.length }, '[Phase1] Comparison done, upserting videos to database');
    await db.reconcileVideosForUser(userId, 'douyin', videos, this.maxMonitorVideos);

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
      const existingResp = this.interceptor.getResponses(COMMENT_LIST_PATTERN)
        .concat(this.interceptor.getResponses(COMMENT_LIST_PATTERN_V2));
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
        for (const p of COMMENT_LIST_PATTERNS) {
          this.interceptor.clear(p);
        }
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
          const existingCommentResp = COMMENT_LIST_PATTERNS.flatMap(p => this.interceptor.getResponses(p));
          if (existingCommentResp.length > 0) {
            const latestResp = existingCommentResp[existingCommentResp.length - 1];
            const preComments = latestResp.body?.comments || [];
            const hasTarget = preComments.some((c: any) => c.aweme_id === item.awemeId);
            if (hasTarget) {
              logger.info({ awemeId: item.awemeId, preCheckMs: Date.now() - preCheckStart }, '[Phase3] Target video already loaded (interceptor has response), skipping drawer');
              allResponses = await this.collectAllCommentResponses(page);
            } else {
              logger.info({ awemeId: item.awemeId, preCheckMs: Date.now() - preCheckStart }, '[Phase3] Pre-check: interceptor response for different video, clearing');
              for (const p of COMMENT_LIST_PATTERNS) {
                this.interceptor.clear(p);
              }
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
              for (const p of COMMENT_LIST_PATTERNS) {
                this.interceptor.clear(p);
              }
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

        // 合并所有分页的 comments（支持 comments 和 comment_info_list 两种格式）
        const allComments = allResponses.flatMap((r: any) => r.body?.comment_info_list || r.body?.comments || []);
        const wrappedBody = { comments: allComments, comment_info_list: allComments };
        const pageCommentCounts = allResponses.map((r: any, i: number) => ({
          page: i + 1,
          comments: (r.body?.comment_info_list || r.body?.comments || []).length,
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

        const isFirstCrawl = item.isFirstCrawl;
        const snapshotFallback = !isFirstCrawl && lastSnapshots.size === 0;
        if (snapshotFallback) {
          logger.warn({ awemeId: item.awemeId }, '[Tree] Incremental crawl missing root snapshots — using DB cid fallback without switching to first crawl');
        }
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
        const expandedComments = allCapturedResponses.flatMap((r: any) => r.body?.comment_info_list || r.body?.comments || []);
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

          // 查询作者 ID 用于 isAuthor 判断
          const firstCrawlUser = await db.getUserById(item._userId!);
          const firstCrawlAuthorId = firstCrawlUser?.platformAuthorId;

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
            is_author?: boolean; imageUrls?: string;
          }> = [];

          for (const root of rootComments) {
            const rootUid = root.user?.uid || '';
            const rootIsAuthor = (root.label_type === 1)
              || (firstCrawlAuthorId ? String(rootUid) === String(firstCrawlAuthorId) : false);
            const rootImageUrls = this.extractImageUrls(root);
            allFlat.push({
              cid: root.cid, text: root.text || '',
              user_nickname: root.user?.nickname || '', user_uid: rootUid,
              digg_count: root.digg_count || 0, create_time: root.create_time,
              reply_id: '0', level: 1,
              is_author: rootIsAuthor,
              imageUrls: rootImageUrls ? JSON.stringify(rootImageUrls) : undefined,
            });
          }
          for (const sub of subReplies) {
            const replyId = String(sub.reply_id ?? '0');
            const subUid = sub.user?.uid || '';
            const subIsAuthor = (sub.label_type === 1)
              || (firstCrawlAuthorId ? String(subUid) === String(firstCrawlAuthorId) : false);
            const subImageUrls = this.extractImageUrls(sub);
            allFlat.push({
              cid: sub.cid, text: sub.text || '',
              user_nickname: sub.user?.nickname || '', user_uid: subUid,
              digg_count: sub.digg_count || 0, create_time: sub.create_time,
              reply_id: replyId, rootId: replyId, parentId: replyId,
              level: 2, replyToName: sub.reply_to_username || '',
              is_author: subIsAuthor,
              imageUrls: subImageUrls ? JSON.stringify(subImageUrls) : undefined,
            });
          }

          const dbStart = Date.now();
          await db.upsertCommentTree(item.awemeId, allFlat);
          await prisma.comment.updateMany({ where: { videoId: item.awemeId }, data: { isNew: 0 } });
          // commentCount 已在 Phase 1 由 reconcileVideosForUser 存储 API 真实值，此处不再覆盖
          const dbMs = Date.now() - dbStart;

          logger.info({ awemeId: item.awemeId, totalComments: allFlat.length, roots: rootComments.length, subs: subReplies.length, isFirstCrawl: true, dbWriteMs: dbMs }, '[Tree] Phase3c: first crawl DB write complete — all comments saved as isNew=0 (%dms)', dbMs);

          // 首次爬取成功，重置根评论重试计数
          await prisma.video.update({
            where: { id: item.awemeId },
            data: { rootCommentRetryCount: 0 },
          });
          logger.info({ awemeId: item.awemeId }, '[Phase3] Root comment retry count reset to 0 (first crawl)');

          // 首次爬取也构建 commentGroups，用于发送摘要通知
          // 将每个根评论及其子回复组成一个 group，newInGroup 包含该组全部评论
          const firstCrawlGroups: Array<{
            rootComment: CommentNode;
            subReplies: CommentNode[];
            newInGroup: CommentNode[];
          }> = [];

          for (const root of rootComments) {
            const rootCid = String(root.cid);
            const groupSubs = subReplies
              .filter(s => String(s.reply_id ?? '0') === rootCid)
              .map(s => {
                const subUid = s.user?.uid || '';
                const subLabelType = s.label_type ?? 0;
                const subIsAuthor = (subLabelType === 1)
                  || (firstCrawlAuthorId ? String(subUid) === String(firstCrawlAuthorId) : false);
                const subImageUrls = this.extractImageUrls(s);
                return {
                  cid: String(s.cid || ''),
                  text: s.text || '',
                  userNickname: s.user?.nickname || '',
                  userUid: subUid,
                  createTime: s.create_time || 0,
                  diggCount: s.digg_count || 0,
                  level: 2 as const,
                  rootId: rootCid,
                  parentId: rootCid,
                  replyToName: s.reply_to_username || '',
                  replyId: String(s.reply_id ?? '0'),
                  isAuthor: subIsAuthor,
                  subComments: [],
                  imageUrls: subImageUrls,
                };
              });

            const rootIsAuthorFlag = (root.label_type === 1)
              || (firstCrawlAuthorId ? String(root.user?.uid || '') === String(firstCrawlAuthorId) : false);
            const rootImageUrls = this.extractImageUrls(root);

            const rootNode: CommentNode = {
              cid: rootCid,
              text: root.text || '',
              userNickname: root.user?.nickname || '',
              userUid: root.user?.uid || '',
              createTime: root.create_time || 0,
              diggCount: root.digg_count || 0,
              level: 1,
              replyId: '0',
              isAuthor: rootIsAuthorFlag,
              subComments: [],
              imageUrls: rootImageUrls,
            };

            // 过滤作者评论
            const nonAuthorSubs = groupSubs.filter(s => !s.isAuthor);

            const groupNew: CommentNode[] = [
              ...(rootIsAuthorFlag ? [] : [rootNode]),
              ...nonAuthorSubs,
            ];

            // 如果整个 group 全是作者评论，跳过该 group
            if (groupNew.length === 0) continue;

            firstCrawlGroups.push({
              rootComment: rootNode,
              subReplies: nonAuthorSubs,
              newInGroup: groupNew,
            });
          }

          logger.info({ awemeId: item.awemeId, groupCount: firstCrawlGroups.length, totalComments: allFlat.length }, '[Tree] First crawl: built %d commentGroups for summary notification', firstCrawlGroups.length);

          // 通知去重：检查评论是否已存在于 DB（可能被其他用户首次爬取过）
          // 如果某个 group 的所有评论都已存在，则该 group 不需要发通知
          if (firstCrawlGroups.length > 0) {
            const allCids = firstCrawlGroups.flatMap(g => g.newInGroup.map(n => n.cid));
            if (allCids.length > 0) {
              const existingCids = new Set(
                (await prisma.comment.findMany({
                  where: { cid: { in: allCids } },
                  select: { cid: true },
                })).map(c => c.cid)
              );

              const originalCount = firstCrawlGroups.length;
              for (let i = firstCrawlGroups.length - 1; i >= 0; i--) {
                const g = firstCrawlGroups[i];
                const hasNewComment = g.newInGroup.some(n => !existingCids.has(n.cid));
                if (!hasNewComment) {
                  firstCrawlGroups.splice(i, 1);
                }
              }

              if (firstCrawlGroups.length < originalCount) {
                logger.info({
                  awemeId: item.awemeId,
                  originalGroups: originalCount,
                  filteredGroups: firstCrawlGroups.length,
                  existingCidCount: existingCids.size,
                }, '[Tree] First crawl: filtered groups where all comments already exist in DB (cross-user dedup)');
              }
            }
          }

          results.push({ awemeId: item.awemeId, success: true, comments: [], commentGroups: firstCrawlGroups } as any);
        } else {
          // ════════════════════════════════════════
          // 后续增量检测：对比快照 + 新增/变更加载
          // ════════════════════════════════════════

          const newCommentsToUpsert: Array<{
            cid: string; text: string; user_nickname: string; user_uid: string;
            digg_count: number; create_time: number; reply_id: string;
            rootId?: string; parentId?: string; level: number; replyToName?: string;
            is_author?: boolean; imageUrls?: string;
          }> = [];

          const apiRootCids = new Set(currentSnapshots.map(s => s.cid));

          // 加载该视频的所有已入库 cid（含子回复），用于去重展开后的子回复
          const dbAllCids = new Set(
            (await prisma.comment.findMany({
              where: { videoId: item.awemeId },
              select: { cid: true },
            })).map(c => c.cid)
          );
          const dbRootCids = getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots);

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
          // 判定条件：DB 没有该 cid = 新评论。不再用 createTime > lastCheckTime
          // 因为评论可能因热度排序、置顶等原因 createTime 早于 lastCheckTime 但仍是 DB 缺失的新评论
          let newRootsFrom3a = 0;
          for (const snapshot of currentSnapshots) {
            if (!dbRootCids.has(snapshot.cid)) {
              const isAuthor = (snapshot.labelType === 1)
                || (platformAuthorId ? snapshot.userUid === platformAuthorId : false);
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
                is_author: isAuthor,
                imageUrls: snapshot.imageUrls ? JSON.stringify(snapshot.imageUrls) : undefined,
              });
            }
          }

          logger.info({ awemeId: item.awemeId, newRootsFrom3a }, '[Tree] Incremental 3a: new root comments found=%d', newRootsFrom3a);

          // ── 3b-0. 将 trulyNew 中的子评论直接计入 newSubs ──
          // trulyNew 仅过滤掉"本次抓取期间重复的 cid"，但可能含 DB 已入库的旧子回复
          // （例如展开按钮触发的 reply API 拿到的本来就在 DB 里的子回复）
          // 必须用 dbAllCids 做最终去重判定
          let newSubsFromTrulyNew = 0;
          for (const c of trulyNew) {
            const replyId = c.reply_id ?? '0';
            const isSub = replyId !== 0 && replyId !== '0' && replyId !== null;
            if (!isSub) continue;
            const cid = String(c.cid || '');
            if (!cid || dbAllCids.has(cid)) continue; // 已在 DB 中，跳过
            const createTime = c.create_time || 0;
            const isAuthor = (c.label_type === 1)
              || (platformAuthorId ? (c.user?.uid || '') === platformAuthorId : false);
            newSubsFromTrulyNew++;
            const trulyNewImageUrls = this.extractImageUrls(c);
            newCommentsToUpsert.push({
              cid,
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
              is_author: isAuthor,
              imageUrls: trulyNewImageUrls ? JSON.stringify(trulyNewImageUrls) : undefined,
            });
          }
          if (newSubsFromTrulyNew > 0) {
            logger.info({ awemeId: item.awemeId, count: newSubsFromTrulyNew }, '[Tree] Incremental 3b-0: new subs from API interceptor=%d', newSubsFromTrulyNew);
          }

          // ── 3b. 根评论 replyCount 增加 → 局部展开 ──
          // 判定条件：cid 不在 dbAllCids 中 = 新评论
          // 不再用 createTime > lastCheckTime，避免历史回复被错误丢弃
          let rootsWithReplyIncrease = 0;
          let newSubsFrom3b = 0;
          for (const snapshot of currentSnapshots) {
            const lastCount = lastSnapshots.get(snapshot.cid);
            if (shouldCompareReplyCounts(lastSnapshots) && lastCount !== undefined && snapshot.replyCount > lastCount) {
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
                  const cid = apiMatch?.cid || '';
                  const createTime = apiMatch?.create_time || 0;
                  const userUid = apiMatch?.user?.uid || '';
                  const userNickname = apiMatch?.user?.nickname || '';

                  // 用 cid 判断是否已入库；无 cid 时用 lastCheckTime 兜底
                  const isNewComment = cid
                    ? !dbAllCids.has(cid)
                    : createTime * 1000 > lastCheckTime;

                  if (isNewComment) {
                    const isAuthor = (apiMatch?.label_type === 1)
                      || (platformAuthorId ? userUid === platformAuthorId : false);
                    newSubsFrom3b++;
                    const replyImageUrls = this.extractImageUrls(apiMatch);
                    newCommentsToUpsert.push({
                      cid,
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
                      is_author: isAuthor,
                      imageUrls: replyImageUrls ? JSON.stringify(replyImageUrls) : undefined,
                    });
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

          // ── 3f. commentCount 已在 Phase 1 由 reconcileVideosForUser 存储 API 真实值，此处不再覆盖 ──
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

          // 更新根评论重试计数
          if (newRootsFrom3a > 0) {
            await prisma.video.update({
              where: { id: item.awemeId },
              data: { rootCommentRetryCount: 0 },
            });
            logger.info({ awemeId: item.awemeId }, '[Phase3] Root comment retry count reset to 0');
          } else {
            await prisma.video.update({
              where: { id: item.awemeId },
              data: { rootCommentRetryCount: { increment: 1 } },
            });
            logger.info({ awemeId: item.awemeId }, '[Phase3] Root comment retry count incremented');
          }

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
              const incrImageUrls = snapshot.imageUrls;
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
                  imageUrls: incrImageUrls,
                },
                subReplies: [],
                newInGroup: groupNew.map(n => {
                  let nImageUrls: string[] | undefined;
                  if (n.imageUrls) {
                    try { nImageUrls = JSON.parse(n.imageUrls) as string[]; } catch {}
                  }
                  return {
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
                    isAuthor: n.is_author || false,
                    subComments: [],
                    imageUrls: nImageUrls,
                  };
                }),
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

  /**
   * 简单模式 Phase3：仅采集根评论（最多 30 条）
   * 使用纯 CID 去重，不采集子评论内容
   */
  async processCommentsQueueSimple(
    page: Page,
    queue: CommentQueueItem[],
    maxRootComments: number = 30,
  ): Promise<{ results: Array<{ awemeId: string; success: boolean; commentGroups?: any[]; error?: string }> }> {
    const results: Array<{ awemeId: string; success: boolean; commentGroups?: any[]; error?: string }> = [];

    for (const item of queue) {
      try {
        logger.info({ awemeId: item.awemeId, maxRootComments }, '[Simple] Starting simple mode comment collection');

        // ── 清空拦截器中旧的评论响应 ──
        this.interceptor.clear(COMMENT_LIST_PATTERN);
        this.interceptor.clear(COMMENT_LIST_PATTERN_V2);

        // ── 打开抽屉 ──
        const drawerOpened = await this.openSelectWorkDrawer(page);
        if (!drawerOpened) {
          logger.warn({ awemeId: item.awemeId }, '[Simple] Failed to open drawer, skipping');
          results.push({ awemeId: item.awemeId, success: false, error: 'Failed to open drawer' });
          continue;
        }

        // ── 点击视频 ──
        const clicked = await this.findAndClickVideoInDrawer(page, item.awemeId, item.description);
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

          // 提取根评论
          // 诊断日志：检查响应格式
          if (responses.length > 0) {
            const firstResp = responses[0];
            const bodyStr = firstResp.body ? JSON.stringify(firstResp.body).substring(0, 1000) : 'null';
            logger.info({ awemeId: item.awemeId, responseCount: responses.length, bodyPreview: bodyStr }, '[Simple] Comment response body preview');
          }

          const newComments = responses.flatMap(r => {
            const body = r.body || {};
            // 兼容多种响应格式
            // 格式1: { comments: [...] } - /aweme/v1/web/comment/list/select
            // 格式2: { comment_info_list: [...] } - /aweme/v1/creator/comment/list
            const comments = body.comments || body.comment_info_list || body.comment_list || body.data?.comments || body.data?.comment_list || [];
            return Array.isArray(comments) ? comments : [];
          }).filter(c => {
            const cid = c.cid || c.comment_id || c.id || c.commentId;
            return cid && !existingCidSet.has(String(cid));
          });

          if (newComments.length === 0) {
            consecutiveNoNew++;
          } else {
            consecutiveNoNew = 0;
            allComments.push(...newComments);
          }

          // 检查 has_more
          const lastResp = responses[responses.length - 1];
          hasMore = lastResp?.body?.has_more === 1;

          // 继续滚动
          if (hasMore && allComments.length < maxRootComments) {
            await this.scrollCommentArea(page, 'bottom');
            await HumanActions.wait(page, 8000, 8000);
          }
        }

        // 3. 限制到 maxRootComments
        const commentsToStore = allComments.slice(0, maxRootComments);

        // 4. 存储新评论（兼容两种API格式）
        if (commentsToStore.length > 0) {
          for (const comment of commentsToStore) {
            // 格式1: { cid, text, user: { nickname, uid }, digg_count, create_time }
            // 格式2: { comment_id, text, user_info: { screen_name, user_id }, digg_count, create_time }
            const cid = comment.cid || comment.comment_id || '';
            const nickname = comment.user?.nickname || comment.user_info?.screen_name || '';
            const uid = comment.user?.uid || comment.user_info?.user_id || '';
            const diggCount = typeof comment.digg_count === 'string' ? parseInt(comment.digg_count, 10) || 0 : (comment.digg_count || 0);
            const createTime = typeof comment.create_time === 'string' ? parseInt(comment.create_time, 10) || 0 : (comment.create_time || 0);

            await db.upsertComment(item.awemeId, {
              cid,
              text: comment.text || '',
              user_nickname: nickname,
              user_uid: uid,
              digg_count: diggCount,
              create_time: createTime,
              reply_id: '0',
              is_author: comment.is_author || false,
            });
          }

          logger.info({
            awemeId: item.awemeId,
            newCount: commentsToStore.length,
            totalCollected: allComments.length,
          }, '[Simple] Stored new root comments');

          // 5. 构建 commentGroups（与 unifiedQueue 兼容，兼容两种API格式）
          const commentGroups = commentsToStore.map(comment => {
            const cid = comment.cid || comment.comment_id || '';
            const nickname = comment.user?.nickname || comment.user_info?.screen_name || '';
            const uid = comment.user?.uid || comment.user_info?.user_id || '';
            const diggCount = typeof comment.digg_count === 'string' ? parseInt(comment.digg_count, 10) || 0 : (comment.digg_count || 0);
            const createTime = typeof comment.create_time === 'string' ? parseInt(comment.create_time, 10) || 0 : (comment.create_time || 0);

            return {
              rootComment: {
                cid,
                text: comment.text || '',
                userNickname: nickname,
                userUid: uid,
                createTime,
                diggCount,
                level: 1 as const,
                replyId: '0',
                isAuthor: comment.is_author || false,
                subComments: [],
                imageUrls: comment.imageUrls,
              },
              subReplies: [],
              newInGroup: [
                {
                  cid,
                  text: comment.text || '',
                  userNickname: nickname,
                  userUid: uid,
                  createTime,
                  diggCount,
                  level: 1 as const,
                  replyId: '0',
                  isAuthor: comment.is_author || false,
                  subComments: [],
                  imageUrls: comment.imageUrls,
                },
              ],
            };
          });

          // 采到新根评论，重置 retryCount
          await prisma.video.update({
            where: { id: item.awemeId },
            data: { rootCommentRetryCount: 0 },
          });
          logger.info({ awemeId: item.awemeId }, '[Simple] Root comment retry count reset to 0');

          results.push({ awemeId: item.awemeId, success: true, commentGroups });
        } else {
          logger.info({ awemeId: item.awemeId }, '[Simple] No new root comments found');
          // 采空，retryCount +1
          await prisma.video.update({
            where: { id: item.awemeId },
            data: { rootCommentRetryCount: { increment: 1 } },
          });
          logger.info({ awemeId: item.awemeId }, '[Simple] Root comment retry count incremented');
          results.push({ awemeId: item.awemeId, success: true, commentGroups: [] });
        }
      } catch (err) {
        logger.error({ awemeId: item.awemeId, err: (err as Error).message }, '[Simple] Error processing comment queue item');
        results.push({ awemeId: item.awemeId, success: false, error: (err as Error).message });
      }
    }

    return { results };
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
    description: string,
  ): Promise<boolean> {
    const MAX_SCROLL_ATTEMPTS_DRAWER = 25;

    logger.info({ awemeId, descPrefix: description.substring(0, 30) }, '[Drawer] Searching for target video in drawer');

    const maxScrolls = MAX_SCROLL_ATTEMPTS_DRAWER;

    let lastContainerCount = -1;
    let noGrowthRounds = 0;

    for (let scrollAttempt = 0; scrollAttempt <= maxScrolls; scrollAttempt++) {
      await HumanActions.wait(page, 400, 700);

      const containerSelector = getSelector('drawer.video-item').css || '[class*="douyin-creator-interactive-list-items"] > div';
      const containerElements = await HumanActions.queryElementsWithInfo(page, containerSelector);
      const count = containerElements?.length ?? 0;

      if (containerElements && containerElements.length > 0) {
        logger.info({ count, scrollAttempt }, '[Drawer] Found video containers');

        for (const container of containerElements) {
          const containerText = container.text || '';

          if (!isDescriptionMatch(containerText, description)) continue;

          const clicked = await HumanActions.cdpClickNode(page, container.nodeId);
          if (clicked) {
            logger.info({ awemeId, matchType: 'description' }, '[Drawer] 匹配成功（描述前缀）');
            return true;
          }

          const reClicked = await this.tryClickMatchedContainer(page, description.toLowerCase(), description.toLowerCase().substring(0, 25));
          if (reClicked) return true;

          logger.warn({ awemeId }, '[Drawer] Match found but click failed — giving up');
          return false;
        }
      }

      if (scrollAttempt < maxScrolls) {
        logger.info({ scrollAttempt, containerCount: count }, '[Drawer] 未匹配，滚动加载更多');
        await this.scrollDrawerForMore(page, scrollAttempt);

        // count 为本次滚动前的容器数；滚动后可能触发新数据加载，
        // 但新数据要到下一轮 queryElementsWithInfo 才可见。
        // 因此需要 2 次连续无增长 + 哨兵确认，才判定真正耗尽。
        if (count === lastContainerCount) {
          noGrowthRounds++;
          const exhausted = await page.evaluate(() => {
            const els = document.querySelectorAll('[class*="loading"]');
            for (const el of els) {
              if (el.textContent?.includes('没有更多视频')) return true;
            }
            return false;
          }).catch(() => false);
          if (noGrowthRounds >= 2 && exhausted) {
            logger.info({ scrollAttempt, count }, '[Drawer] 滚动后无新视频且哨兵确认耗尽 — 停止');
            break;
          }
        } else {
          noGrowthRounds = 0;
        }
        lastContainerCount = count;
      }
    }

    logger.warn({ awemeId, maxScrolls }, '[Drawer] 滚动穷尽仍未匹配');
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
   * 从抽屉 DOM 中提取所有视频的评论数，更新数据库
   * 抽屉显示"评论数: N"格式的文本
   */
  private async updateCommentCountsFromDrawer(page: Page, userId: number): Promise<Map<string, number>> {
    const updatedCounts = new Map<string, number>();

    try {
      // 等待抽屉内容加载
      await HumanActions.wait(page, 500, 1000);

      // 从 DOM 中提取所有视频的评论数
      const videoItems = await page.evaluate(() => {
        const items = document.querySelectorAll('[class*="douyin-creator-interactive-list-items"] > div, [class*="video-item"], [class*="work-item"]');
        const results: Array<{ id: string; commentCount: number }> = [];

        for (const item of items) {
          const text = item.textContent || '';

          // 提取评论数：匹配"评论数: 123"或"评论数123"格式
          const commentMatch = text.match(/评论数[：:]\s*(\d+)/);
          if (!commentMatch) continue;

          const commentCount = parseInt(commentMatch[1], 10);

          // 尝试从链接或属性中提取视频 ID
          const link = item.querySelector('a[href*="aweme_id"]') as HTMLAnchorElement;
          let awemeId = '';

          if (link) {
            const hrefMatch = link.href.match(/aweme_id=(\d+)/);
            if (hrefMatch) awemeId = hrefMatch[1];
          }

          // 回退：从 data 属性中提取
          if (!awemeId) {
            awemeId = item.getAttribute('data-aweme-id') || item.getAttribute('data-id') || '';
          }

          // 回退：从文本中提取（某些情况下 ID 可能在文本中）
          if (!awemeId) {
            const idMatch = text.match(/(\d{19})/); // 抖音 ID 通常是 19 位
            if (idMatch) awemeId = idMatch[1];
          }

          if (awemeId && commentCount >= 0) {
            results.push({ id: awemeId, commentCount });
          }
        }

        return results;
      });

      if (videoItems && videoItems.length > 0) {
        logger.info({ count: videoItems.length }, '[Douyin-Drawer] Extracted comment counts from drawer DOM');

        for (const { id, commentCount } of videoItems) {
          updatedCounts.set(id, commentCount);
          await db.updateVideoCommentCount(userId, id, commentCount);
          logger.debug({ awemeId: id, commentCount }, '[Douyin-Drawer] Updated video comment count in DB');
        }

        const sampleEntries = Array.from(updatedCounts.entries()).slice(0, 5);
        logger.info(
          { totalExtracted: updatedCounts.size, samples: sampleEntries },
          '[Douyin-Drawer] Comment counts extracted from drawer',
        );
      } else {
        logger.info('[Douyin-Drawer] No comment counts found in drawer DOM');
      }
    } catch (error: any) {
      logger.warn({ error: error.message }, '[Douyin-Drawer] Error extracting comment counts from drawer');
    }

    return updatedCounts;
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

  // ─────────────────────────────────────────────────────────────────
  // ★ Bugfix: tsx 默认 keepNames:true，esbuild 会在 page.evaluate 函数体
  //   里注入 __name(...) 调用，浏览器没有该 helper 会抛 ReferenceError。
  //   注入一次 polyfill 到 window 上即可让所有后续 evaluate 正常执行。
  // ─────────────────────────────────────────────────────────────────
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
   * 点击视口内的"查看N条回复"按钮（page.evaluate 定位 + CDP 鼠标点击）
   * 不用 cdpClickByText，因为 performSearch 不支持正则匹配
   * @returns 点击的按钮文本，或 null
   */
  private async clickExpandButton(page: Page): Promise<string | null> {
    await this.injectEsbuildPolyfill(page);
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
        if (rect.width === 0 || rect.height === 0) continue;
        // 如果不在视口内，先 scrollIntoView → 重新获取坐标
        if (rect.top < 0 || rect.bottom > viewportH) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          // scrollIntoView 是同步的，重新获取 rect
          const newRect = el.getBoundingClientRect();
          return { x: Math.round(newRect.left + newRect.width / 2), y: Math.round(newRect.top + newRect.height / 2), text: t };
        }
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), text: t };
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
      const hiddenButtons: Array<{ top: number; bottom: number }> = [];
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (!/^查看\d+条回复$/.test(t) || !(el instanceof HTMLElement)) continue;
        const isLeaf = !Array.from(el.children).some(child =>
          /^查看\d+条回复$/.test((child.textContent || '').trim())
        );
        if (!isLeaf) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > viewportH || rect.top < 0) {
          hiddenButtons.push({ top: Math.round(rect.top), bottom: Math.round(rect.bottom) });
        }
      }
      if (hiddenButtons.length > 0) {
        // 找到最下方的隐藏按钮，计算需要滚动的距离
        const maxBottom = Math.max(...hiddenButtons.map(b => b.bottom));
        const minTop = Math.min(...hiddenButtons.map(b => b.top));
        // 如果按钮在视窗下方，滚动距离 = 按钮底部 - 视窗高度 + 余量
        // 如果按钮在视窗上方（已滚过头），滚动距离 = 按钮顶部 - 余量（负值=向上滚）
        const scrollNeeded = maxBottom > viewportH
          ? maxBottom - viewportH + 150  // 向下滚
          : minTop - 150;                 // 向上滚（负值）
        return { found: true, count: hiddenButtons.length, scrollNeeded };
      }
      return { found: false };
    });

    if (preScrollResult.found && preScrollResult.scrollNeeded) {
      const scrollPx = preScrollResult.scrollNeeded;
      await this.scrollCommentArea(page, scrollPx);
      logger.info({ awemeId, hiddenBtnCount: preScrollResult.count, scrollPx }, '[SmartScroll] Expand buttons outside viewport, scrolled into view');
      await HumanActions.wait(page, 800, 1200);
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
      // 检查所有评论列表 pattern（旧端点 + 新端点）
      for (const pattern of COMMENT_LIST_PATTERNS) {
        const responses = this.interceptor.getResponses(pattern);
        if (responses.length > 0) {
          const latest = responses[responses.length - 1];
          logger.info({ awemeId: '(current)', pattern, responseTime: Date.now() - startTime }, '[Phase3] Comment API response captured');
          return latest;
        }
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
   * 拟人化回复评论（支持一级评论和子评论）
   * 使用用户名+子评论数+评论内容三重匹配定位目标
   *
   * @param target 回复目标（新 ReplyTarget 接口，使用 username+subReplyCount+content 匹配）
   * @param replyText AI 生成的回复内容
   */
  async replyToComment(
    page: Page,
    target: ReplyTarget,
    replyText: string,
    executionId?: string,
  ): Promise<boolean> {
    logger.info({
      text: target.text.slice(0, 30),
      level: target.level,
      username: target.username,
      subReplyCount: target.subReplyCount,
    }, '[Reply] Starting douyin reply (triple-criteria)');

    // ── 调试模式初始化 ──
    const debugEnabled = await isDebugModeEnabled();
    let manifest: DebugManifest | null = null;
    let sessionId = '';
    let stepIdx = 0;

    if (debugEnabled) {
      sessionId = createReplySessionId({
        text: target.text,
        level: target.level,
        createTime: target.createTime ?? 0,
      });
      manifest = createManifest(sessionId, {
        text: target.text,
        level: target.level,
        createTime: target.createTime ?? 0,
        rootText: target.rootText,
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
      // ★ Bugfix: 注入 esbuild __name polyfill（tsx keepNames:true 会在 evaluate 函数体内注入 __name）
      await this.injectEsbuildPolyfill(page);
      await HumanActions.thinkingPause(page, 800, 2000);
      currentPhase = '准备';
      await snap('reply_start');

      // ── 1. 找到目标坐标（来自 scrollExpandAndFindTarget）──
      const foundCoords = await this.scrollExpandAndFindTarget(page, target, snap);
      if (!foundCoords) {
        await snap('target_not_found');
        logger.warn({ text: target.text.slice(0, 40), level: target.level }, '[Reply] Target not found');
        if (manifest) finishManifest(manifest, false);
        return false;
      }

      currentPhase = '定位视频';
      await snap('target_found', { x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) });
      logger.info({ x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) }, '[Reply] Target located, clicking reply');

      // ── 2. hover 触发按钮显示 ──
      await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.mouse.moveTo({ x: foundCoords.x, y: foundCoords.y });
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      });
      await HumanActions.wait(page, 300, 600);
      currentPhase = '执行回复';
      await snap('hover_target', { x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) });

      // ── 3. 点击"回复"按钮（用 page.evaluate 找到距离 foundCoords 最近的文本为"回复"的按钮）──
      const clicked = await page.evaluate(function(coords) {
        var items = document.querySelectorAll('[class*="operations-"] [class*="item-"]');
        var best = null;
        var bestDist = Infinity;
        for (var i = 0; i < items.length; i++) {
          var t = (items[i].textContent || '').trim();
          if (t !== '回复') continue;
          var r = items[i].getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          var cx = r.left + r.width / 2;
          var cy = r.top + r.height / 2;
          var d = Math.hypot(cx - coords.x, cy - coords.y);
          if (d < bestDist) { bestDist = d; best = { x: Math.round(cx), y: Math.round(cy) }; }
        }
        return best;
      }, foundCoords);
      if (!clicked) {
        logger.warn('[Reply] 回复按钮不在视口中');
        // 回退：直接用坐标点击
        await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.mouse.clickAt(foundCoords.x, foundCoords.y);
        });
      } else {
        await snap('click_reply_btn', { x: clicked.x, y: clicked.y });
        await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.mouse.moveTo({ x: clicked.x, y: clicked.y });
          await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
          await ctx.mouse.clickAt(clicked.x, clicked.y);
        });
        logger.info({ x: clicked.x, y: clicked.y }, '[Reply] 点击了回复按钮');
      }

      // ── 4. 立即点击 contenteditable（输入框短暂出现后会消失）──
      await HumanActions.wait(page, 300, 600);
      const btnCoords = clicked || { x: foundCoords.x, y: foundCoords.y };
      let inputClicked = await page.evaluate(function(params: {btnX: number; btnY: number}) {
        function findReplyBtn(): Element | null {
          var items = document.querySelectorAll('[class*="operations-"] [class*="item-"]');
          var best: Element | null = null, bestDist = Infinity;
          for (var i = 0; i < items.length; i++) {
            if ((items[i].textContent || '').trim() !== '回复') continue;
            var r = items[i].getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var d = Math.hypot(cx - params.btnX, cy - params.btnY);
            if (d < bestDist) { bestDist = d; best = items[i]; }
          }
          return best;
        }
        function findFirstAfter(referenceEl: Element, candidates: NodeListOf<Element>): Element | null {
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            var rel = referenceEl.compareDocumentPosition(el);
            // ★ Bugfix: FOLLOWING(4) = other 节点在 reference 之后
            // 之前误用 PRECEDING(2) = other 节点在 reference 之前，导致总是返回根评论 panel
            if (rel & Node.DOCUMENT_POSITION_FOLLOWING) {
              return el;
            }
          }
          return null;
        }

        var replyBtn = findReplyBtn();
        if (replyBtn) {
          // 优先 1：在 reply-content- 容器内找 input（该容器必须在按钮之后）
          var replyContentEls = document.querySelectorAll('[class*="reply-content-"]');
          for (var i = 0; i < replyContentEls.length; i++) {
            var p = replyContentEls[i];
            var r = p.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            var rel = replyBtn.compareDocumentPosition(p);
            // ★ Bugfix: FOLLOWING(4) = p 在 replyBtn 之后（PRECEDING(2) 才是之前）
            if (!(rel & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
            var input = p.querySelector('[class*="input-"][contenteditable="true"]');
            if (input && (input as any).getBoundingClientRect().width > 0) {
              (input as any).focus();
              (input as any).click();
              return true;
            }
          }
          // 优先 2：直接在按钮后找 input
          var allInputs = document.querySelectorAll('div[class*="input-"][contenteditable="true"]');
          var foundInput = findFirstAfter(replyBtn, allInputs);
          if (foundInput) {
            (foundInput as any).focus();
            (foundInput as any).click();
            return true;
          }
        }
        return false;
      }, { btnX: btnCoords.x, btnY: btnCoords.y });
      if (!inputClicked) {
        await HumanActions.wait(page, 500, 1000);
        inputClicked = await page.evaluate(function() {
          var editables = document.querySelectorAll('[contenteditable="true"]');
          for (var i = 0; i < editables.length; i++) {
            var r = editables[i].getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              (editables[i] as any).focus();
              (editables[i] as any).click();
              return true;
            }
          }
          return false;
        });
      }
      if (!inputClicked) {
        logger.error('[Reply] Reply input not found');
        if (manifest) finishManifest(manifest, false);
        return false;
      }
      currentPhase = '输入回复';
      await snap('input_focused');

      // ── 5. 拟人化输入 ──
      await HumanActions.wait(page, 300, 600);
      await HumanActions.safeCDPType(page, replyText);
      await HumanActions.wait(page, 500, 1200);
      await snap('text_typed', { textLength: replyText.length });

      // ── 6. 找到发送按钮（在 reply-content 面板内找 text="发送" 且未 disabled 的 button）──
      let sendBtn = await page.evaluate(function(params: {btnX: number; btnY: number}) {
        function findReplyBtn(): Element | null {
          var items = document.querySelectorAll('[class*="operations-"] [class*="item-"]');
          var best: Element | null = null, bestDist = Infinity;
          for (var i = 0; i < items.length; i++) {
            if ((items[i].textContent || '').trim() !== '回复') continue;
            var r = items[i].getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            var d = Math.hypot(cx - params.btnX, cy - params.btnY);
            if (d < bestDist) { bestDist = d; best = items[i]; }
          }
          return best;
        }

        var replyBtn = findReplyBtn();
        if (!replyBtn) return null;

        var panels = document.querySelectorAll('[class*="reply-content-"]');
        var targetPanel: Element | null = null;
        for (var i = 0; i < panels.length; i++) {
          var p = panels[i];
          var r = p.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          var rel = replyBtn.compareDocumentPosition(p);
          // ★ Bugfix: FOLLOWING(4) = p 在 replyBtn 之后（PRECEDING(2) 才是之前）
          if (!(rel & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          targetPanel = p;
          break;
        }
        if (!targetPanel) return null;

        var btns = targetPanel.querySelectorAll('button');
        for (var j = 0; j < btns.length; j++) {
          var t = (btns[j].textContent || '').trim();
          if (t === '发送' && !(btns[j] as any).disabled) {
            var br = btns[j].getBoundingClientRect();
            return { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) };
          }
        }
        return null;
      }, { btnX: btnCoords.x, btnY: btnCoords.y });

      // ★ 检测并处理客服悬浮窗遮挡发送按钮
      let submitClicked = false;
      if (sendBtn) {
        const isBlockedByService = await page.evaluate(function(coords: {x: number; y: number}) {
          const el = document.elementFromPoint(coords.x, coords.y);
          if (!el) return false;
          let cur: Element | null = el as Element;
          while (cur) {
            const text = (cur.textContent || '').trim();
            const cls = (cur.className || '').toLowerCase();
            if (text.includes('在线客服') || cls.includes('creator-help-bar') || cls.includes('online-service') || cls.includes('service-popup')) {
              return true;
            }
            cur = cur.parentElement;
          }
          return false;
        }, { x: sendBtn.x, y: sendBtn.y });

        if (isBlockedByService) {
          logger.info('[Reply] 客服悬浮窗遮挡了发送按钮，尝试隐藏悬浮窗');

          // ★ 不滚动页面（滚动会导致回复面板失焦、文字丢失）
          // 改为隐藏客服悬浮窗元素
          const hidden = await page.evaluate(function() {
            const selectors = [
              '.creator-help-bar', '.online-service', '.service-popup',
              '[class*="help-bar"]', '[class*="online-service"]', '[class*="service-popup"]',
              '[class*="creator-help"]'
            ];
            let hiddenCount = 0;
            for (const sel of selectors) {
              const els = document.querySelectorAll(sel);
              for (let i = 0; i < els.length; i++) {
                const r = els[i].getBoundingClientRect();
                if (r.width > 0 || r.height > 0) {
                  (els[i] as HTMLElement).style.display = 'none';
                  hiddenCount++;
                }
              }
            }
            // 也尝试隐藏包含"在线客服"文字的浮窗
            const allEls = document.querySelectorAll('div, span, iframe');
            for (let i = 0; i < allEls.length; i++) {
              const el = allEls[i] as HTMLElement;
              if (el.children.length > 3) continue; // 跳过容器
              const text = (el.textContent || '').trim();
              if (text === '在线客服' || text.includes('在线客服')) {
                // 向上找最近的 fixed/absolute 定位的祖先并隐藏
                let cur: Element | null = el;
                while (cur) {
                  const style = window.getComputedStyle(cur);
                  if (style.position === 'fixed' || style.position === 'absolute') {
                    (cur as HTMLElement).style.display = 'none';
                    hiddenCount++;
                    break;
                  }
                  cur = cur.parentElement;
                }
              }
            }
            return hiddenCount;
          });

          if (hidden > 0) {
            logger.info({ hiddenCount: hidden }, '[Reply] 客服悬浮窗已隐藏');
            await HumanActions.wait(page, 300, 600);
          }

          // 重新检查发送按钮是否仍被遮挡
          const stillBlocked = await page.evaluate(function(coords: {x: number; y: number}) {
            const el = document.elementFromPoint(coords.x, coords.y);
            if (!el) return false;
            let cur: Element | null = el as Element;
            while (cur) {
              const text = (cur.textContent || '').trim();
              const cls = (cur.className || '').toLowerCase();
              if (text.includes('在线客服') || cls.includes('creator-help-bar') || cls.includes('online-service') || cls.includes('service-popup')) {
                return true;
              }
              cur = cur.parentElement;
            }
            return false;
          }, { x: sendBtn.x, y: sendBtn.y });

          if (stillBlocked) {
            logger.warn('[Reply] 隐藏后发送按钮仍被遮挡，使用 evaluate 直接点击');
            // 悬浮窗无法隐藏，用 evaluate 直接 click 发送按钮（合理回退）
            const evalClicked = await page.evaluate(function(params: {btnX: number; btnY: number}) {
              function findReplyBtn(): Element | null {
                var items = document.querySelectorAll('[class*="operations-"] [class*="item-"]');
                var best: Element | null = null, bestDist = Infinity;
                for (var i = 0; i < items.length; i++) {
                  if ((items[i].textContent || '').trim() !== '回复') continue;
                  var r = items[i].getBoundingClientRect();
                  if (r.width === 0 || r.height === 0) continue;
                  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                  var d = Math.hypot(cx - params.btnX, cy - params.btnY);
                  if (d < bestDist) { bestDist = d; best = items[i]; }
                }
                return best;
              }
              var replyBtn = findReplyBtn();
              if (!replyBtn) return false;
              var panels = document.querySelectorAll('[class*="reply-content-"]');
              var targetPanel: Element | null = null;
              for (var i = 0; i < panels.length; i++) {
                var p = panels[i];
                var r = p.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                var rel = replyBtn.compareDocumentPosition(p);
                if (!(rel & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
                targetPanel = p;
                break;
              }
              if (!targetPanel) return false;
              var btns = targetPanel.querySelectorAll('button');
              for (var j = 0; j < btns.length; j++) {
                var t = (btns[j].textContent || '').trim();
                if (t === '发送' && !(btns[j] as any).disabled) {
                  (btns[j] as HTMLElement).click();
                  return true;
                }
              }
              return false;
            }, { btnX: btnCoords.x, btnY: btnCoords.y });

            if (evalClicked) {
              logger.info('[Reply] evaluate 直接点击发送按钮成功');
              submitClicked = true;
            } else {
              logger.error('[Reply] 发送按钮被遮挡且 evaluate 点击也失败');
              if (manifest) finishManifest(manifest, false);
              return false;
            }
          }
          // 如果不再被遮挡，sendBtn 坐标仍有效，继续走正常 CDP 点击流程
        }
      }

      if (sendBtn && !submitClicked) {
        await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.mouse.moveTo({ x: sendBtn.x, y: sendBtn.y });
          await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
          await ctx.mouse.clickAt(sendBtn.x, sendBtn.y);
        });
        submitClicked = true;
        logger.info({ x: sendBtn.x, y: sendBtn.y }, '[Reply] 通过坐标点击了发送按钮');
      } else if (!submitClicked) {
        // 回退：用 evaluate 精确匹配文本为"发送"且未 disabled 的按钮
        const fallbackBtn = await page.evaluate(function() {
          var panels = document.querySelectorAll('[class*="reply-content-"]');
          for (var i = 0; i < panels.length; i++) {
            var r = panels[i].getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            var btns = panels[i].querySelectorAll('button');
            for (var j = 0; j < btns.length; j++) {
              var t = (btns[j].textContent || '').trim();
              if (t === '发送' && !(btns[j] as any).disabled) {
                var br = btns[j].getBoundingClientRect();
                if (br.width > 0 && br.height > 0) {
                  return { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) };
                }
              }
            }
          }
          return null;
        });
        if (fallbackBtn) {
          await HumanActions.withCDPContext(page, async (ctx) => {
            await ctx.mouse.moveTo({ x: fallbackBtn.x, y: fallbackBtn.y });
            await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
            await ctx.mouse.clickAt(fallbackBtn.x, fallbackBtn.y);
          });
          submitClicked = true;
          logger.info({ x: fallbackBtn.x, y: fallbackBtn.y }, '[Reply] 通过文本匹配点击了发送按钮');
        }
      }
      if (!submitClicked) logger.warn('[Reply] Submit not found, but text was typed');
      currentPhase = '提交回复';
      await snap('submit_clicked', { clicked: submitClicked });

      // ── 7. 等待 + 验证 ──
      // ★ Bugfix: 之前不检查 URL 变化，页面导航走后仍返回 true（假成功）
      const urlBeforeSubmit = page.url();
      await HumanActions.wait(page, 2000, 4000);
      const urlAfterSubmit = page.url();
      const urlChanged = !urlAfterSubmit.includes('interactive/comment');

      const verifyResult = await page.evaluate(function() {
        // ★ Bugfix: 之前扫 [class*="toast"] 会把"回复成功"的 toast 当 error
        // 现在只扫 error/fail 元素，并排除包含成功关键词的文本
        var SUCCESS_KEYWORDS = ['成功', 'success', '已发送', '已回复'];
        var errorEls = document.querySelectorAll('[class*="error"], [class*="fail"]');
        for (var i = 0; i < errorEls.length; i++) {
          var t = (errorEls[i].textContent || '').trim();
          if (t.length === 0 || t.length >= 100) continue;
          var isSuccess = false;
          for (var k = 0; k < SUCCESS_KEYWORDS.length; k++) {
            if (t.indexOf(SUCCESS_KEYWORDS[k]) >= 0) { isSuccess = true; break; }
          }
          if (!isSuccess) return { error: t };
        }
        var editables = document.querySelectorAll('[contenteditable="true"]');
        for (var j = 0; j < editables.length; j++) {
          var r = editables[j].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { editableText: (editables[j].textContent || '').slice(0, 50) };
          }
        }
        return { editableText: 'none' };
      });
      logger.info({ verifyResult, urlChanged, urlAfterSubmit }, '[Reply] 提交后验证');
      await snap('verify_result', { ...verifyResult, urlChanged, urlAfterSubmit });

      // ★ 验证失败检测
      if (urlChanged) {
        logger.error({ urlBefore: urlBeforeSubmit, urlAfter: urlAfterSubmit }, '[Reply] 提交后页面导航离开，回复失败');
        if (manifest) finishManifest(manifest, false);
        return false;
      }
      if (verifyResult.error) {
        logger.error({ error: verifyResult.error }, '[Reply] 提交后检测到错误提示，回复失败');
        if (manifest) finishManifest(manifest, false);
        return false;
      }
      // 如果输入框仍有文字，说明回复未发送成功
      if (verifyResult.editableText && verifyResult.editableText !== 'none' && verifyResult.editableText.trim().length > 0) {
        logger.error({ editableText: verifyResult.editableText }, '[Reply] 输入框仍有文字，回复可能未发送');
        if (manifest) finishManifest(manifest, false);
        return false;
      }

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
   * 通过用户名+子评论数+评论内容三重匹配，找到目标评论的"回复"按钮坐标。
   *
   * 子评论 (level=2)：先找到匹配 rootUsername+rootSubReplyCount+rootText 的根评论容器 →
   *   展开该容器的子评论 → 按 username+content 匹配目标子评论
   * 一级评论 (level=1)：直接按 username+subReplyCount+text 匹配
   */
  private async scrollExpandAndFindTarget(
    page: Page,
    target: ReplyTarget,
    snap?: (label: string, extra?: Record<string, any>) => Promise<void>,
  ): Promise<{ x: number; y: number } | null> {

    // ── 工具：直接调用已有方法 ──
    await this.scrollCommentArea(page, 'top');
    await HumanActions.wait(page, 500, 800);
    await snap?.('scroll_to_top');

    const MAX_SCROLL = 30;
    const startT0 = Date.now();
    const reader = getSelectorReader();
    const rootContainerSels = reader.getSelectorListWithFallback('douyin', 'regions', 'comment_root_container', [
      'div[class*="container-"]',
    ]);

    logger.info({ text: target.text.slice(0, 30), username: target.username, level: target.level },
      '[Reply::Find] Start (triple-criteria)');

    for (let scrollRound = 0; scrollRound < MAX_SCROLL; scrollRound++) {
      await snap?.('scroll_round_' + (scrollRound + 1));

      // ── A. 在视窗中找根评论（按 rootUsername + subReplyCount + rootText 匹配） ──
      const rootMatch = await this.findRootCommentByUsernameContent(page, target, rootContainerSels);
      if (!rootMatch) {
        const scrolled = await this.tryExpandMoreAndScroll(page, scrollRound);
        if (!scrolled) break;
        continue;
      }

      await snap?.('root_found', { x: rootMatch.x, y: rootMatch.y });
      logger.info({ scrollRound, elapsedMs: Date.now() - startT0 }, '[Reply::Find] Root comment located');

      // ── B. 如果目标就是根评论 → 直接返回该根评论的"回复"按钮坐标 ──
      if (target.level === 1) {
        const replyBtn = await this.findReplyBtnInContainer(page, rootMatch.containerSel);
        if (replyBtn) {
          logger.info({ elapsedMs: Date.now() - startT0 }, '[Reply::Find] Root reply btn located');
          return replyBtn;
        }
        logger.warn('[Reply::Find] Root found but reply btn missing');
        // 回退：返回根评论中心坐标
        return { x: rootMatch.x, y: rootMatch.y };
      }

      // ── C. level=2：展开根评论下的子评论 ──
      if ((target.rootSubReplyCount ?? 0) > 0 && !rootMatch.isExpanded) {
        // ★ Bugfix: 先把 root 评论滚到视口中间，否则 elementFromPoint 会失败
        // （root 可能通过 DOM 扫描找到但 y 坐标在视口外或被遮挡）
        await this.scrollRootIntoView(page, rootMatch.x, rootMatch.y);
        await HumanActions.wait(page, 300, 600);

        const expanded = await this.expandRootRepliesIfNeeded(page, rootMatch);
        if (!expanded) {
          logger.warn('[Reply::Find] Failed to expand sub-replies');
          // 继续滚动找下一个匹配的根评论
          const scrolled = await this.tryExpandMoreAndScroll(page, scrollRound);
          if (!scrolled) break;
          continue;
        }
        await HumanActions.wait(page, 800, 1500);
        await snap?.('expanded_sub_replies');
      }

      // ── D. 在已展开的根评论范围内找子评论（按 username + content 匹配） ──
      for (let attempt = 0; attempt < 5; attempt++) {
        const subMatch = await this.findSubCommentInRoot(page, rootMatch, target);
        if (subMatch) {
          await snap?.('sub_found', { x: subMatch.x, y: subMatch.y });
          logger.info({ elapsedMs: Date.now() - startT0 }, '[Reply::Find] Sub-comment reply btn located');
          return subMatch;
        }
        // 没找到 → 可能需要点"查看N条回复"（10条以上时分页）
        const hasMore = await this.clickRootLoadMoreIfPresent(page, rootMatch);
        if (!hasMore) break;
        await HumanActions.wait(page, 800, 1500);
      }

      logger.info({ scrollRound }, '[Reply::Find] Sub-comment not found under this root, continuing');
      const scrolled = await this.tryExpandMoreAndScroll(page, scrollRound);
      if (!scrolled) break;
    }

    // ── 最终一次全扫（simpleMatch 回退，仅用 username + content） ──
    logger.info({ elapsedMs: Date.now() - startT0 }, '[Reply::Find] Exhaustive, final sweep');
    await this.scrollCommentArea(page, 'top');
    await HumanActions.wait(page, 500, 800);

    const finalSweep = await this.finalSweepByUsernameContent(page, target);
    if (finalSweep) {
      logger.info('[Reply::Find] Final sweep found target');
      return finalSweep;
    }

    logger.info({ elapsedMs: Date.now() - startT0 }, '[Reply::Find] Exhausted, no match');
    return null;
  }

  // ================================================================
  // New helper methods for triple-criteria matching
  // ================================================================

  /**
   * 在视窗内查找匹配 username + subReplyCount + content 的根评论容器。
   * 返回 { x, y, containerSel, isExpanded, subReplyCountInPage } 或 null。
   */
  private async findRootCommentByUsernameContent(
    page: Page,
    target: ReplyTarget,
    containerSels: string[],
  ): Promise<{
    x: number; y: number; containerSel: string;
    isExpanded: boolean; subReplyCountInPage: number;
  } | null> {
    await this.injectEsbuildPolyfill(page);
    // ★ Bugfix: level=2 时用 root* 字段匹配根评论，level=1 时用 target 字段
    const targetUsername = (target.level === 2
      ? (target.rootUsername || '')
      : target.username
    ).trim().toLowerCase();
    const targetText = (target.level === 2
      ? (target.rootText || '')
      : target.text
    ).trim().toLowerCase();
    const targetSubReplyCount = target.level === 2
      ? (target.rootSubReplyCount ?? -1)
      : (target.subReplyCount ?? -1);

    // 日志记录匹配模式以帮助调试
    logger.info({
      level: target.level,
      matching: target.level === 2 ? 'ROOT (using root* fields)' : 'ROOT (using target fields)',
      username: targetUsername,
      text: targetText.slice(0, 20),
      subReplyCount: targetSubReplyCount,
    }, '[FindRoot] Matching criteria');

    return await page.evaluate(function(params) {
      var username = params.username;
      var text = params.text;
      var subReplyCount = params.subReplyCount;
      var sels = params.sels;
      var vh = window.innerHeight;

      // 遍历所有容器选择器
      for (var si = 0; si < sels.length; si++) {
        var containers = document.querySelectorAll(sels[si]);
        for (var ci = 0; ci < containers.length; ci++) {
          var container = containers[ci];
          var containerText = (container.innerText || '').trim();
          if (containerText.length < 3) continue;

          // 提取用户名(去装饰子元素:抖音用户名 div 内常有 <span class="tag-...">作者</span> 等装饰,
          // 直接 textContent 会拼成 "基本 作者",导致严格相等匹配失败)
          function bareUsernameText(el: Element): string {
            if (!el) return '';
            var clone = el.cloneNode(true) as HTMLElement;
            var ch = clone.children;
            for (var i = ch.length - 1; i >= 0; i--) ch[i].remove();
            return (clone.textContent || '').trim().toLowerCase();
          }
          var usernameEl = container.querySelector('[class*="username-"]');
          if (!usernameEl) continue;
          var foundUsername = bareUsernameText(usernameEl);

          // 提取评论文本
          var contentEl = container.querySelector('[class*="comment-content-text"]');
          if (!contentEl) continue;
          var foundContent = (contentEl.textContent || '').trim().toLowerCase();

          // 子评论数提取（纯文本匹配，不依赖 class hash）
          function findLoadMoreInContainer(container: Element) {
            var candidates = container.querySelectorAll('*');
            for (var i = 0; i < candidates.length; i++) {
              var el = candidates[i];
              if (el.children.length > 0) continue;
              var t = (el.textContent || '').trim();
              var m = t.match(/^查看(\d+)条回复$/);
              if (m && m[1]) {
                return { type: 'expand' as const, count: parseInt(m[1], 10), el: el };
              }
              if (t === '收起') {
                return { type: 'collapsed' as const, el: el };
              }
            }
            return null;
          }
          var loadMoreInfo = findLoadMoreInContainer(container);
          var foundSubReplyCount = 0;
          var isExpanded = false;
          if (loadMoreInfo) {
            if (loadMoreInfo.type === 'expand' && loadMoreInfo.count !== undefined) {
              foundSubReplyCount = loadMoreInfo.count;
            } else if (loadMoreInfo.type === 'collapsed') {
              isExpanded = true;
              foundSubReplyCount = -1; // 已展开，从 DB 数据获取
            }
          }

          // 用户名精确匹配
          if (foundUsername !== username) continue;

          // 评论文本模糊匹配（包含关系）
          var textMatch = foundContent.indexOf(text) >= 0 || text.indexOf(foundContent) >= 0;
          if (!textMatch) continue;

          // subReplyCount 检查
          if (subReplyCount >= 0) {
            if (foundSubReplyCount > 0 && foundSubReplyCount !== subReplyCount) continue;
          }

          // 检查容器是否在视口内
          var rect = container.getBoundingClientRect();
          if (rect.top < vh && rect.bottom > 0 && rect.width > 0 && rect.height > 0) {
            // 用容器选择器的 nth-child 方式作为唯一标识
            var containerSel = sels[si] + ':nth-child(' + (ci + 1) + ')';

            if (foundSubReplyCount < 0 && isExpanded) {
              foundSubReplyCount = subReplyCount >= 0 ? subReplyCount : 0;
            }

            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              containerSel: containerSel,
              isExpanded: isExpanded,
              subReplyCountInPage: foundSubReplyCount >= 0 ? foundSubReplyCount : 0,
            };
          }
        }
      }
      return null;
    }, {
      username: targetUsername,
      text: targetText,
      subReplyCount: targetSubReplyCount,
      sels: containerSels,
    });
  }

  /**
   * 在指定容器内找"回复"按钮的坐标。
   */
  private async findReplyBtnInContainer(
    page: Page,
    containerSel: string,
  ): Promise<{ x: number; y: number } | null> {
    await this.injectEsbuildPolyfill(page);
    return await page.evaluate(function(sel) {
      var container = document.querySelector(sel);
      if (!container) return null;
      var vh = window.innerHeight;
      var opsAreas = container.querySelectorAll('[class*="operations-"]');
      for (var oi = 0; oi < opsAreas.length; oi++) {
        var items = opsAreas[oi].querySelectorAll('[class*="item-"]');
        for (var ri = 0; ri < items.length; ri++) {
          if ((items[ri].textContent || '').trim() === '回复') {
            var r = items[ri].getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.top < vh) {
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
        }
      }
      return null;
    }, containerSel);
  }

  /**
   * 将 root 评论滚动到视口中间，确保 elementFromPoint 能正确定位。
   * 通过在 DOM 中重新匹配 root 文本内容，找到元素并 scrollIntoView。
   */
  private async scrollRootIntoView(page: Page, targetX: number, targetY: number): Promise<void> {
    await this.injectEsbuildPolyfill(page);
    const scrolled = await page.evaluate(function(coords: { x: number; y: number }) {
      // 方案 1：elementFromPoint 直接定位（如果 root 在视口内）
      var el = document.elementFromPoint(coords.x, coords.y);
      if (el) {
        var container = el.closest('div[class*="container-"]');
        if (container) {
          (container as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }
      // 方案 2：用坐标找到最近的 container（可能在视口外，elementFromPoint 返回 null）
      var containers = document.querySelectorAll('div[class*="container-"]');
      var best: Element | null = null;
      var bestDist = Infinity;
      for (var i = 0; i < containers.length; i++) {
        var r = containers[i].getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        var d = Math.hypot(cx - coords.x, cy - coords.y);
        if (d < bestDist) { bestDist = d; best = containers[i]; }
      }
      if (best) {
        (best as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      }
      return false;
    }, { x: targetX, y: targetY });
    if (scrolled) {
      logger.info({ x: targetX, y: targetY }, '[Reply::Find] Root scrolled into view');
    }
  }

  /**
   * 展开根评论的子回复（如果还没展开），已展开则直接返回 true。
   */
  private async expandRootRepliesIfNeeded(
    page: Page,
    root: {
      x: number; y: number; containerSel: string;
      subReplyCountInPage: number;
    },
  ): Promise<boolean> {
    await this.injectEsbuildPolyfill(page);
    // ★ Bugfix 改进:不再依赖 rootMatch.containerSel(:nth-child(N) 拼出来的脆弱 selector)，
    // 改用 rootX, rootY 定位根评论 wrapper:document.elementFromPoint 找根评论内子元素,
    // closest('div[class*="container-"]') 向上找根评论 wrapper。后续所有"查看N条回复"按钮查找
    // 都在该 wrapper 内,避免误点其他根评论的展开按钮。
    const rootInfo = await page.evaluate(function(params: { px: number; py: number }) {
      var px = params.px, py = params.py;
      // 多次尝试 elementFromPoint(它对 hover/popover 敏感)
      var el: Element | null = null;
      for (var dx = -2; dx <= 2 && !el; dx += 2) {
        for (var dy = -2; dy <= 2 && !el; dy += 2) {
          var e = document.elementFromPoint(px + dx, py + dy);
          if (e) { el = e; break; }
        }
      }
      if (!el) return null;
      // 向上找最近的 div[class*="container-"] 祖先
      var w: Element | null = el;
      while (w && w !== document.body) {
        if (w.tagName === 'DIV' && w.className && w.className.indexOf('container-') >= 0) {
          var r = w.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return {
              rect: { x: r.left, y: r.top, w: r.width, h: r.height },
              // 找该 wrapper 内的 load-more 按钮
              loadMoreText: (function () {
                var candidates = w!.querySelectorAll('*');
                for (var i = 0; i < candidates.length; i++) {
                  var ce = candidates[i];
                  if (!(ce instanceof HTMLElement)) continue;
                  var t = (ce.textContent || '').trim();
                  var isExpand = /^查看\d+条回复$/.test(t);
                  var isCollapse = t === '收起';
                  if (!isExpand && !isCollapse) continue;
                  var hasMatchingChild = Array.prototype.some.call(ce.children, function (child) {
                    var ct = (child.textContent || '').trim();
                    return /^查看\d+条回复$/.test(ct) || ct === '收起';
                  });
                  if (hasMatchingChild) continue;
                  var cr = ce.getBoundingClientRect();
                  if (cr.width === 0 || cr.height === 0) continue;
                  return {
                    type: isExpand ? 'expand' : 'collapsed',
                    x: Math.round(cr.left + cr.width / 2),
                    y: Math.round(cr.top + cr.height / 2),
                  };
                }
                return null;
              })(),
            };
          }
        }
        w = w.parentElement;
      }
      return null;
    }, { px: root.x, py: root.y });

    if (!rootInfo) {
      logger.warn({ x: root.x, y: root.y }, '[Expand] root wrapper not found via elementFromPoint');
      return false;
    }

    if (!rootInfo.loadMoreText) {
      logger.info('[Expand] No expand button needed');
      return true;
    }

    // 滚到根评论视口内,确保按钮可见
    await page.evaluate(function(rect: { x: number; y: number; w: number; h: number }) {
      var target = document.elementFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2);
      var w: Element | null = target;
      while (w && w !== document.body) {
        if (w.tagName === 'DIV' && w.className && w.className.indexOf('container-') >= 0) {
          w.scrollIntoView({ behavior: 'instant', block: 'end' });
          return;
        }
        w = w.parentElement;
      }
    }, rootInfo.rect);
    await HumanActions.wait(page, 200, 400);

    // hover 根评论
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.mouse.moveTo({ x: rootInfo.rect.x + rootInfo.rect.w / 2, y: rootInfo.rect.y + rootInfo.rect.h / 2 });
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
    });

    if (rootInfo.loadMoreText.type === 'expand') {
      await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.mouse.moveTo({ x: rootInfo.loadMoreText!.x, y: rootInfo.loadMoreText!.y });
        await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
        await ctx.mouse.clickAt(rootInfo.loadMoreText!.x, rootInfo.loadMoreText!.y);
      });
      logger.info({ x: rootInfo.loadMoreText.x, y: rootInfo.loadMoreText.y }, '[Expand] Clicked expand button (root-wrapper-anchored)');
      return true;
    }

    // 已是"收起"状态(已展开)
    return true;
  }

  /**
   * 在已展开的根评论范围内找目标子评论（username + content 匹配），
   * 返回该子评论的"回复"按钮坐标。
   */
  private async findSubCommentInRoot(
    page: Page,
    root: { containerSel: string; isExpanded: boolean; x: number; y: number },
    target: ReplyTarget,
  ): Promise<{ x: number; y: number } | null> {
    await this.injectEsbuildPolyfill(page);
    const targetUsername = target.username.trim().toLowerCase();
    const targetText = target.text.trim().toLowerCase();

    return await page.evaluate(function(params) {
      var username = params.username;
      var text = params.text;
      var rx = params.rx;
      var ry = params.ry;
      var vh = window.innerHeight;

      // 去装饰子元素,取 username 元素的纯文本(排除 <span class="tag-...">作者</span> 等)
      function bareUsernameText(el: Element): string {
        if (!el) return '';
        var clone = el.cloneNode(true) as HTMLElement;
        var ch = clone.children;
        for (var i = ch.length - 1; i >= 0; i--) ch[i].remove();
        return (clone.textContent || '').trim().toLowerCase();
      }

      // ★ 用 rootX, rootY 定位根评论 wrapper,避免依赖 :nth-child(N) 拼接的脆弱 selector
      var rootEl: Element | null = null;
      for (var dx = -2; dx <= 2 && !rootEl; dx += 2) {
        for (var dy = -2; dy <= 2 && !rootEl; dy += 2) {
          var e = document.elementFromPoint(rx + dx, ry + dy);
          if (!e) continue;
          var w: Element | null = e;
          while (w && w !== document.body) {
            if (w.tagName === 'DIV' && w.className && w.className.indexOf('container-') >= 0) {
              var r = w.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { rootEl = w; break; }
            }
            w = w.parentElement;
          }
        }
      }
      if (!rootEl) return null;

      // 在 rootEl 的**所有后代**中找目标子评论
      var commentTexts = rootEl.querySelectorAll('[class*="comment-content-text"]');
      for (var i = 0; i < commentTexts.length; i++) {
        var el = commentTexts[i];
        var foundContent = (el.textContent || '').trim().toLowerCase();
        // ★ 严格相等匹配(不双向 includes):避免 lqq 回复"基本"时撞到那条作者回复
        if (foundContent !== text) continue;

        // 向上找到该子评论的 wrapper(同时含 username + operations 的最小祖先)
        var wrapper = el.parentElement;
        var maxDepth = 10;
        while (wrapper && maxDepth > 0) {
          maxDepth--;
          var hasU = wrapper.querySelector('[class*="username-"]');
          var hasO = wrapper.querySelector('[class*="operations-"]');
          if (hasU && hasO) break;
          wrapper = wrapper.parentElement;
        }
        if (!wrapper) continue;

        // 验证 wrapper 内 username == 目标用户名
        var uEl = wrapper.querySelector('[class*="username-"]');
        if (!uEl) continue;
        if (bareUsernameText(uEl) !== username) continue;

        // 找"回复"按钮
        var opsArea = wrapper.querySelector('[class*="operations-"]');
        if (opsArea) {
          var items = opsArea.querySelectorAll('[class*="item-"]');
          for (var ri = 0; ri < items.length; ri++) {
            if ((items[ri].textContent || '').trim() === '回复') {
              var r = items[ri].getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.top < vh) {
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
            }
          }
        }
        var wr = wrapper.getBoundingClientRect();
        return { x: Math.round(wr.left + wr.width / 2), y: Math.round(wr.top + wr.height / 2) };
      }
      return null;
    }, {
      username: targetUsername,
      text: targetText,
      rx: root.x,
      ry: root.y,
    });
  }

  /**
   * 在根评论范围内点"查看N条回复"（子评论 >10 条时的分页），无则返回 false。
   */
  private async clickRootLoadMoreIfPresent(
    page: Page,
    root: { containerSel: string; x: number; y: number },
  ): Promise<boolean> {
    await this.injectEsbuildPolyfill(page);
    // ★ 与 expandRootRepliesIfNeeded 对齐:用 rootX, rootY 定位根评论 wrapper,
    // 避免 :nth-child(N) 拼出的脆弱 selector
    const btnPos = await page.evaluate(function(params: { rx: number; ry: number }) {
      var rx = params.rx, ry = params.ry;
      // 找根评论 wrapper
      var rootEl: Element | null = null;
      for (var dx = -2; dx <= 2 && !rootEl; dx += 2) {
        for (var dy = -2; dy <= 2 && !rootEl; dy += 2) {
          var e = document.elementFromPoint(rx + dx, ry + dy);
          if (!e) continue;
          var w: Element | null = e;
          while (w && w !== document.body) {
            if (w.tagName === 'DIV' && w.className && w.className.indexOf('container-') >= 0) {
              var r = w.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { rootEl = w; break; }
            }
            w = w.parentElement;
          }
        }
      }
      if (!rootEl) return null;
      // 在 wrapper 内找"查看N条回复"按钮(leaf 判定)
      var candidates = rootEl.querySelectorAll('*');
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!(el instanceof HTMLElement)) continue;
        var t = (el.textContent || '').trim();
        if (!/^查看\d+条回复$/.test(t)) continue;
        var hasMatchingChild = Array.prototype.some.call(el.children, function (child) {
          var ct = (child.textContent || '').trim();
          return /^查看\d+条回复$/.test(ct);
        });
        if (hasMatchingChild) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    }, { rx: root.x, ry: root.y });

    if (!btnPos) return false;

    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.mouse.moveTo({ x: btnPos.x, y: btnPos.y });
      await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
      await ctx.mouse.clickAt(btnPos.x, btnPos.y);
    });

    logger.info({ x: btnPos.x, y: btnPos.y }, '[LoadMore] Clicked load-more in root');
    return true;
  }

  /**
   * 先尝试点击"展开更多评论"按钮，再滚一轮；返回是否应继续。
   */
  private async tryExpandMoreAndScroll(page: Page, scrollRound: number): Promise<boolean> {
    await this.injectEsbuildPolyfill(page);
    // 每 3 轮诊断一次容器状态
    if (scrollRound % 3 === 0) {
      const expandMoreClicked = await page.evaluate(function() {
        var btns = document.querySelectorAll('span, div, button, a');
        for (var i = 0; i < btns.length; i++) {
          var t = (btns[i].textContent || '').trim();
          if (t === '展开更多评论' || t === '展开更多' || t === '查看更多评论') {
            var rect = btns[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              btns[i].click();
              return true;
            }
          }
        }
        return false;
      });
      if (expandMoreClicked) {
        logger.info({ scrollRound: scrollRound + 1 }, '[Reply::Find] Clicked "展开更多评论"');
        await HumanActions.wait(page, 1500, 2500);
        return true;
      }
    }

    // ── 滚动加载更多 ──
    const sh = await page.evaluate(function() {
      var c = document.querySelector('.douyin-creator-interactive-tabs-content');
      return c ? { sh: c.scrollHeight, st: c.scrollTop, ch: c.clientHeight } : null;
    });
    if (!sh) {
      logger.warn('[Reply::Find] Container gone, stopping');
      return false;
    }

    if (sh.st + sh.ch >= sh.sh - 10) {
      logger.info({ scrollRound: scrollRound + 1 }, '[Reply::Find] Bottom reached');
      return false;
    }

    await this.scrollCommentArea(page, sh.ch * 0.6);
    await HumanActions.wait(page, 1000, 1500);
    return true;
  }

  /**
   * 最终全扫回退：无视 container 结构，全文搜索 username+content 匹配的回复按钮。
   */
  private async finalSweepByUsernameContent(
    page: Page,
    target: ReplyTarget,
  ): Promise<{ x: number; y: number } | null> {
    await this.injectEsbuildPolyfill(page);
    const targetUsername = target.username.trim().toLowerCase();
    const targetText = target.text.trim().toLowerCase();

    return await page.evaluate(function(params) {
      var username = params.username;
      var text = params.text;
      var vh = window.innerHeight;

      // 扫所有 comment-content-text 元素
      var textEls = document.querySelectorAll('[class*="comment-content-text"], [class*="comment-content-text-"]');
      for (var i = 0; i < textEls.length; i++) {
        var el = textEls[i];
        var content = (el.textContent || '').trim().toLowerCase();
        if (content.indexOf(text) < 0 && text.indexOf(content) < 0) continue;

        // 向上找 username 确认(去装饰子元素)
        function bareUsernameText(el: Element): string {
          if (!el) return '';
          var clone = el.cloneNode(true) as HTMLElement;
          var ch = clone.children;
          for (var i = ch.length - 1; i >= 0; i--) ch[i].remove();
          return (clone.textContent || '').trim().toLowerCase();
        }
        var parent = el.parentElement;
        var foundUsername = '';
        for (var depth = 0; depth < 8 && parent; depth++) {
          var uEl = parent.querySelector('[class*="username-"]');
          if (uEl) {
            foundUsername = bareUsernameText(uEl);
            break;
          }
          parent = parent.parentElement;
        }
        if (!foundUsername || foundUsername !== username) continue;

        // 找回复按钮
        parent = el.parentElement;
        for (var d2 = 0; d2 < 8 && parent; d2++) {
          var ops = parent.querySelector('[class*="operations-"]');
          if (ops) {
            var items = ops.querySelectorAll('[class*="item-"]');
            for (var ri = 0; ri < items.length; ri++) {
              if ((items[ri].textContent || '').trim() === '回复') {
                var r = items[ri].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                }
              }
            }
          }
          parent = parent.parentElement;
        }

        // 回退：返回元素中心
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        var er = el.getBoundingClientRect();
        return { x: Math.round(er.left + er.width / 2), y: Math.round(er.top + er.height / 2) };
      }
      return null;
    }, {
      username: targetUsername,
      text: targetText,
    });
  }
}
