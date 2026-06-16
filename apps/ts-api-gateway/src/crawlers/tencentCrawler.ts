import { Page } from 'patchright';
import { RequestInterceptor, HumanActions } from '@social-media/browser-core';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('crawler:tencent');

// ── 类型定义（基于实际 API 响应结构，字段均为 camelCase）──

export type TencentVideoInfo = {
  exportId: string;          // 视频唯一ID，格式 "export/UzFfBgAA..."
  objectId: string;          // 与 exportId 相同
  desc: {
    description: string;     // 视频描述（嵌套在 desc 对象中）
    mediaType: number;
    media?: any[];
    location?: any;
  };
  createTime: number;        // 发布时间戳（秒）
  readCount: number;         // 播放量
  likeCount: number;         // 点赞数
  commentCount: number;      // 评论数 ★ 核心字段
  forwardCount: number;      // 分享/转发数
  favCount: number;          // 推荐/收藏数（视频号特有）
  commentClose?: number;     // 评论是否关闭
  visibleType?: number;
  status?: number;
  flag?: number;
};

export type TencentCommentInfo = {
  commentId: string;            // 评论ID
  commentContent: string;       // 评论内容
  commentNickname: string;      // 用户昵称
  commentHeadurl: string;       // 头像URL
  commentCreatetime: string;    // 创建时间戳（字符串类型）
  commentLikeCount: number;     // 点赞数
  levelTwoComment: TencentCommentInfo[];  // 子回复（内嵌，无需单独 API）
  replyCommentId?: string;      // 被回复的评论ID（子回复才有）
  replyContent?: string;        // 被回复的内容（子回复才有）
  replyNickname?: string;       // 被回复者昵称（子回复才有）
  exportId: string;             // 所属视频ID（本地注入）
  level: 1 | 2;                 // 1=一级评论, 2=子回复
  readFlag?: boolean;
  likeFlag?: number;
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

const POST_LIST_PATTERN = '/mmfinderassistant-bin/post/post_list';
const COMMENT_LIST_PATTERN = '/mmfinderassistant-bin/comment/comment_list';
// 注：子回复不需要单独 API，已内嵌在 comment_list 的 levelTwoComment 数组中
// 评论回复 API（暂未使用，留作参考）: /mmfinderassistant-bin/comment/create_comment

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
   * 检测登录状态 — 简化逻辑
   * 只看 URL：在 /platform 页面就是登录有效，在 /login 就是需要扫码
   * 能采集数据 = 登录有效，不依赖页面文本内容判断
   */
  async handleLogin(page: Page, userId: number): Promise<boolean> {
    logger.info('[Login] Checking login status');

    const currentUrl = page.url();

    // 在登录页 → 需要扫码
    if (currentUrl.includes('/login')) {
      logger.info({ currentUrl }, '[Login] On login page, need QR scan');
      return await this.handleQRLogin(page, userId);
    }

    // 在平台页面 → 登录有效
    if (currentUrl.includes('/platform')) {
      logger.info({ currentUrl }, '[Login] On platform page, session valid');
      return true;
    }

    // 不在平台页也不在登录页 → 导航到首页检查
    logger.info({ currentUrl }, '[Login] Navigating to home to check status');
    await page.goto(TENCENT_HOME, { waitUntil: 'domcontentloaded' });
    await HumanActions.wait(page, 3000, 5000);

    const url = page.url();
    if (url.includes('/platform') && !url.includes('/login')) {
      logger.info('[Login] Session valid after navigation');
      return true;
    }

    // 被重定向到登录页
    logger.info('[Login] Redirected to login page, need QR scan');
    return await this.handleQRLogin(page, userId);
  }

  /**
   * 处理二维码登录流程
   */
  private async handleQRLogin(page: Page, userId: number): Promise<boolean> {
    const { botManager } = await import('../services/wechatBotService');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { wechatUserid: true } });

    if (user?.wechatUserid) {
      await this.captureAndSendQR(page, userId, 'tencent', user.wechatUserid, botManager);
    }

    const maxWait = 120_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const checkUrl = page.url();
      if (checkUrl.includes('/platform') && !checkUrl.includes('/login')) {
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
    await this.clickHomeMenu(page);

    if (page.url().includes('/login')) {
      throw new Error('SESSION_EXPIRED');
    }
  }

  /**
   * 点击侧边栏「首页」菜单项，替代 page.goto(TENCENT_HOME)
   * 避免直接 URL 跳转触发风控
   */
  private async clickHomeMenu(page: Page): Promise<void> {
    logger.info('[Home] 点击首页菜单');
    // 在侧边栏范围内点击首页，避免全局搜索误判
    const clicked = await page.evaluate(() => {
      const sidebar = document.querySelector('#side-bar');
      if (!sidebar) return false;
      const links = sidebar.querySelectorAll('a');
      for (const link of links) {
        const nameSpan = link.querySelector('.finder-ui-desktop-menu__name span span');
        if (nameSpan?.textContent?.trim() === '首页') {
          (link as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!clicked) {
      // 回退：全局文本搜索
      await HumanActions.cdpClickByText(page, '首页', { timeout: 5000 });
    }
    await HumanActions.wait(page, 2000, 3000);
    await HumanActions.pageLoadBehavior(page);
  }

  /**
   * 展开侧边栏一级菜单
   * DOM: <li class="finder-ui-desktop-menu__sub__wrp">
   *   <a class="... finder-ui-desktop-menu__sub__link"> 包含菜单文字
   * 展开后: <a class="... finder-ui-desktop-menu__sub-unfold">
   */
  private async expandMenu(page: Page, menuText: string): Promise<void> {
    logger.info({ menu: menuText }, '[Menu] Expanding menu');

    // 先检查是否已展开（子菜单是否可见）
    const alreadyOpen = await this.isMenuExpanded(page, menuText);
    if (alreadyOpen) {
      logger.info({ menu: menuText }, '[Menu] 已展开，跳过');
      return;
    }

    // 多次尝试点击展开
    for (let attempt = 0; attempt < 3; attempt++) {
      // 在侧边栏范围内查找菜单项（避免全局搜索）
      const menuPos = await page.evaluate((text: string) => {
        const sidebar = document.querySelector('#side-bar');
        if (!sidebar) return null;
        const els = sidebar.querySelectorAll('.finder-ui-desktop-menu__sub__wrp .finder-ui-desktop-menu__name span');
        for (const el of els) {
          if (el.textContent?.trim() === text) {
            const rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight };
          }
        }
        return null;
      }, menuText);

      if (menuPos && !menuPos.inViewport) {
        // 菜单不在视口，滚动侧边栏
        await page.evaluate((y: number) => {
          const sidebar = document.querySelector('#side-bar .finder-ui-desktop-menu__container') || document.querySelector('#side-bar');
          if (sidebar) {
            (sidebar as HTMLElement).scrollBy({ top: y - 200, behavior: 'smooth' });
          }
        }, menuPos.y);
        await HumanActions.wait(page, 500, 1000);
      }

      // 点击菜单项（在侧边栏范围内查找并点击 <a> 标签）
      const clicked = await page.evaluate((text: string) => {
        const sidebar = document.querySelector('#side-bar');
        if (!sidebar) return false;
        const els = sidebar.querySelectorAll('.finder-ui-desktop-menu__sub__wrp .finder-ui-desktop-menu__name span');
        for (const el of els) {
          if (el.textContent?.trim() === text) {
            const link = el.closest('a');
            if (link) {
              (link as HTMLElement).click();
              return true;
            }
          }
        }
        return false;
      }, menuText);

      logger.info({ menu: menuText, clicked, attempt }, '[Menu] Click result');
      await HumanActions.wait(page, 1000, 2000);

      // 验证展开
      const expanded = await this.isMenuExpanded(page, menuText);
      logger.info({ menu: menuText, expanded, attempt }, '[Menu] 展开状态');
      if (expanded) return;
    }
  }

  /**
   * 检查一级菜单是否已展开（子菜单可见）
   * 检查 .finder-ui-desktop-sub-menu 的 display 属性
   */
  private async isMenuExpanded(page: Page, menuText: string): Promise<boolean> {
    const isExpanded = await page.evaluate((text: string) => {
      const sidebar = document.querySelector('#side-bar');
      if (!sidebar) return false;
      const els = sidebar.querySelectorAll('.finder-ui-desktop-menu__sub__wrp .finder-ui-desktop-menu__name span');
      for (const el of els) {
        if (el.textContent?.trim() === text) {
          const parentLi = el.closest('.finder-ui-desktop-menu__sub__wrp');
          if (!parentLi) continue;
          const subMenu = parentLi.querySelector('.finder-ui-desktop-sub-menu');
          if (!subMenu) continue;
          const style = (subMenu as HTMLElement).style;
          return style.display !== 'none';
        }
      }
      return false;
    }, menuText);
    return isExpanded;
  }

  /**
   * 在侧边栏范围内点击子菜单项
   * 使用 page.evaluate 直接在 DOM 中查找并点击，避免全局搜索误判
   * 只在 #side-bar 范围内的展开的 .finder-ui-desktop-sub-menu 中查找
   */
  private async clickInlineSubMenuItem(page: Page, itemText: string): Promise<boolean> {
    logger.info({ text: itemText }, '[Menu] Clicking inline submenu item (sidebar scoped)');

    // 多次尝试（可能需要先滚动侧边栏使目标项可见）
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await page.evaluate((text: string) => {
        // 只在侧边栏 #side-bar 中查找
        const sidebar = document.querySelector('#side-bar');
        if (!sidebar) return { success: false, reason: 'sidebar_not_found' };

        // 在侧边栏中找到所有展开的子菜单容器 (style 不是 display:none)
        const subMenus = sidebar.querySelectorAll('.finder-ui-desktop-sub-menu');
        for (const subMenu of subMenus) {
          const style = (subMenu as HTMLElement).style;
          if (style.display === 'none') continue; // 跳过折叠的子菜单

          // 在展开的子菜单中查找目标文本
          const items = subMenu.querySelectorAll('.finder-ui-desktop-sub-menu__item');
          for (const item of items) {
            const nameSpan = item.querySelector('.finder-ui-desktop-menu__name span');
            if (!nameSpan) continue;
            if (nameSpan.textContent?.trim() !== text) continue;

            // 找到了，检查是否在视口内
            const rect = item.getBoundingClientRect();
            const inViewport = rect.top >= 0 && rect.bottom <= window.innerHeight;

            if (!inViewport) {
              // 需要滚动侧边栏使目标项可见
              const container = sidebar.querySelector('.finder-ui-desktop-menu__container') || sidebar;
              const containerRect = container.getBoundingClientRect();
              const scrollOffset = rect.top - containerRect.top - containerRect.height / 3;
              (container as HTMLElement).scrollBy({ top: scrollOffset, behavior: 'smooth' });
              return { success: false, reason: 'scrolled', scrollOffset };
            }

            // 在视口内，点击 <a> 标签
            const link = item.querySelector('a');
            if (link) {
              (link as HTMLElement).click();
              return { success: true, reason: 'clicked' };
            }
          }
        }
        return { success: false, reason: 'not_found' };
      }, itemText);

      logger.info({ text: itemText, attempt, result: JSON.stringify(result) }, '[Menu] clickInlineSubMenuItem result');

      if (result.success) {
        await HumanActions.wait(page, 500, 1000);
        return true;
      }

      if (result.reason === 'scrolled') {
        // 等待滚动完成后重试
        await HumanActions.wait(page, 600, 1000);
        continue;
      }

      if (result.reason === 'not_found') {
        logger.warn({ text: itemText, attempt }, '[Menu] Item not found in any expanded submenu');
        break;
      }
    }

    logger.warn({ text: itemText }, '[Menu] 子菜单点击失败');
    return false;
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
      const isPostList = pattern === POST_LIST_PATTERN;
      this.interceptor.setValidationConfig(pattern, {
        expectedPageUrls: ['channels.weixin.qq.com'],
        requiredItemFields: isPostList ? ['exportId'] : ['commentId'],
        minItems: isPostList ? 1 : 0,
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

  /**
   * 通过菜单导航到视频列表页
   * 注意：视频号助手是 wujie 微前端，点击菜单后主 URL 不变（始终是 /platform），
   * 内容在 shadow DOM 内切换。成功判定基于拦截器是否捕获到 post_list API 数据。
   */
  async navigateToVideoList(page: Page): Promise<void> {
    const currentUrl = page.url();
    logger.info({ currentUrl }, '[Phase1] navigateToVideoList - current URL');

    // 继承当前页面状态 — 只要还在 /platform 下，直接从当前页通过菜单导航
    if (!currentUrl.includes('/platform')) {
      logger.info('[Phase1] Not on platform page, clicking home menu first');
      await this.clickHomeMenu(page);
    }

    // 展开「内容管理」菜单
    logger.info('[Phase1] Expanding 内容管理 from current page');
    await this.expandMenu(page, '内容管理');

    // 点击「视频」子菜单（限定在 .finder-ui-desktop-sub-menu 范围内）
    const videoClicked = await this.clickInlineSubMenuItem(page, '视频');
    if (videoClicked) {
      logger.info('[Phase1] 视频菜单已点击，等待页面加载');
      await HumanActions.wait(page, 3000, 5000);
      await HumanActions.pageLoadBehavior(page);
      return;
    }

    // 回退: 通过数据中心子菜单
    logger.warn('[Phase1] Content menu failed, trying data center submenu');
    await this.expandMenu(page, '数据中心');
    const dataClicked = await this.clickInlineSubMenuItem(page, '视频数据');
    if (dataClicked) {
      logger.info('[Phase1] 视频数据菜单已点击，等待页面加载');
      await HumanActions.wait(page, 3000, 5000);
      await HumanActions.pageLoadBehavior(page);
      return;
    }

    logger.error('[Phase1] All menu navigation attempts failed');
    throw new Error('无法通过菜单导航到视频列表页，所有尝试均失败');
  }

  async checkForUpdates(page: Page, userId: number): Promise<CheckResult> {
    logger.info({ userId }, '[Phase1] Starting update check');

    // 风控检测
    const riskCheck = await this.detectRiskControl(page);
    if (riskCheck.detected) {
      return {
        hasUpdate: false,
        commentsQueue: [],
        updatedVideos: [],
        riskControlDetected: true,
        riskControlInfo: riskCheck,
      };
    }

    // 如果已经在视频列表页，先导航到其他页面（如首页），再导航回来，确保触发 API 请求
    const currentUrl = page.url();
    if (currentUrl.includes('/post/list')) {
      logger.info('[Phase1] Already on video list page, navigating away first to trigger API on return');
      await this.clickHomeMenu(page);
    }

    // 注册 API 监听（必须在导航前注册，以便拦截页面加载时的 API 请求）
    await this.registerListener(page, [POST_LIST_PATTERN]);

    // 通过菜单导航到视频列表（不直接跳转 URL，避免风控）
    await this.navigateToVideoList(page);

    // 等待 API 响应（菜单导航后页面会自动加载数据，无需手动刷新）
    await HumanActions.wait(page, 3000, 5000);

    // 获取拦截到的视频列表
    // 响应结构: { errCode, errMsg, data: { list: [...], totalCount, continueFlag, lastBuff } }
    const intercepted = await this.interceptor.waitForResponse(POST_LIST_PATTERN, 15000);
    const videos: TencentVideoInfo[] = intercepted?.body?.data?.list || [];

    logger.info({ userId, videoCount: videos.length, intercepted: !!intercepted }, '[Phase1] Videos fetched');

    // 检测会话失效：拦截器超时或返回空列表，且之前有视频记录
    if (videos.length === 0) {
      const dbVideosForCheck = await db.getVideosByUserId(userId);
      if (dbVideosForCheck.length > 0 || !intercepted) {
        // 之前有视频但现在返回 0，或拦截器完全没捕获到响应 —— 可能是会话过期
        logger.warn({ userId, dbVideoCount: dbVideosForCheck.length, intercepted: !!intercepted }, '[Phase1] Possible session expired — no API data captured');
        // 检查页面内容
        const bodyText = await HumanActions.cdpGetBodyText(page);
        if (bodyText.includes('登录') || bodyText.includes('已过期') || bodyText.includes('已退出')
          || bodyText.includes('二维码') || bodyText.includes('javascript enabled')) {
          logger.error('[Phase1] Session expired detected from page content');
          // 强制导航到 platform 首页触发登录重定向
          await page.goto('https://channels.weixin.qq.com/platform', { waitUntil: 'domcontentloaded' });
          await HumanActions.wait(page, 3000, 5000);
          this.unregisterListener();
          return {
            hasUpdate: false,
            commentsQueue: [],
            updatedVideos: [],
            riskControlDetected: true,
            riskControlInfo: { detected: true, type: 'session_expired', evidence: 'Page shows login/expired content' },
          };
        }
      }
    }

    // 对比数据库中的评论数
    const dbVideos = await db.getVideosByUserId(userId);
    const commentsQueue: CommentQueueItem[] = [];

    for (const video of videos.slice(0, this.maxMonitorVideos)) {
      // 跳过评论已关闭的视频
      if (video.commentClose === 1) {
        logger.debug({ exportId: video.exportId }, '[Phase1] Skipping video with comments closed');
        continue;
      }

      const dbVideo = dbVideos.find(v => v.id === video.exportId);
      const newCount = video.commentCount ?? 0;

      if (!dbVideo) {
        // 新视频
        if (newCount > 0) {
          commentsQueue.push({
            exportId: video.exportId,
            description: video.desc?.description || '',
            oldCount: 0,
            newCount,
            isFirstCrawl: true,
            _userId: userId,
          });
        }
        continue;
      }

      if (newCount > dbVideo.commentCount) {
        commentsQueue.push({
          exportId: video.exportId,
          description: video.desc?.description || '',
          oldCount: dbVideo.commentCount,
          newCount,
          isFirstCrawl: false,
          _userId: userId,
        });
      }
    }

    // 保存视频到数据库
    const videoInfos = videos.slice(0, this.maxMonitorVideos).map(v => ({
      aweme_id: v.exportId,
      description: v.desc?.description || '',
      create_time: v.createTime,
      comment_count: v.commentCount ?? 0,
      metrics: {
        readCount: v.readCount,
        likeCount: v.likeCount,
        commentCount: v.commentCount,
        forwardCount: v.forwardCount,
        favCount: v.favCount,
      },
    }));
    await db.upsertVideosBatch(userId, videoInfos);
    await db.truncateVideosByUser(userId, this.maxMonitorVideos);

    this.unregisterListener();

    logger.info({ userId, queueLength: commentsQueue.length }, '[Phase1] Check complete');

    return {
      hasUpdate: commentsQueue.length > 0,
      commentsQueue,
      updatedVideos: videos.slice(0, this.maxMonitorVideos).map(v => ({
        exportId: v.exportId,
        description: v.desc?.description || '',
        oldCount: dbVideos.find(d => d.id === v.exportId)?.commentCount ?? 0,
        newCount: v.commentCount ?? 0,
      })),
      riskControlDetected: false,
    }
  }

  // ════════════════════════════════════════
  // Phase 2: 评论管理导航
  // ════════════════════════════════════════

  async navigateToCommentManage(page: Page): Promise<boolean> {
    logger.info('[Phase2] Navigating to comment management page');

    // 注册 comment_list 拦截器（在导航前注册，捕获页面加载时的 API 请求）
    await this.registerListener(page, [COMMENT_LIST_PATTERN]);

    await HumanActions.thinkingPause(page, 800, 2000);

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // ── 检测是否已在评论管理页（通过 page.url() 判断，最可靠）──
      // 评论管理页 URL: https://channels.weixin.qq.com/platform/interaction/comment
      // 不能用 frame URL 判断：wujie 预加载了 /micro/interaction/comment iframe
      const currentUrl = page.url();
      const alreadyOnCommentPage = currentUrl.includes('/platform/interaction/comment');

      if (alreadyOnCommentPage) {
        logger.info({ attempt }, '[Phase2] Already on comment page (URL)');
        return true;
      }

      // 展开「互动管理」菜单
      await this.expandMenu(page, '互动管理');
      await HumanActions.wait(page, 500, 1000);

      // 调试：输出「互动管理」菜单的完整 DOM 结构
      const menuDebug = await page.evaluate(() => {
        const els = document.querySelectorAll('a, span, div, li');
        for (const el of els) {
          if (el.textContent?.trim() === '互动管理') {
            const parent = el.closest('li') || el.parentElement;
            return {
              outerHTML: parent?.outerHTML?.slice(0, 2000) || '',
              childCount: parent?.children?.length || 0,
              parentTag: parent?.tagName,
              parentClass: parent?.className?.toString()?.slice(0, 100),
            };
          }
        }
        return null;
      });
      logger.info({ attempt, menuDebug: JSON.stringify(menuDebug) }, '[Phase2] 互动管理 menu DOM');

      // 点击「评论」子菜单（在侧边栏范围内查找）
      let commentClicked = await this.clickInlineSubMenuItem(page, '评论');
      if (!commentClicked) {
        // 回退：在侧边栏中直接查找「评论」文本
        logger.info('[Phase2] Scoped click failed, trying sidebar evaluate for 评论');
        commentClicked = await page.evaluate(() => {
          const sidebar = document.querySelector('#side-bar');
          if (!sidebar) return false;
          const subMenus = sidebar.querySelectorAll('.finder-ui-desktop-sub-menu');
          for (const subMenu of subMenus) {
            const style = (subMenu as HTMLElement).style;
            if (style.display === 'none') continue;
            const items = subMenu.querySelectorAll('.finder-ui-desktop-sub-menu__item');
            for (const item of items) {
              const nameSpan = item.querySelector('.finder-ui-desktop-menu__name span');
              if (nameSpan?.textContent?.trim() === '评论') {
                const link = item.querySelector('a');
                if (link) { (link as HTMLElement).click(); return true; }
              }
            }
          }
          return false;
        });
      }

      if (commentClicked) {
        logger.info('[Phase2] Comment menu clicked, waiting for page load');
        await HumanActions.wait(page, 3000, 5000);

        const loaded = await this.waitForCommentManagePage(page);
        if (loaded) {
          // 诊断：输出进入评论页后的 URL 和 frame 信息
          const diagUrl = page.url();
          const diagFrames = page.frames().map(f => ({ url: f.url(), name: f.name() }));
          logger.info({ url: diagUrl, frames: diagFrames.slice(0, 6) }, '[Phase2] Comment page loaded');
          return true;
        }
      }

      if (attempt === maxRetries - 1) {
        logger.error('[Phase2] All menu navigation attempts failed for comment page');
      }

      await HumanActions.wait(page, 2000, 3000);
    }

    logger.error('[Phase2] Failed to navigate to comment page');
    return false;
  }

  private async waitForCommentManagePage(page: Page): Promise<boolean> {
    const startTime = Date.now();
    const timeout = 30000;

    while (Date.now() - startTime < timeout) {
      // 评论管理页 URL: https://channels.weixin.qq.com/platform/interaction/comment
      if (page.url().includes('/platform/interaction/comment')) {
        return true;
      }

      // 回退：检查 main document 是否有评论管理容器
      const hasCommentContainer = await HumanActions.cdpIsElementVisible(
        page, '.comment-view, .interaction-wrap, .comment-item'
      );
      if (hasCommentContainer) return true;

      await HumanActions.wait(page, 800, 1500);
    }
    return false;
  }

  // ════════════════════════════════════════
  // Phase 3: 评论采集（通过 CDP 网络层拦截 comment_list API）
  // ════════════════════════════════════════

  /**
   * 将 API 原始评论对象映射为 TencentCommentInfo
   */
  private mapComment(raw: any, exportId: string, level: 1 | 2): TencentCommentInfo {
    return {
      commentId: raw.commentId || '',
      commentContent: raw.commentContent || '',
      commentNickname: raw.commentNickname || '',
      commentHeadurl: raw.commentHeadurl || '',
      commentCreatetime: String(raw.commentCreatetime || '0'),
      commentLikeCount: raw.commentLikeCount || 0,
      levelTwoComment: [], // 将在父级填充
      replyCommentId: raw.replyCommentId,
      replyContent: raw.replyContent,
      replyNickname: raw.replyNickname,
      exportId,
      level,
      readFlag: raw.readFlag,
      likeFlag: raw.likeFlag,
    };
  }

  /**
   * 从单个 comment_list API 响应中提取评论数据
   * 响应结构: { data: { comment: [...], downContinueFlag, lastBuff, commentCount } }
   * 每个 comment 包含 levelTwoComment 数组（子回复）
   */
  private extractCommentsFromResponse(
    resp: { body: any; requestBody?: any },
    exportId: string,
  ): {
    rootComments: TencentCommentInfo[];
    subReplies: TencentCommentInfo[];
    downContinueFlag: number;
    lastBuff: string;
    commentCount: number;
  } {
    const data = resp.body?.data || {};
    const rawComments: any[] = data.comment || [];
    const rootComments: TencentCommentInfo[] = [];
    const subReplies: TencentCommentInfo[] = [];

    for (const raw of rawComments) {
      // 一级评论
      const root = this.mapComment(raw, exportId, 1);
      rootComments.push(root);

      // 子回复（内嵌在 levelTwoComment 数组中）
      const subs: TencentCommentInfo[] = (raw.levelTwoComment || []).map(
        (reply: any) => this.mapComment(reply, exportId, 2)
      );
      root.levelTwoComment = subs;
      subReplies.push(...subs);
    }

    return {
      rootComments,
      subReplies,
      downContinueFlag: data.downContinueFlag ?? 0,
      lastBuff: data.lastBuff || '',
      commentCount: data.commentCount ?? 0,
    };
  }

  /**
   * 采集单个视频的完整评论树
   * 策略：通过 CDP 网络层拦截 comment_list API 响应
   * 1. 先滚动视频列表找到目标视频（瀑布流，可能未加载）
   * 2. 注册拦截器 → 点击视频 → 捕获根评论
   * 3. 滚动加载更多根评论（分页，downContinueFlag 控制）
   * 4. 点击「展开更多回复」→ 捕获子回复（同一 comment_list 端点）
   */
  private async collectVideoComments(
    page: Page,
    exportId: string,
    videoTitle: string,
    userId: number,
    clearPrevious: boolean = true,
  ): Promise<{ success: boolean; allComments: any[]; error?: string }> {
    logger.info({ exportId, videoTitle, clearPrevious }, '[Phase3:Collect] Starting comment collection');

    // 清除之前捕获的评论数据
    if (clearPrevious) {
      this.interceptor.clear(COMMENT_LIST_PATTERN);
    }

    // ── 步骤0: 滚动视频列表找到目标视频（瀑布流可能未加载目标视频）──
    const videoFound = await this.scrollToFindVideo(page, videoTitle);
    if (!videoFound) {
      logger.warn({ exportId, videoTitle }, '[Phase3:Collect] Target video not found in scroll list, trying first video');
      await this.clickFirstVideoInCommentPage(page);
    } else {
      // 点击目标视频
      const videoClicked = await this.clickVideoInCommentPage(page, videoTitle);
      if (!videoClicked) {
        logger.warn({ exportId, videoTitle }, '[Phase3:Collect] Failed to click video after scroll, trying first video');
        await this.clickFirstVideoInCommentPage(page);
      }
    }

    // 等待评论 API 响应
    await HumanActions.wait(page, 3000, 5000);

    // ── 步骤1: 收集根评论（滚动分页）──
    const allRootComments: Map<string, TencentCommentInfo> = new Map();
    const allSubReplies: Map<string, TencentCommentInfo> = new Map();
    let scrollAttempts = 0;
    const MAX_SCROLL_ATTEMPTS = 15;
    let lastRootCount = 0;
    let dataExhausted = false;

    while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
      // 获取最新捕获的 comment_list 响应
      const responses = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
      let currentRootCount = 0;

      for (const resp of responses) {
        const extracted = this.extractCommentsFromResponse(resp, exportId);

        // 添加根评论
        for (const root of extracted.rootComments) {
          if (!allRootComments.has(root.commentId)) {
            allRootComments.set(root.commentId, root);
          }
        }

        // 添加子回复（初始加载的前几条）
        for (const sub of extracted.subReplies) {
          if (!allSubReplies.has(sub.commentId)) {
            allSubReplies.set(sub.commentId, sub);
          }
        }

        // 检查是否还有更多根评论
        if (extracted.downContinueFlag === 0 && extracted.rootComments.length > 0) {
          dataExhausted = true;
        }
      }

      currentRootCount = allRootComments.size;

      // 如果已确认没有更多数据且已处理了数据，退出循环
      if (dataExhausted && currentRootCount > 0) {
        logger.info({ exportId, rootCount: currentRootCount }, '[Phase3:Collect] All root comments loaded (downContinueFlag=0)');
        break;
      }

      if (currentRootCount === lastRootCount && scrollAttempts > 2) {
        // 连续两次滚动没有新评论，可能已到底
        logger.info({ exportId, rootCount: currentRootCount, scrollAttempts }, '[Phase3:Collect] No new root comments after scroll');
        break;
      }

      lastRootCount = currentRootCount;

      // 滚动评论区域加载更多
      // 必须使用 scrollShadowContainer 在 wujie shadow DOM 内通过鼠标滚轮滚动，
      // 直接设置 scrollTop 或滚动 viewport 无法触发 IntersectionObserver 懒加载
      await this.scrollShadowContainer(page, '.feed-comment__wrp', 300);
      await HumanActions.wait(page, 2000, 3000);
      scrollAttempts++;
    }

    logger.info({
      exportId,
      rootCount: allRootComments.size,
      initialSubCount: allSubReplies.size,
      scrollAttempts,
    }, '[Phase3:Collect] Root comment collection complete');

    // ── 步骤2: 展开所有子回复 ──
    // 点击「展开更多回复」后，浏览器发起 comment_list API（带 rootCommentId）
    // 拦截器自动捕获这些响应，我们直接从 API 读取子回复并合并，不解析 DOM
    let expandAttempts = 0;
    const MAX_EXPAND_ATTEMPTS = 50;
    let consecutiveNoExpand = 0;
    let expandScrollCounter = 0;
    // 去重：记录已处理的展开响应（key: rootCommentId_lastBuff）
    const processedExpandKeys = new Set<string>();

    while (expandAttempts < MAX_EXPAND_ATTEMPTS) {
      if (expandAttempts > 0 && expandAttempts % 3 === 0) {
        await this.scrollShadowContainer(page, '.feed-comment__wrp', 200, 2);
        await HumanActions.wait(page, 800, 1200);
        expandScrollCounter++;
      }

      const clicked = await HumanActions.cdpClickByText(page, '展开更多回复', { timeout: 3000 });

      if (!clicked) {
        if (consecutiveNoExpand === 0) {
          await this.scrollShadowContainer(page, '.feed-comment__wrp', 300, 3);
          await HumanActions.wait(page, 1000, 2000);
          const retryClicked = await HumanActions.cdpClickByText(page, '展开更多回复', { timeout: 3000 });
          if (retryClicked) {
            consecutiveNoExpand = 0;
            await HumanActions.wait(page, 2000, 3500);
            expandAttempts++;
            continue;
          }

          const frameClicked = await HumanActions.cdpClickByTextInFrame(
            page, 'interaction', '展开更多回复', { timeout: 3000 }
          );
          if (frameClicked) {
            logger.debug('[Phase3:Collect] Expand clicked via iframe fallback');
            consecutiveNoExpand = 0;
            await HumanActions.wait(page, 2000, 3500);
            expandAttempts++;
            continue;
          }

          const shadowClicked = await page.evaluate(() => {
            const apps = document.querySelectorAll('wujie-app');
            for (const app of Array.from(apps)) {
              const sr = (app as HTMLElement).shadowRoot;
              if (!sr) continue;
              const allEls = sr.querySelectorAll('*');
              for (const el of Array.from(allEls)) {
                if (el.children.length === 0 && el.textContent?.trim() === '展开更多回复') {
                  (el as HTMLElement).click();
                  return true;
                }
              }
            }
            return false;
          });
          if (shadowClicked) {
            logger.debug('[Phase3:Collect] Expand clicked via shadow DOM fallback');
            consecutiveNoExpand = 0;
            await HumanActions.wait(page, 2000, 3500);
            expandAttempts++;
            continue;
          }
        }
        consecutiveNoExpand++;
        if (consecutiveNoExpand >= 2) {
          logger.info({ exportId, expandAttempts, expandScrollCounter }, '[Phase3:Collect] No more expand buttons');
          break;
        }
        await HumanActions.wait(page, 1500, 2500);
        continue;
      }

      consecutiveNoExpand = 0;
      await HumanActions.wait(page, 2000, 3500);
      expandAttempts++;

      // ── 处理展开后新捕获的 API 响应 ──
      // 展开请求在 requestBody 中带有 rootCommentId，需要与初始加载请求区分
      const allResponses = this.interceptor.getResponses(COMMENT_LIST_PATTERN);
      for (const resp of allResponses) {
        const reqBody = resp.requestBody;
        if (!reqBody?.rootCommentId) continue; // 跳过初始加载请求

        const expandKey = `${reqBody.rootCommentId}_${reqBody.lastBuff || ''}`;
        if (processedExpandKeys.has(expandKey)) continue;
        processedExpandKeys.add(expandKey);

        const data = resp.body?.data || {};
        const items: any[] = data.comment || [];

        // 将新子回复合并到对应的根评论
        const parentRoot = allRootComments.get(reqBody.rootCommentId);
        if (parentRoot) {
          const existingIds = new Set(parentRoot.levelTwoComment.map(s => s.commentId));
          for (const item of items) {
            const subReply = this.mapComment(item, exportId, 2);
            if (!existingIds.has(subReply.commentId)) {
              parentRoot.levelTwoComment.push(subReply);
              allSubReplies.set(subReply.commentId, subReply);
              existingIds.add(subReply.commentId);
            }
          }
        }
      }
    }

    logger.info({ exportId, expandAttempts, expandScrollCounter },
      '[Phase3:Collect] Sub-reply expansion complete');

    // ── 步骤3: API 数据 → DB 格式 → 入库（纯 API，不解析 DOM）──
    const dbComments: Map<string, any> = new Map(); // dedup by comment_id
    let subCount = 0;

    // 3a. 所有根评论（来自 API 拦截器）
    for (const [cid, apiRoot] of allRootComments) {
      if (!dbComments.has(cid)) {
        dbComments.set(cid, {
          comment_id: apiRoot.commentId || cid,
          content: apiRoot.commentContent,
          nickname: apiRoot.commentNickname,
          head_img_url: apiRoot.commentHeadurl || '',
          create_time: parseInt(apiRoot.commentCreatetime) || 0,
          like_count: apiRoot.commentLikeCount || 0,
          reply_count: (apiRoot.levelTwoComment || []).length,
          export_id: exportId,
          is_author: false,
          level: 1 as const,
        });
      }
      for (const sub of (apiRoot.levelTwoComment || [])) {
        const subCid = sub.commentId || `api_${exportId}_${Math.random().toString(36).slice(2, 8)}`;
        if (!dbComments.has(subCid)) {
          dbComments.set(subCid, {
            comment_id: sub.commentId || subCid,
            content: sub.commentContent,
            nickname: sub.commentNickname,
            head_img_url: sub.commentHeadurl || '',
            create_time: parseInt(sub.commentCreatetime) || 0,
            like_count: sub.commentLikeCount || 0,
            reply_count: 0,
            export_id: exportId,
            is_author: false,
            level: 2 as const,
            root_id: cid,
            parent_id: sub.replyCommentId || cid,
            reply_to_name: sub.replyNickname || '',
          });
          subCount++;
        }
      }
    }

    const dbCommentsArray = Array.from(dbComments.values());

    if (dbCommentsArray.length > 0) {
      await db.batchUpsertComments('tencent', dbCommentsArray, userId);
      await db.updateVideoCommentCount(userId, exportId, dbCommentsArray.length);
    }

    const totalRootCount = allRootComments.size;
    const totalSubCount = Array.from(allRootComments.values())
      .reduce((s, r) => s + (r.levelTwoComment?.length || 0), 0);
    logger.info({
      exportId,
      rootCount: totalRootCount,
      subCount,
      apiTotalRoots: totalRootCount,
      apiTotalSubs: totalSubCount,
      total: dbCommentsArray.length,
    }, '[Phase3:Collect] Comments saved to DB (API only)');

    return {
      success: true,
      allComments: dbCommentsArray,
    };
  }

  /**
   * 在评论管理页面左侧视频列表中点击目标视频
   * 视频列表在 wujie iframe 内部，需要穿透 iframe 查找
   * Wujie 结构: wujie-app > iframe[name="interaction"] > document > .comment-feed-wrap > .feed-title
   */
  private async clickVideoInCommentPage(page: Page, videoTitle: string): Promise<boolean> {
    logger.info({ videoTitle }, '[Phase3] Clicking video in comment page');

    // 主路径: 通过 frame API 点击（无 JS 注入）
    const frameClicked = await HumanActions.cdpClickInFrame(
      page,
      'interaction',
      '.comment-feed-wrap',
      { text: videoTitle, exact: false },
    );
    if (frameClicked) {
      logger.info({ videoTitle }, '[Phase3] Video clicked via iframe');
      return true;
    }

    // 回退: 在 shadow DOM 中查找（兼容旧版 wujie）
    const shadowClicked = await page.evaluate((title: string) => {
      const wujieApps = document.querySelectorAll('wujie-app');
      for (const app of Array.from(wujieApps)) {
        const sr = (app as HTMLElement).shadowRoot;
        if (!sr) continue;
        const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap'));
        const target = feeds.find(f => f.querySelector('.feed-title')?.textContent?.trim() === title)
          || feeds.find(f => f.querySelector('.feed-title')?.textContent?.trim().includes(title.slice(0, 10)));
        if (target) { (target as HTMLElement).click(); return true; }
      }
      return false;
    }, videoTitle);
    if (shadowClicked) {
      logger.info({ videoTitle }, '[Phase3] Video clicked via shadow DOM fallback');
      return true;
    }

    logger.warn({ videoTitle }, '[Phase3] Video not found in iframe or shadow DOM');
    return false;
  }

  /**
   * 点击评论管理页面左侧视频列表中的第一个视频
   * 穿透 wujie iframe 查找视频列表
   */
  private async clickFirstVideoInCommentPage(page: Page): Promise<boolean> {
    // 主路径: iframe API
    const frameClicked = await HumanActions.cdpClickInFrame(page, 'interaction', '.comment-feed-wrap');
    if (frameClicked) {
      logger.info('[Phase3] First video clicked via iframe');
      return true;
    }

    // 回退: shadow DOM
    const shadowClicked = await page.evaluate(() => {
      const wujieApps = document.querySelectorAll('wujie-app');
      for (const app of Array.from(wujieApps)) {
        const sr = (app as HTMLElement).shadowRoot;
        if (!sr) continue;
        const feed = sr.querySelector('.comment-feed-wrap');
        if (feed) { (feed as HTMLElement).click(); return true; }
      }
      return false;
    });
    if (shadowClicked) {
      logger.info('[Phase3] First video clicked via shadow DOM fallback');
    }
    return shadowClicked;
  }

  // ════════════════════════════════════════
  // Shadow DOM 滚动辅助（用于 wujie 微前端的懒加载滚动）
  // ════════════════════════════════════════

  /**
   * 在 wujie shadow DOM 内的滚动容器中模拟鼠标滚轮滚动。
   *
   * 视频号助手使用 wujie 微前端，评论/视频列表在 Shadow DOM 内。
   * 页面用 IntersectionObserver 监听底部哨兵触发懒加载，
   * **只有真实鼠标滚轮事件能触发**（直接设置 scrollTop 无效）。
   *
   * 流程:
   * 1. 通过 shadow DOM 查找容器 → 获取其视口坐标
   * 2. 移动鼠标到容器中心（hover 触发 mouseenter 事件）
   * 3. 分段 CDP wheel 滚动（模拟真实人类分段滚动）
   *
   * @param containerSelector - CSS 选择器（如 .feed-comment__wrp / .feeds-container）
   * @param deltaY            - 滚动总像素量（正数向下）
   * @param segments          - 分段数（默认 3，每段 deltaY/segments 像素）
   * @returns                 - 是否成功定位到容器并执行滚动
   */
  private async scrollShadowContainer(
    page: Page,
    containerSelector: string,
    deltaY: number = 300,
    segments: number = 3,
  ): Promise<boolean> {
    // ── 1. 从 shadow DOM 获取容器的视口坐标 ──
    const rect = await page.evaluate((sel: string) => {
      // 主路径: wujie-app 的 shadowRoot
      const wujieApps = document.querySelectorAll('wujie-app');
      for (const app of Array.from(wujieApps)) {
        const sr = (app as HTMLElement).shadowRoot;
        if (!sr) continue;
        const el = sr.querySelector(sel);
        if (el) return el.getBoundingClientRect();
      }
      // 回退: 主文档
      const el = document.querySelector(sel);
      if (el) return el.getBoundingClientRect();
      return null;
    }, containerSelector);

    if (!rect) {
      logger.warn({ containerSelector }, '[ShadowScroll] Container not found');
      return false;
    }

    // ── 2. 移到容器中央（触发 mouseenter，激活 IntersectionObserver）──
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    await HumanActions.cdpIdleMove(page, centerX, centerY);
    await HumanActions.wait(page, 200, 400);

    // ── 3. 分段 wheel 滚动 ──
    const segSize = Math.floor(deltaY / segments);
    for (let i = 0; i < segments; i++) {
      // 每 3 段微移鼠标（模拟真实手部抖动）
      if (i % 3 === 2) {
        const jx = centerX + (Math.random() - 0.5) * 4;
        const jy = centerY + (Math.random() - 0.5) * 4;
        await HumanActions.cdpIdleMove(page, jx, jy);
      }
      await HumanActions.cdpIdleWheel(page, segSize);
      await HumanActions.wait(page, 100, 300);
    }

    return true;
  }

  /**
   * 在视频瀑布流列表中滚动查找目标视频。
   *
   * 视频列表在 wujie shadow DOM 内，是滚动加载的瀑布流。
   * 滚动容器: .feeds-container（.scroll-list__wrp.feeds-container）
   * 列表项: .comment-feed-wrap
   *
   * 通过 shadow DOM 直接查询目标视频，未找到时用 scrollShadowContainer
   * 滚动加载更多（鼠标 wheel → IntersectionObserver → API 加载）。
   */
  private async scrollToFindVideo(page: Page, videoTitle: string): Promise<boolean> {
    logger.info({ videoTitle }, '[Phase3:Scroll] Scrolling to find video in waterfall list');

    const MAX_SCROLLS = 20;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      // 在 shadow DOM 中查找目标视频
      const found = await page.evaluate((title: string) => {
        const wujieApps = document.querySelectorAll('wujie-app');
        for (const app of Array.from(wujieApps)) {
          const sr = (app as HTMLElement).shadowRoot;
          if (!sr) continue;
          const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap'));
          if (feeds.some(f =>
            f.querySelector('.feed-title')?.textContent?.trim() === title
            || f.querySelector('.feed-title')?.textContent?.trim().includes(title.slice(0, 10))
          )) return true;
        }
        return false;
      }, videoTitle);

      if (found) {
        logger.info({ videoTitle, scrolls: i }, '[Phase3:Scroll] Video found');
        return true;
      }

      // 未找到，用鼠标滚轮滚动视频列表容器加载更多
      // 使用 scrollShadowContainer 确保 wheel 事件精准发送到 shadow DOM 容器
      const scrolled = await this.scrollShadowContainer(page, '.feeds-container', 500, 4);
      if (!scrolled) {
        logger.warn({ videoTitle }, '[Phase3:Scroll] Cannot access scroll container, giving up');
        break;
      }

      await HumanActions.wait(page, 1500, 2500);
    }

    logger.warn({ videoTitle, maxScrolls: MAX_SCROLLS }, '[Phase3:Scroll] Video not found after max scrolls');
    return false;
  }

  async processCommentsQueue(
    page: Page,
    queue: CommentQueueItem[],
    userId: number,
  ): Promise<CommentProcessResult[]> {
    const results: CommentProcessResult[] = [];
    logger.info({ queueLength: queue.length }, '[Phase3] Starting comment queue processing');

    // 注意：comment_list 拦截器已在 navigateToCommentManage (Phase2) 中注册
    // Phase2 导航时触发的 comment_list API 响应已被拦截器捕获
    // 第一个视频的 collectVideoComments 会保留这些初始数据

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      logger.info({ index: i + 1, total: queue.length, exportId: item.exportId }, '[Phase3] Processing video');

      try {
        // 风控检测
        const riskCheck = await this.detectRiskControl(page);
        if (riskCheck.detected) {
          logger.error({ exportId: item.exportId, riskType: riskCheck.type }, '[Phase3] Risk control detected');
          results.push({ exportId: item.exportId, success: false, comments: [], error: 'Risk control detected' });
          break;
        }

        // 视频切换在 collectVideoComments 中通过 clickVideoInCommentPage 完成

        // 采集该视频的完整评论树
        // 第一个视频不清除拦截器数据（保留 Phase2 导航时捕获的初始 comment_list 响应）
        const collectResult = await this.collectVideoComments(
          page, item.exportId, item.description, userId, i > 0
        );

        results.push({
          exportId: item.exportId,
          success: collectResult.success,
          comments: collectResult.allComments,
          error: collectResult.error,
        });

        if (collectResult.success) {
          const rootCount = collectResult.allComments.filter(c => c.level === 1).length;
          const subCount = collectResult.allComments.filter(c => c.level === 2).length;
          logger.info(
            { exportId: item.exportId, rootCount, subCount, total: collectResult.allComments.length },
            '[Phase3] Video processed: %d root + %d subs',
            rootCount, subCount
          );
        }

        // 视频间冷却（随机化，防风控）
        await HumanActions.wait(page, 3000, 6000);

        // 模拟真实用户行为：偶尔随机滚动/点击
        if (i % 3 === 2) {
          await HumanActions.randomBlankClick(page);
          await HumanActions.wait(page, 1000, 2000);
        }
      } catch (error: any) {
        logger.error({ error: error.message, exportId: item.exportId }, '[Phase3] Comment processing failed');
        results.push({
          exportId: item.exportId,
          success: false,
          comments: [],
          error: error.message,
        });
      }
    }

    this.unregisterListener();
    return results;
  }

  /**
   * 切换到目标视频（回复用）
   * 通过 wujie shadow DOM 内的视频列表点击目标视频
   * DOM 结构: wujie-app > shadowRoot > .feeds > .feeds-container > .comment-feed-wrap
   */
  async switchToVideoForReply(
    page: Page,
    videoTitle: string,
  ): Promise<boolean> {
    logger.info({ videoTitle }, '[Reply:SwitchVideo] Starting video switch');

    // 先检查目标视频是否已经选中
    const alreadyActive = await page.evaluate((title: string) => {
      const sr = document.querySelector('wujie-app')?.shadowRoot;
      if (!sr) return false;
      const activeFeed = sr.querySelector('.comment-feed-wrap.active-feed');
      if (!activeFeed) return false;
      const activeTitle = activeFeed.querySelector('.feed-title')?.textContent?.trim() || '';
      return activeTitle === title || activeTitle.includes(title.slice(0, 8));
    }, videoTitle);

    if (alreadyActive) {
      logger.info({ videoTitle }, '[Reply:SwitchVideo] Video already active');
      return true;
    }

    // 滚动视频列表找到目标视频
    const MAX_SCROLLS = 15;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      // 在 shadow DOM 中查找目标视频并获取其坐标
      const rect = await page.evaluate((title: string) => {
        const sr = document.querySelector('wujie-app')?.shadowRoot;
        if (!sr) return null;
        const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap'));
        const target = feeds.find(f => {
          const t = f.querySelector('.feed-title')?.textContent?.trim() || '';
          return t === title || t.includes(title.slice(0, 8));
        });
        if (target) return target.getBoundingClientRect();
        return null;
      }, videoTitle);

      if (rect) {
        // 找到视频，通过 evaluate 在 shadow DOM 内直接点击
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        await HumanActions.cdpIdleMove(page, cx, cy);
        await HumanActions.wait(page, 100, 300);
        await page.evaluate((title: string) => {
          const sr = document.querySelector('wujie-app')?.shadowRoot;
          if (!sr) return;
          const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap'));
          const target = feeds.find(f => {
            const t = f.querySelector('.feed-title')?.textContent?.trim() || '';
            return t === title || t.includes(title.slice(0, 8));
          });
          if (target) (target as HTMLElement).click();
        }, videoTitle);

        await HumanActions.wait(page, 2000, 3000);
        logger.info({ videoTitle }, '[Reply:SwitchVideo] Video clicked successfully');
        return true;
      }

      // 未找到，滚动加载更多
      const scrolled = await this.scrollShadowContainer(page, '.feeds-container', 400, 3);
      if (!scrolled) {
        logger.warn({ videoTitle }, '[Reply:SwitchVideo] Cannot scroll video list');
        break;
      }
      await HumanActions.wait(page, 1500, 2500);
    }

    logger.warn({ videoTitle }, '[Reply:SwitchVideo] Target video not found after scrolling');
    return false;
  }

  /**
   * 拟人化回复评论
   *
   * 实际 DOM 结构（wujie shadow DOM，无 iframe）:
   * - 回复图标: .action-item .weui-icon-outlined-comment (div, 不是 button)
   * - 回复输入框: textarea.create-input (placeholder="回复 xxx：")
   * - 发送按钮: .create-ft .tag-wrap.primary .tag-inner (文字"评论"，不是"发送")
   * - 取消按钮: .create-ft .tag-wrap.cancel .tag-inner (文字"取消")
   */
  async replyToComment(
    page: Page,
    commentCid: string,
    replyText: string,
    commentText?: string,
  ): Promise<boolean> {
    logger.info({ commentCid, textLength: replyText.length }, '[Reply] Starting reply');

    try {
      // 模拟人类思考时间
      await HumanActions.thinkingPause(page, 800, 2000);

      // 定位目标评论的 "回复" 按钮
      // 注：视频号回复按钮是 .action-item（div, 不是 button）
      // wujie shadow DOM 内操作，需用 page.evaluate 访问
      const replyIconRect = await page.evaluate((params: { cid: string; text: string }) => {
        const root = document.querySelector('wujie-app')?.shadowRoot;
        if (!root) return null;
        // 遍历所有评论项，按文本匹配目标评论
        const commentItems = root.querySelectorAll('.comment-item-main');
        for (const item of commentItems) {
          const textEl = item.querySelector('.comment-content');
          if (!textEl) continue;
          // 按评论文本匹配（去除首尾空格后比较）
          const itemText = (textEl.textContent || '').trim();
          if (params.text && itemText !== params.text.trim()) continue;
          // 找到对应评论的 action-list 中的回复图标
          const replyIcon = item.querySelector('.action-list .action-item .weui-icon-outlined-comment');
          if (replyIcon) {
            const rect = replyIcon.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }
          }
        }
        // 回退：找第一个可见的回复图标
        const allReplyIcons = root.querySelectorAll('.action-item .weui-icon-outlined-comment');
        for (const icon of allReplyIcons) {
          const rect = icon.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }
        }
        return null;
      }, { cid: commentCid, text: commentText || '' });

      if (!replyIconRect) {
        logger.error({ commentCid }, '[Reply] Reply icon not found in shadow DOM');
        return false;
      }

      // CDP 点击回复图标（shadow DOM 内的元素需用坐标点击）
      const replyClickX = replyIconRect.x + replyIconRect.width / 2;
      const replyClickY = replyIconRect.y + replyIconRect.height / 2;
      await HumanActions.cdpIdleMove(page, replyClickX, replyClickY);
      await HumanActions.clickAtCoordinates(page, replyClickX, replyClickY);

      // 等待输入框出现（点击回复按钮后才会出现）
      await HumanActions.wait(page, 800, 1500);

      // 在 shadow DOM 中查找并点击回复输入框
      const inputRect = await page.evaluate(() => {
        const root = document.querySelector('wujie-app')?.shadowRoot;
        if (!root) return null;
        const textarea = root.querySelector('textarea.create-input');
        if (textarea) {
          const rect = textarea.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }
        }
        return null;
      });

      if (inputRect) {
        // 点击输入框获取焦点
        const inputX = inputRect.x + inputRect.width / 2;
        const inputY = inputRect.y + inputRect.height / 2;
        await HumanActions.clickAtCoordinates(page, inputX, inputY);
        await HumanActions.wait(page, 300, 600);
      } else {
        // 回退：直接 focus textarea
        await page.evaluate(() => {
          const root = document.querySelector('wujie-app')?.shadowRoot;
          if (!root) return;
          const textarea = root.querySelector('textarea.create-input');
          if (textarea) textarea.focus();
        });
        await HumanActions.wait(page, 200, 400);
      }

      // 拟人化输入（safeCDPType 使用 CDP keyboard 事件，可穿透 shadow DOM）
      await HumanActions.safeCDPType(page, replyText);

      await HumanActions.wait(page, 500, 1200);

      // 点击发送按钮（shadow DOM 内的 .create-ft .tag-wrap.primary）
      const submitClicked = await page.evaluate(() => {
        const root = document.querySelector('wujie-app')?.shadowRoot;
        if (!root) return null;
        const submitBtn = root.querySelector('.create-ft .tag-wrap.primary');
        if (submitBtn) {
          const rect = submitBtn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }
        }
        return null;
      });

      let submitted = false;
      if (submitClicked) {
        const submitX = submitClicked.x + submitClicked.width / 2;
        const submitY = submitClicked.y + submitClicked.height / 2;
        await HumanActions.cdpIdleMove(page, submitX, submitY);
        await HumanActions.clickAtCoordinates(page, submitX, submitY);
        submitted = true;
      } else {
        // 回退：Enter 键发送 (CDP keypress 穿透 shadow DOM)
        logger.warn('[Reply] Submit button not found, trying Enter key');
        await HumanActions.cdpKeyPress(page, 'Enter', 'Enter', 13);
        submitted = true;
      }

      // 等待发送完成
      await HumanActions.wait(page, 1500, 3000);

      // 验证发送是否成功（检查回复区域是否消失）
      const replySent = await page.evaluate(() => {
        const root = document.querySelector('wujie-app')?.shadowRoot;
        if (!root) return true; // 无法确认，假设成功
        const createWrap = root.querySelector('.comment-create-wrap');
        // 如果回复输入区域消失，说明发送成功
        return !createWrap || createWrap.offsetHeight === 0;
      });

      if (replySent) {
        logger.info({ commentCid, submitted }, '[Reply] Reply sent successfully');
      } else {
        logger.warn({ commentCid }, '[Reply] Reply may not have been sent - input area still visible');
      }

      // 模拟发送后的人类行为
      await HumanActions.betweenActionsPause(page);

      return true;
    } catch (err: any) {
      logger.error({ error: err.message, commentCid }, '[Reply] Reply failed');
      return false;
    }
  }

  // ════════════════════════════════════════
  // 退出策略
  // ════════════════════════════════════════

  async executeExitStrategy(page: Page): Promise<void> {
    try {
      // 随机选择退出行为
      const actions = ['navigate_submenu', 'idle_wander', 'refresh'];
      const action = actions[Math.floor(Math.random() * actions.length)];
      logger.info({ action }, '[Exit] Starting exit strategy');

      if (action === 'navigate_submenu') {
        // 所有可用子菜单（内容管理、互动管理、直播）
        const submenus = [
          // 内容管理
          { parent: '内容管理', child: '图文' },
          { parent: '内容管理', child: '音乐' },
          { parent: '内容管理', child: '音频' },
          { parent: '内容管理', child: '草稿箱' },
          { parent: '内容管理', child: '主页' },
          { parent: '内容管理', child: '活动' },
          // 互动管理
          { parent: '互动管理', child: '评论' },
          { parent: '互动管理', child: '弹幕' },
          { parent: '互动管理', child: '私信' },
          // 直播
          { parent: '直播', child: '直播管理' },
          { parent: '直播', child: '直播商品管理' },
          { parent: '直播', child: '直播预告' },
          { parent: '直播', child: '直播回放' },
          { parent: '直播', child: '个人创作礼物管理' },
        ];
        const target = submenus[Math.floor(Math.random() * submenus.length)];
        logger.info({ parent: target.parent, child: target.child }, '[Exit] Navigating to submenu');
        await this.expandMenu(page, target.parent);
        const clicked = await this.clickInlineSubMenuItem(page, target.child);
        if (clicked) {
          logger.info({ child: target.child }, '[Exit] Submenu clicked');
          await HumanActions.wait(page, 2000, 3000);
          return;
        }
        logger.warn({ child: target.child }, '[Exit] Submenu click failed, falling through');
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

  /**
   * 自主测试退出策略 — 连续执行 N 次，验证菜单导航可靠性
   */
  async testExitStrategy(page: Page, rounds: number = 5): Promise<void> {
    logger.info({ rounds }, '[Test] Starting exit strategy self-test');
    for (let i = 0; i < rounds; i++) {
      logger.info({ round: i + 1, total: rounds }, '[Test] Round');
      const urlBefore = page.url();
      try {
        await this.executeExitStrategy(page);
        const urlAfter = page.url();
        logger.info({ urlBefore, urlAfter }, '[Test] Exit strategy result');
      } catch (err: any) {
        logger.error({ round: i + 1, error: err.message }, '[Test] Exit strategy failed');
      }
      await HumanActions.wait(page, 1000, 2000);
    }
    logger.info('[Test] Exit strategy self-test complete');
  }
}
