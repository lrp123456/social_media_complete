import { Page } from 'patchright';
import { RequestInterceptor, HumanActions } from '@social-media/browser-core';
import * as db from '../services/monitorDatabaseService';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { getSelector, getRandomExitSubmenuKey, getSubmenuKeyForPageType } from './menuSelectors';
import { parseDomTimestamp, isTimestampMatch, isDescriptionMatch } from './timeParser';
import { getSelectorReader } from '../lib/selectorStore';
import { isDebugModeEnabled, createReplySessionId, createManifest, saveDebugSnapshot, finishManifest, DebugManifest } from '../lib/replyDebugLogger';
import { recordSelectorTry } from '../lib/taskExecutionRecorder';
import * as fs from 'fs';
import * as path from 'path';
import type { ReplyTarget } from './replyTypes';

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
  username?: string;            // 评论作者标识（用于 isAuthor 判断）
  exportId: string;             // 所属视频ID（本地注入）
  level: 1 | 2;                 // 1=一级评论, 2=子回复
  readFlag?: boolean;
  likeFlag?: number;
};

export interface CommentQueueItem {
  exportId: string;
  description: string;
  createTime: number;
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

/**
 * 视频号回复目标（与抖音 ReplyTarget / 快手 KuaishouReplyTarget 对齐）
 * 用于 replyToComment 方法精确定位根评论或子评论
 */
export interface TencentReplyTarget extends ReplyTarget {
  commentCid: string;
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

// 收紧关键词：移除 '验证'/'安全'/'限制'/'login' 等正常平台页面必然出现的通用词
// 对齐抖音/快手的关键词策略，只保留风控页面特有的多字短语
const RISK_CONTROL_KEYWORDS = ['captcha', '安全验证', '验证码', '账号异常', '封禁', '操作频繁', '操作受限'];
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
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { wechatUserid: true, fingerprintWindowId: true } });

    // 使用主页面直接截取 QR（captureQR 支持 iframe）
    const { loginTabRegistry, getLoginFlowConfig } = await import('../services/loginFlowHelpers');
    const tcConfig = getLoginFlowConfig('tencent', 'creator');
    let qrSent = false;
    if (tcConfig && user?.wechatUserid) {
      const tcQrBuf = await loginTabRegistry.captureQR(page, tcConfig);
      if (tcQrBuf) {
        await botManager.sendLoginAlert(user.wechatUserid, 'tencent', userId, tcQrBuf);
        qrSent = true;
        // 首次 QR 发送后交由后台轮询，直接返回
        return false;
      }
    }
    if (!qrSent && user?.wechatUserid) {
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
        if (tcConfig && user?.wechatUserid) {
          const tcQrBuf2 = await loginTabRegistry.captureQR(page, tcConfig);
          if (tcQrBuf2) {
            await botManager.sendLoginAlert(user.wechatUserid, 'tencent', userId, tcQrBuf2);
          }
        } else if (user?.wechatUserid) {
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
   * 视频号登录页是 iframe 结构，QR 码在 iframe 内部
   * 每次截取前点击刷新 + 扩大截图区域（四周 padding，正方形裁剪）
   */
  private async captureAndSendQR(
    page: Page,
    userId: number,
    platform: string,
    wechatUserid: string,
    botManager: any,
  ): Promise<void> {
    try {
      let buf: Buffer | undefined;

      // ── 1. 穿透 iframe ──
      // 视频号登录页: iframe[src*="login-for-iframe"] 内含 QR 码
      const iframeEl = await page.$('iframe[src*="login-for-iframe"]').catch(() => null)
        ?? await page.$('iframe.display').catch(() => null);
      if (iframeEl) {
        const frame = await iframeEl.contentFrame();
        if (frame) {
          await frame.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1500);

          // ── 1a. 仅在二维码过期时点击刷新（避免无条件刷新导致二维码进入异常状态）──
          await this.clickQRRefreshIfNeeded(frame, page);

          // ── 1b. 在 iframe 内部用 evaluate 找最大方形 img/canvas ──
          const qrInfo = await frame.evaluate(() => {
            const candidates: Array<{ sel: string; x: number; y: number; w: number; h: number }> = [];
            // 搜索所有 img 和 canvas，找面积最大且接近正方形的
            const els = document.querySelectorAll('img, canvas, [class*="qr"], [class*="Qr"], [class*="QR"]');
            els.forEach((el, idx) => {
              const r = el.getBoundingClientRect();
              if (r.width < 60 || r.height < 60) return;
              const ratio = Math.min(r.width, r.height) / Math.max(r.width, r.height);
              if (ratio < 0.5) return; // 太扁的不是二维码
              candidates.push({ sel: `idx_${idx}_${el.tagName}`, x: r.left, y: r.top, w: r.width, h: r.height });
            });
            // 按面积排序，取最大
            candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h));
            return candidates[0] || null;
          }).catch(() => null);

          if (qrInfo) {
            // boundingBox 返回的是相对于页面的坐标（包含 iframe 偏移）
            const iframeBox = await iframeEl.boundingBox();
            if (iframeBox) {
              // qrInfo 的坐标是相对于 iframe 内部的，需要加上 iframe 在页面中的偏移
              const absX = iframeBox.x + qrInfo.x;
              const absY = iframeBox.y + qrInfo.y;

              // 正方形裁剪 + 四周扩大 padding
              const maxDim = Math.max(qrInfo.w, qrInfo.h);
              const PAD = Math.round(maxDim * 0.15); // 15% padding
              const side = maxDim + PAD * 2;
              const cx = absX + qrInfo.w / 2;
              const cy = absY + qrInfo.h / 2;
              const clip = {
                x: Math.max(0, cx - side / 2),
                y: Math.max(0, cy - side / 2),
                width: side,
                height: side,
              };
              buf = await page.screenshot({ type: 'png', clip });
              logger.info({ qrW: qrInfo.w, qrH: qrInfo.h, clipSide: side, pad: PAD }, '[Login] QR captured inside iframe (square + padding)');
            }
          }

          // iframe 内未找到 QR 元素 → 截取 iframe 元素本身 + padding
          if (!buf) {
            const iframeBox = await iframeEl.boundingBox();
            if (iframeBox && iframeBox.width > 100 && iframeBox.height > 100) {
              const PAD = 40;
              const clip = {
                x: Math.max(0, iframeBox.x - PAD),
                y: Math.max(0, iframeBox.y - PAD),
                width: iframeBox.width + PAD * 2,
                height: iframeBox.height + PAD * 2,
              };
              buf = await page.screenshot({ type: 'png', clip });
              logger.info({ width: clip.width, height: clip.height }, '[Login] QR fallback: iframe element + padding');
            }
          }
        }
      }

      // ── 2. 非 iframe 结构：直接在主页面搜索 ──
      if (!buf) {
        const PADDING = 40;
        const pageSelectors = [
          'img[src*="qrcode"]',
          'img[src*="qr"]',
          'canvas',
          '[class*="qrcode"] img',
        ];
        for (const sel of pageSelectors) {
          try {
            const el = await page.$(sel);
            if (el) {
              await el.waitForElementState('visible', { timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(500);
              const box = await el.boundingBox();
              if (box && box.width > 50 && box.height > 50) {
                const maxDim = Math.max(box.width, box.height);
                const cx = box.x + box.width / 2;
                const cy = box.y + box.height / 2;
                const side = maxDim + PADDING * 2;
                const clip = {
                  x: Math.max(0, cx - side / 2),
                  y: Math.max(0, cy - side / 2),
                  width: side,
                  height: side,
                };
                buf = await page.screenshot({ type: 'png', clip });
                logger.info({ selector: sel, clipSide: side }, '[Login] QR screenshot captured (main page, square + padding)');
                break;
              }
            }
          } catch {}
        }
      }

      // ── 3. 最终兜底 ──
      if (!buf) {
        buf = await page.screenshot({ type: 'png' });
        logger.info('[Login] Fallback: full page screenshot');
      }

      await botManager.sendLoginAlert(wechatUserid, platform, userId, buf).catch(() => {});
    } catch (err) {
      await botManager.sendLoginAlert(wechatUserid, platform, userId).catch(() => {});
    }
  }

  /**
   * 仅在二维码过期时点击刷新 — 避免无条件刷新导致二维码进入异常状态
   * 检查 iframe 内是否显示"已过期"/"已失效"/"刷新"等文字，只有检测到过期才点击刷新
   */
  private async clickQRRefreshIfNeeded(frame: any, page: Page): Promise<void> {
    try {
      // 先检查二维码是否已过期（通过 iframe 内的文字判断）
      const isExpired = await frame.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        return bodyText.includes('已过期') || bodyText.includes('已失效') || bodyText.includes('已退出')
          || bodyText.includes('二维码已过期') || bodyText.includes('请刷新');
      }).catch(() => false);

      if (!isExpired) {
        logger.info('[Login] QR code not expired, skipping refresh');
        return;
      }

      logger.info('[Login] QR code expired, clicking refresh');

      // 方式1: 查找刷新按钮（常见 class/text）
      const refreshSelectors = [
        '.qrcode-refresh-btn',
        '[class*="refresh"]',
        '[class*="Refresh"]',
        'a[class*="refresh"]',
        'span[class*="refresh"]',
      ];
      for (const sel of refreshSelectors) {
        const btn = await frame.$(sel).catch(() => null);
        if (btn) {
          await btn.click().catch(() => {});
          // 等待刷新完成（新二维码加载）
          await page.waitForTimeout(3000);
          logger.info({ selector: sel }, '[Login] QR refresh button clicked');
          return;
        }
      }

      // 方式2: 查找包含"刷新"/"重新生成"文字的可点击元素
      const refreshed = await frame.evaluate(() => {
        const els = document.querySelectorAll('a, button, span, div, p');
        for (const el of els) {
          const text = el.textContent?.trim() || '';
          if (text === '刷新' || text === '重新生成' || text === '点击刷新' || text === '重新获取') {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (refreshed) {
        await page.waitForTimeout(3000);
        logger.info('[Login] QR refreshed via text click');
        return;
      }

      // 方式3: 点击二维码区域本身（有些平台点击 QR 刷新）
      const qrEl = await frame.$('img[src*="qr"], img[src*="qrcode"], canvas, [class*="qr"] img').catch(() => null);
      if (qrEl) {
        await qrEl.click().catch(() => {});
        await page.waitForTimeout(3000);
        logger.info('[Login] QR area clicked for refresh');
      }
    } catch {}
  }

  // ════════════════════════════════════════
  // 风控检测
  // ════════════════════════════════════════

  /**
   * 保存风控场景截图和页面文本（用于事后排查）
   * 与抖音/快手实现对齐
   */
  async captureRiskScene(page: Page, userId: number, riskType: string): Promise<{ screenshotPath: string | null; htmlPath: string | null }> {
    const sceneDir = path.resolve(process.cwd(), 'data', 'risk_scenes');
    if (!fs.existsSync(sceneDir)) {
      fs.mkdirSync(sceneDir, { recursive: true });
    }

    const timestamp = Date.now();
    const baseName = `risk_${userId}_tencent_${riskType}_${timestamp}`;
    let screenshotPath: string | null = null;
    let htmlPath: string | null = null;

    try {
      const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
      screenshotPath = path.join(sceneDir, `${baseName}.png`);
      fs.writeFileSync(screenshotPath, screenshotBuffer);
      logger.info({ screenshotPath, sizeKB: Math.round(screenshotBuffer.length / 1024) }, '[RiskScene] 截图已保存');
    } catch (error: any) {
      logger.warn({ error: error.message }, '[RiskScene] 截图保存失败');
    }

    try {
      const html = await HumanActions.cdpGetBodyText(page);
      htmlPath = path.join(sceneDir, `${baseName}.html.txt`);
      fs.writeFileSync(htmlPath, html);
      logger.info({ htmlPath, length: html.length }, '[RiskScene] 页面文本已保存');
    } catch (error: any) {
      logger.warn({ error: error.message }, '[RiskScene] 页面文本保存失败');
    }

    return { screenshotPath, htmlPath };
  }

  async detectRiskControl(page: Page): Promise<RiskControlDetection> {
    try {
      const url = page.url();

      // URL 重定向检测（始终执行）
      for (const riskUrl of RISK_CONTROL_URLS) {
        if (url.includes(riskUrl) && !url.includes('/platform')) {
          return { detected: true, type: 'url_redirect', evidence: `Redirected: ${url}` };
        }
      }

      // Body 关键词检测 — 仅在不在 /platform 时执行
      // 在 /platform 页面时用户已登录，body 中的"安全验证"等词是正常导航文本，不是风控
      if (!url.includes('/platform')) {
        const bodyText = await HumanActions.cdpGetBodyText(page);
        for (const keyword of RISK_CONTROL_KEYWORDS) {
          if (bodyText.includes(keyword.toLowerCase())) {
            return { detected: true, type: 'risk_keyword', evidence: `Found: "${keyword}"` };
          }
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
      // 二次确认：导航到首页后重新检查 URL，排除误报
      logger.warn({ userId, riskType: riskCheck.type, evidence: riskCheck.evidence }, '[Phase1] Risk detected, doing secondary confirmation');
      await this.clickHomeMenu(page);
      const confirmUrl = page.url();
      const stillRisk = !confirmUrl.includes('/platform') || confirmUrl.includes('/login');

      if (stillRisk) {
        // 确认风控 — 保存场景截图用于排查
        await this.captureRiskScene(page, userId, riskCheck.type);
        logger.error({ userId, riskType: riskCheck.type, url: confirmUrl }, '[Phase1] Risk control confirmed after secondary check');
        return {
          hasUpdate: false,
          commentsQueue: [],
          updatedVideos: [],
          riskControlDetected: true,
          riskControlInfo: riskCheck,
        };
      }

      // 二次确认排除误报 — 继续正常流程
      logger.info({ userId, riskType: riskCheck.type }, '[Phase1] Risk flag cleared after secondary confirmation (false positive)');
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

    // 获取拦截到的视频列表（支持翻页加载）
    // 响应结构: { errCode, errMsg, data: { list: [...], totalCount, continueFlag, lastBuff } }
    const intercepted = await this.interceptor.waitForResponse(POST_LIST_PATTERN, 15000);
    // 从拦截到的请求 payload 中提取 _log_finder_id（视频号作者标识）
    let finderId: string | undefined;
    try {
      const reqBody = (intercepted as any)?.requestBody || (intercepted as any)?.requestPostData;
      if (reqBody) {
        const parsed = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody;
        finderId = parsed?._log_finder_id || undefined;
      }
    } catch (parseErr: any) {
      logger.warn({ err: parseErr.message }, '[Phase1] Failed to parse post_list request body for finder_id');
    }

    if (finderId) {
      await db.syncPlatformAuthorId(userId, finderId);
      logger.info({ userId, finderId }, '[Phase1] Synced tencent finder_id as platform author ID');
    }

    // 翻页加载：视频号通过滚动页面触发下一页，响应携带 continueFlag 和 lastBuff 分页字段
    const allRawVideos: TencentVideoInfo[] = [...(intercepted?.body?.data?.list || [])];
    let continueFlag = intercepted?.body?.data?.continueFlag;
    let lastBuff = intercepted?.body?.data?.lastBuff || '';
    let pageNum = 1;

    while (continueFlag === 1 && allRawVideos.length < this.maxMonitorVideos * 1.5 && pageNum < 10) {
      // 滚动页面触发下一页加载
      await HumanActions.humanScroll(page, 600, { minPause: 500, maxPause: 1000 });
      await HumanActions.wait(page, 2000, 3000);

      const nextIntercepted = await this.interceptor.waitForResponse(POST_LIST_PATTERN, 10000);
      if (!nextIntercepted) break;

      const nextVideos: TencentVideoInfo[] = nextIntercepted?.body?.data?.list || [];
      allRawVideos.push(...nextVideos);
      continueFlag = nextIntercepted?.body?.data?.continueFlag;
      lastBuff = nextIntercepted?.body?.data?.lastBuff || '';
      pageNum++;

      logger.info({ pageVideos: nextVideos.length, totalVideos: allRawVideos.length, continueFlag, pageNum }, '[Phase1] Tencent video list page loaded');
    }

    // 去重（翻页可能产生重复的 exportId）
    const seenExportIds = new Set<string>();
    const videos: TencentVideoInfo[] = allRawVideos.filter(v => {
      if (seenExportIds.has(v.exportId)) return false;
      seenExportIds.add(v.exportId);
      return true;
    });

    logger.info({ userId, videoCount: videos.length, totalRaw: allRawVideos.length, intercepted: !!intercepted }, '[Phase1] Videos fetched');

    // 检测会话失效：拦截器超时或返回空列表，且之前有视频记录
    if (videos.length === 0) {
      const dbVideosForCheck = await db.getVideosByUserId(userId);
      if (dbVideosForCheck.length > 0 || !intercepted) {
        // 之前有视频但现在返回 0，或拦截器完全没捕获到响应 —— 可能是会话过期
        logger.warn({ userId, dbVideoCount: dbVideosForCheck.length, intercepted: !!intercepted }, '[Phase1] Possible session expired — no API data captured');
        // 检查页面内容
        const bodyText = await HumanActions.cdpGetBodyText(page);
        // 收紧关键词：'登录' 太宽泛（正常平台页面也有），改为更具体的短语
        if (bodyText.includes('扫码登录') || bodyText.includes('重新登录') || bodyText.includes('已过期')
          || bodyText.includes('已退出') || bodyText.includes('二维码')) {
          logger.error('[Phase1] Session expired detected from page content');
          // 保存场景截图用于排查
          await this.captureRiskScene(page, userId, 'session_expired');
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

    // 动态剔除：已入库视频变为非公开时从数据库删除
    for (const dbVideo of dbVideos) {
      const freshVideo = videos.find(v => v.exportId.replace(/\//g, '_') === dbVideo.id);
      if (!freshVideo) {
        // 视频不在新列表中，可能已删除或变为非公开
        continue;
      }
      if (freshVideo.visibleType !== undefined && freshVideo.visibleType !== 1) {
        logger.info({ exportId: freshVideo.exportId, visibleType: freshVideo.visibleType }, '[Phase1] 已入库视频变为非公开，剔除');
        await prisma.video.delete({ where: { id: dbVideo.id } });
      }
    }

    const commentsQueue: CommentQueueItem[] = [];

    // 先过滤非公开和评论已关闭的视频，再截断到 maxMonitorVideos
    const filteredVideos = videos.filter(video => {
      if (video.commentClose === 1) {
        logger.debug({ exportId: video.exportId }, '[Phase1] Skipping video with comments closed');
        return false;
      }
      if (video.visibleType !== undefined && video.visibleType !== 1) {
        logger.info({ exportId: video.exportId, visibleType: video.visibleType }, '[Phase1] 过滤非公开视频（visibleType!=1）');
        return false;
      }
      return true;
    }).slice(0, this.maxMonitorVideos);

    for (const video of filteredVideos) {
      const encodedId = video.exportId.replace(/\//g, '_');
      const dbVideo = dbVideos.find(v => v.id === encodedId);
      const newCount = video.commentCount ?? 0;

      if (!dbVideo) {
        // 跨用户保护：视频可能已被其他用户首次爬取入库
        const existingVideo = await prisma.video.findUnique({ where: { id: video.exportId } });
        if (existingVideo && existingVideo.userId !== userId) {
          logger.warn({
            awemeId: video.exportId,
            ownerUserId: existingVideo.userId,
            currentUserId: userId,
          }, '[Phase1] Video already exists under another user — skipping to prevent cross-user data leak');
          continue;
        }
        // 新视频
        if (newCount > 0) {
          commentsQueue.push({
            exportId: video.exportId.replace(/\//g, '_'),
            description: video.desc?.description || '',
            createTime: video.createTime,
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
          exportId: video.exportId.replace(/\//g, '_'),
          description: video.desc?.description || '',
          createTime: video.createTime,
          oldCount: dbVideo.commentCount,
          newCount,
          isFirstCrawl: false,
          _userId: userId,
        });
      }
    }

    // 保存视频到数据库（使用已过滤截断的列表）
    const videoInfos = filteredVideos.map(v => ({
      aweme_id: v.exportId.replace(/\//g, '_'), // URL安全编码，/ → _
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
    await db.reconcileVideosForUser(userId, videoInfos, this.maxMonitorVideos);

    this.unregisterListener();

    logger.info({ userId, queueLength: commentsQueue.length }, '[Phase1] Check complete');

    return {
      hasUpdate: commentsQueue.length > 0,
      commentsQueue,
      updatedVideos: filteredVideos.map(v => ({
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
      username: raw.username || '',
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
    createTime: number,
    userId: number,
    clearPrevious: boolean = true,
  ): Promise<{ success: boolean; allComments: any[]; error?: string }> {
    logger.info({ exportId, videoTitle, createTime, clearPrevious }, '[Phase3:Collect] Starting comment collection');

    // 清除之前捕获的评论数据
    if (clearPrevious) {
      this.interceptor.clear(COMMENT_LIST_PATTERN);
    }

    // ── 步骤0: 滚动视频列表找到目标视频（瀑布流可能未加载目标视频）──
    const videoFound = await this.scrollToFindVideo(page, videoTitle, createTime);
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
    // 查询作者 ID 用于 isAuthor 判断
    const tencentUser = await db.getUserById(userId);
    const tencentAuthorId = tencentUser?.platformAuthorId;

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
          user_uid: apiRoot.username || '',
          create_time: parseInt(apiRoot.commentCreatetime) || 0,
          like_count: apiRoot.commentLikeCount || 0,
          reply_count: (apiRoot.levelTwoComment || []).length,
          export_id: exportId,
          is_author: tencentAuthorId ? String(apiRoot.username) === String(tencentAuthorId) : false,
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
            user_uid: sub.username || '',
            create_time: parseInt(sub.commentCreatetime) || 0,
            like_count: sub.commentLikeCount || 0,
            reply_count: 0,
            export_id: exportId,
            is_author: tencentAuthorId ? String(sub.username) === String(tencentAuthorId) : false,
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
   *
   * 使用时间戳 + description 双重匹配提高准确性。
   */
  private async scrollToFindVideo(page: Page, videoTitle: string, createTime: number): Promise<boolean> {
    const MAX_SCROLLS = 20;
    const TIMESTAMP_TOLERANCE = 60;

    logger.info({ videoTitle, createTime }, '[Tencent] Searching for target video in sidebar');

    for (let scrollAttempt = 0; scrollAttempt <= MAX_SCROLLS; scrollAttempt++) {
      // 在 shadow DOM 中查找匹配的视频
      const matchResult = await page.evaluate(({ title, createTimeNum, tolerance }: { title: string; createTimeNum: number; tolerance: number }) => {
        const app = document.querySelector('wujie-app');
        if (!app?.shadowRoot) return { found: false, reason: 'no shadow root' };

        const wraps = app.shadowRoot.querySelectorAll('.comment-feed-wrap');
        for (const wrap of wraps) {
          const titleEl = wrap.querySelector('.feed-title');
          const timeEl = wrap.querySelector('.feed-time');
          const titleText = titleEl?.textContent?.trim() || '';
          const timeText = timeEl?.textContent?.trim() || '';
          const fullText = titleText + ' ' + timeText;

          // 解析时间（视频号格式：2026/06/13 13:58）
          const dateMatch = timeText.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
          if (!dateMatch) continue;
          const [, y, m, d, h, min] = dateMatch;
          const domTimestamp = Math.floor(new Date(`${y}-${m}-${d}T${h}:${min}:00+08:00`).getTime() / 1000);

          // 时间差判断
          if (Math.abs(domTimestamp - createTimeNum) > tolerance) continue;

          // description 前缀匹配
          const descPrefix = title.toLowerCase().substring(0, 10);
          if (descPrefix.length > 0 && !fullText.toLowerCase().includes(descPrefix)) continue;

          // 匹配成功，点击
          (wrap as HTMLElement).click();
          return { found: true, domTimestamp, title: titleText.substring(0, 50) };
        }
        return { found: false };
      }, { title: videoTitle, createTimeNum: createTime, tolerance: TIMESTAMP_TOLERANCE });

      if (matchResult.found) {
        logger.info({ videoTitle, domTimestamp: matchResult.domTimestamp, createTime, matchType: 'timestamp+description' }, '[Tencent] 匹配成功');
        return true;
      }

      // 未匹配，滚动加载更多
      if (scrollAttempt < MAX_SCROLLS) {
        logger.info({ scrollAttempt }, '[Tencent] 未匹配，滚动加载更多');
        await this.scrollShadowContainer(page, '.feeds-container', 500, 4);
      }
    }

    logger.warn({ videoTitle, maxScrolls: MAX_SCROLLS }, '[Tencent] 滚动穷尽仍未匹配');
    return false;
  }

  // ════════════════════════════════════════
  // 简单模式 Phase3：仅采集根评论（最多 30 条）
  // ════════════════════════════════════════

  /**
   * 收集当前拦截到的所有 comment_list API 响应
   */
  private async collectAllCommentResponses(page: Page): Promise<any[]> {
    return this.interceptor.getResponses(COMMENT_LIST_PATTERN);
  }

  /**
   * 滚动评论区容器（wujie shadow DOM）
   */
  private async scrollCommentArea(page: Page, direction: 'bottom' | 'top' | number): Promise<boolean> {
    if (direction === 'bottom') {
      return this.scrollShadowContainer(page, '.feed-comment__wrp', 500, 4);
    } else if (direction === 'top') {
      return this.scrollShadowContainer(page, '.feed-comment__wrp', -500, 4);
    } else {
      return this.scrollShadowContainer(page, '.feed-comment__wrp', Math.abs(direction), 3);
    }
  }

  /**
   * 简单模式 Phase3：仅采集根评论（最多 30 条）
   * 使用纯 CID 去重，不采集子评论内容
   */
  async processCommentsQueueSimple(
    page: Page,
    queue: CommentQueueItem[],
    maxRootComments: number = 30,
  ): Promise<void> {
    for (const item of queue) {
      logger.info({ exportId: item.exportId, maxRootComments }, '[Simple] Starting simple mode comment collection');

      // ── 清空拦截器中旧的评论响应 ──
      this.interceptor.clear(COMMENT_LIST_PATTERN);

      // ── 在视频列表中滚动查找并点击目标视频 ──
      const videoFound = await this.scrollToFindVideo(page, item.description, item.createTime);
      if (!videoFound) {
        logger.warn({ exportId: item.exportId }, '[Simple] Target video not found, trying first video');
        await this.clickFirstVideoInCommentPage(page);
      } else {
        const videoClicked = await this.clickVideoInCommentPage(page, item.description);
        if (!videoClicked) {
          logger.warn({ exportId: item.exportId }, '[Simple] Failed to click video after scroll, trying first video');
          await this.clickFirstVideoInCommentPage(page);
        }
      }

      // ── 等待 API 响应 ──
      await HumanActions.wait(page, 3000, 5000);

      // 1. 获取已有的根评论 CID 集合
      const existingCids = await prisma.comment.findMany({
        where: { videoId: item.exportId, level: 1 },
        select: { cid: true },
      });
      const existingCidSet = new Set(existingCids.map(c => c.cid));

      // 2. 滚动加载根评论
      const allComments: any[] = [];
      let consecutiveNoNew = 0;
      let hasMore = true;

      while (hasMore && allComments.length < maxRootComments && consecutiveNoNew < 5) {
        // 获取当前拦截到的 API 响应
        const responses = await this.collectAllCommentResponses(page);

        if (responses.length === 0) {
          consecutiveNoNew++;
          logger.info({ exportId: item.exportId, consecutiveNoNew }, '[Simple] No API response, incrementing counter');
          continue;
        }

        // 提取根评论（视频号 API 格式：body.data.comment）
        const newComments = responses.flatMap(r => r.body?.data?.comment || [])
          .filter((c: any) => !existingCidSet.has(c.commentId));

        if (newComments.length === 0) {
          consecutiveNoNew++;
        } else {
          consecutiveNoNew = 0;
          allComments.push(...newComments);
        }

        // 检查 has_more（视频号：data.downContinueFlag !== 0）
        const lastResp = responses[responses.length - 1];
        hasMore = lastResp?.body?.data?.downContinueFlag !== 0;

        // 继续滚动
        if (hasMore && allComments.length < maxRootComments) {
          await this.scrollCommentArea(page, 'bottom');
          await HumanActions.wait(page, 8000, 8000);
        }
      }

      // 3. 限制到 maxRootComments
      const commentsToStore = allComments.slice(0, maxRootComments);

      // 4. 存储新评论
      if (commentsToStore.length > 0) {
        for (const comment of commentsToStore) {
          await db.upsertComment(item.exportId, {
            cid: comment.commentId,
            text: comment.commentContent || '',
            user_nickname: comment.commentNickname || '',
            user_uid: comment.username || '',
            digg_count: comment.commentLikeCount || 0,
            create_time: parseInt(comment.commentCreatetime) || 0,
            reply_id: '0',
            is_author: false,
          });
        }

        logger.info({
          exportId: item.exportId,
          newCount: commentsToStore.length,
          totalCollected: allComments.length,
        }, '[Simple] Stored new root comments');

        // 5. 触发企微通知
        await this.notifyNewComments(item.exportId, commentsToStore);
      } else {
        logger.info({ exportId: item.exportId }, '[Simple] No new root comments found');
      }
    }
  }

  /**
   * 通知新评论（复用现有逻辑）
   */
  private async notifyNewComments(exportId: string, comments: any[]): Promise<void> {
    try {
      const { monitorService } = await import('../services/monitorService');
      await monitorService.notifyNewComments(exportId, comments);
    } catch (err: any) {
      logger.error({ exportId, err: err.message }, '[Simple] Failed to notify new comments');
    }
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
          // 保存场景截图用于排查
          await this.captureRiskScene(page, userId, riskCheck.type);
          results.push({ exportId: item.exportId, success: false, comments: [], error: 'Risk control detected' });
          break;
        }

        // 视频切换在 collectVideoComments 中通过 clickVideoInCommentPage 完成

        // 采集该视频的完整评论树
        // 第一个视频不清除拦截器数据（保留 Phase2 导航时捕获的初始 comment_list 响应）
        const collectResult = await this.collectVideoComments(
          page, item.exportId, item.description, item.createTime, userId, i > 0
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

    // 先检查目标视频是否已经选中（遍历所有 wujie-app）
    const alreadyActive = await page.evaluate((title: string) => {
      const apps = document.querySelectorAll('wujie-app');
      for (const app of apps) {
        const sr = app.shadowRoot;
        if (!sr) continue;
        const activeFeed = sr.querySelector('.comment-feed-wrap.active-feed');
        if (!activeFeed) continue;
        const activeTitle = activeFeed.querySelector('.feed-title')?.textContent?.trim() || '';
        if (activeTitle === title || activeTitle.includes(title.slice(0, 8))) return true;
      }
      return false;
    }, videoTitle);

    if (alreadyActive) {
      logger.info({ videoTitle }, '[Reply:SwitchVideo] Video already active');
      return true;
    }

    // 滚动视频列表找到目标视频（遍历所有 wujie-app）
    const MAX_SCROLLS = 15;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      const rect = await page.evaluate((title: string) => {
        const apps = document.querySelectorAll('wujie-app');
        for (const app of apps) {
          const sr = app.shadowRoot;
          if (!sr) continue;
          const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap'));
          const target = (feeds as Element[]).find((f: Element) => {
            const t = f.querySelector('.feed-title')?.textContent?.trim() || '';
            return t === title || t.includes(title.slice(0, 8));
          });
          if (target) return (target as Element).getBoundingClientRect();
        }
        return null;
      }, videoTitle);

      if (rect) {
        // scrollIntoView 确保完全可见
        await page.evaluate((title: string) => {
          const apps = document.querySelectorAll('wujie-app');
          for (const app of apps) {
            const sr = app.shadowRoot;
            if (!sr) continue;
            const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap')) as Element[];
            const target = feeds.find((f) => {
              const t = f.querySelector('.feed-title')?.textContent?.trim() || '';
              return t === title || t.includes(title.slice(0, 8));
            });
            if (target) { (target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
          }
        }, videoTitle);
        await HumanActions.wait(page, 500, 1000);

        // 重新获取滚动后的坐标
        const newRect = await page.evaluate((title: string) => {
          const apps = document.querySelectorAll('wujie-app');
          for (const app of apps) {
            const sr = app.shadowRoot;
            if (!sr) continue;
            const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap')) as Element[];
            const target = feeds.find((f) => {
              const t = f.querySelector('.feed-title')?.textContent?.trim() || '';
              return t === title || t.includes(title.slice(0, 8));
            });
            if (target) return (target as Element).getBoundingClientRect();
          }
          return null;
        }, videoTitle);

        const clickRect = newRect || rect;
        const cx = clickRect.x + clickRect.width / 2;
        const cy = clickRect.y + clickRect.height / 2;
        await HumanActions.cdpIdleMove(page, cx, cy);
        await HumanActions.wait(page, 200, 400);
        await HumanActions.clickAtCoordinates(page, cx, cy);

        await HumanActions.wait(page, 3000, 5000);

        // 验证是否切换成功
        const commentListChanged = await page.evaluate((title: string) => {
          const apps = document.querySelectorAll('wujie-app');
          for (const app of apps) {
            const sr = app.shadowRoot;
            if (!sr) continue;
            const activeFeed = sr.querySelector('.comment-feed-wrap.active-feed');
            if (!activeFeed) continue;
            const activeTitle = activeFeed.querySelector('.feed-title')?.textContent?.trim() || '';
            if (activeTitle === title || activeTitle.includes(title.slice(0, 8))) return true;
          }
          return false;
        }, videoTitle);

        if (commentListChanged) {
          logger.info({ videoTitle }, '[Reply:SwitchVideo] Video switched successfully (verified)');
          return true;
        }

        // 回退：evaluate 直接点击
        logger.warn({ videoTitle }, '[Reply:SwitchVideo] CDP click did not trigger switch, falling back to evaluate click');
        await page.evaluate((title: string) => {
          const apps = document.querySelectorAll('wujie-app');
          for (const app of apps) {
            const sr = app.shadowRoot;
            if (!sr) continue;
            const feeds = Array.from(sr.querySelectorAll('.comment-feed-wrap')) as Element[];
            const target = feeds.find((f) => {
              const t = f.querySelector('.feed-title')?.textContent?.trim() || '';
              return t === title || t.includes(title.slice(0, 8));
            });
            if (target) { (target as HTMLElement).click(); return; }
          }
        }, videoTitle);

        await HumanActions.wait(page, 3000, 5000);
        logger.info({ videoTitle }, '[Reply:SwitchVideo] Video clicked via evaluate fallback');
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

  // ════════════════════════════════════════
  // 回复辅助方法（定位根评论/子评论、展开子评论）
  // ════════════════════════════════════════

  /**
   * 在根评论中定位回复图标的坐标
   * 根评论 = .scroll-list > div > .comment-item > .comment-item-main
   * 通过 username + text 精确匹配
   */
  private async findReplyIconInRootComment(
    page: Page,
    username: string,
    text: string,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    // 诊断：dump 当前 DOM 中的评论列表
    try {
      const comments = await page.evaluate(() => {
        const apps = document.querySelectorAll('wujie-app');
        const list: any[] = [];
        for (const app of apps) {
          const sr = app.shadowRoot;
          if (!sr) continue;
          const scrollList = sr.querySelector('.feed-comment__wrp .scroll-list');
          if (!scrollList) continue;
          const rootItems = scrollList.querySelectorAll(':scope > div > .comment-item');
          for (const item of rootItems) {
            const main = item.querySelector(':scope > .comment-item-main');
            if (!main) continue;
            const uname = main.querySelector('.comment-user-name')?.textContent?.trim() || '';
            const content = main.querySelector('.comment-content')?.textContent?.trim() || '';
            list.push({ username: uname, text: content.slice(0, 50) });
          }
        }
        return list;
      });
      logger.info({ commentCount: comments.length, first5: comments.slice(0, 5) }, '[Reply] DOM diagnostic: root comments in DOM');
    } catch {}

    const rect = await page.evaluate((params: { username: string; text: string }) => {
      const apps = document.querySelectorAll('wujie-app');
      for (const app of apps) {
        const sr = app.shadowRoot;
        if (!sr) continue;
        const scrollList = sr.querySelector('.feed-comment__wrp .scroll-list');
        if (!scrollList) continue;
        const rootItems = scrollList.querySelectorAll(':scope > div > .comment-item');
        for (const item of rootItems) {
          const main = item.querySelector(':scope > .comment-item-main');
          if (!main) continue;
          const uname = main.querySelector('.comment-user-name')?.textContent?.trim() || '';
          const content = main.querySelector('.comment-content')?.textContent?.trim() || '';
          if (uname === params.username && content === params.text) {
            const replyIcon = main.querySelector('.action-icon.weui-icon-outlined-comment');
            if (replyIcon) {
              const r = replyIcon.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              }
            }
          }
        }
      }
      return null;
    }, { username, text });

    if (rect) {
      logger.info({ x: rect.x, y: rect.y, username, text: text.slice(0, 30) }, '[Reply] Found reply icon in root comment');
    } else {
      logger.warn({ username, text: text.slice(0, 30) }, '[Reply] Root comment not found by username+text');
    }
    return rect;
  }

  /**
   * 在子评论中定位回复图标的坐标
   * 流程：定位根评论 → 展开子评论 → 在子评论中匹配目标
   */
  private async findReplyIconInSubComment(
    page: Page,
    target: TencentReplyTarget,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const rootUsername = target.rootUsername || '';
    const rootText = target.rootText || '';
    const subUsername = target.username;
    const subText = target.text;

    // Step 1: 定位根评论并滚动到可见区域
    const rootFound = await this.scrollRootCommentIntoView(page, rootUsername, rootText);
    if (!rootFound) {
      logger.warn({ rootUsername, rootText: rootText.slice(0, 30) }, '[Reply] Root comment not found for sub-reply');
      return null;
    }

    // Step 2: 展开子评论（点击"展开更多回复"）
    await this.expandSubRepliesForReply(page, rootUsername, rootText);

    // Step 2.5: 诊断 — dump 根评论的完整 DOM 结构（看子评论容器到底叫什么）
    try {
      const rootDomInfo = await page.evaluate((params: { username: string; text: string }) => {
        const apps = document.querySelectorAll('wujie-app');
        for (const app of apps) {
          const sr = app.shadowRoot;
          if (!sr) continue;
          const scrollList = sr.querySelector('.feed-comment__wrp .scroll-list');
          if (!scrollList) continue;
          const rootItems = scrollList.querySelectorAll(':scope > div > .comment-item');
          for (const item of rootItems) {
            const main = item.querySelector(':scope > .comment-item-main');
            if (!main) continue;
            const uname = main.querySelector('.comment-user-name')?.textContent?.trim() || '';
            const content = main.querySelector('.comment-content')?.textContent?.trim() || '';
            if (uname !== params.username || content !== params.text) continue;

            // 找到根评论，dump 所有子元素信息
            const children: any[] = [];
            const childArr = Array.from(item.children) as Element[];
            for (const child of childArr) {
              const cls = (child.className || '').toString();
              const tag = child.tagName;
              const text = (child.textContent || '').trim().slice(0, 80);
              children.push({ tag, cls: cls.slice(0, 80), text });
            }
            // 也 dump main 的兄弟元素
            const siblings: any[] = [];
            let sib = main.nextElementSibling;
            while (sib) {
              const cls = (sib.className || '').toString();
              const tag = sib.tagName;
              const text = (sib.textContent || '').trim().slice(0, 80);
              siblings.push({ tag, cls: cls.slice(0, 80), text });
              sib = sib.nextElementSibling;
            }
            // dump main 内的按钮/可点击元素
            const buttons: any[] = [];
            const btns = item.querySelectorAll('button, [class*="load"], [class*="more"], [class*="expand"], [class*="reply"]');
            const btnArr = Array.from(btns) as Element[];
            for (const btn of btnArr) {
              const cls = (btn.className || '').toString();
              const text = (btn.textContent || '').trim().slice(0, 60);
              const r = btn.getBoundingClientRect();
              buttons.push({ tag: btn.tagName, cls: cls.slice(0, 60), text, visible: r.width > 0 && r.height > 0 });
            }
            return { children, siblings, buttons, itemOuterHTML: item.outerHTML.slice(0, 500) };
          }
        }
        return null;
      }, { username: rootUsername, text: rootText });

      logger.info({ rootDomInfo }, '[Reply] Root comment DOM structure diagnostic');
    } catch (e) {
      logger.warn({ error: String(e) }, '[Reply] DOM structure diagnostic failed');
    }

    // Step 3: 在子评论中定位目标（遍历所有 wujie-app）
    // 先 dump 所有子评论用于诊断，再用模糊匹配定位
    const result = await page.evaluate((params: {
      rootUsername: string; rootText: string;
      subUsername: string; subText: string;
    }) => {
      const apps = document.querySelectorAll('wujie-app');
      const diag: any[] = [];  // 诊断信息
      for (const app of apps) {
        const sr = app.shadowRoot;
        if (!sr) continue;
          const scrollList = sr.querySelector('.feed-comment__wrp .scroll-list');
        if (!scrollList) continue;
        const rootItems = scrollList.querySelectorAll(':scope > div > .comment-item');
        for (const item of rootItems) {
          const main = item.querySelector(':scope > .comment-item-main');
          if (!main) continue;
          const uname = main.querySelector('.comment-user-name')?.textContent?.trim() || '';
          const content = main.querySelector('.comment-content')?.textContent?.trim() || '';
          if (uname !== params.rootUsername || content !== params.rootText) continue;

          // 找到根评论，在 .comment-reply-list 中找子评论
          // ★ .comment-reply-list 不是 .comment-item 的直接子元素，嵌套在 .comment-item-main 内部
          // 所以不能用 :scope > .comment-reply-list，要搜索所有后代并找可见的那个
          const allReplyLists = item.querySelectorAll('.comment-reply-list');
          let replyList: Element | null = null;
          for (const rl of Array.from(allReplyLists) as Element[]) {
            const r = rl.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { replyList = rl; break; }
          }
          if (!replyList) { diag.push({ rootFound: true, hasReplyList: false, totalReplyLists: allReplyLists.length }); continue; }
          // 子评论也是 .comment-item，但可能在 .comment-reply-list 下不同层级
          const subItems = replyList.querySelectorAll('.comment-item');
          diag.push({ rootFound: true, hasReplyList: true, subCount: subItems.length });

          for (const subItem of subItems) {
            // 子评论的 .comment-item-main 可能也不是直接子元素
            const subMain = subItem.querySelector('.comment-item-main') || subItem;
            const subUname = subMain.querySelector('.comment-user-name')?.textContent?.trim() || '';
            const rawContent = subMain.querySelector('.comment-content')?.textContent?.trim() || '';
            // 子评论可能带 "回复 @xxx: " 前缀，去掉后再匹配
            const stripped = rawContent.replace(/^回复\s*@\S+[:：]\s*/, '').trim();
            diag.push({ subUname, rawContent: rawContent.slice(0, 60), stripped: stripped.slice(0, 60) });

            // 匹配策略：精确 → 去前缀 → includes
            const unameMatch = subUname === params.subUsername;
            const exactMatch = unameMatch && rawContent === params.subText;
            const strippedMatch = unameMatch && stripped === params.subText;
            const includesMatch = unameMatch && (rawContent.includes(params.subText) || stripped.includes(params.subText));

            if (exactMatch || strippedMatch || includesMatch) {
              const replyIcon = subMain.querySelector('.action-icon.weui-icon-outlined-comment');
              if (replyIcon) {
                // ★ 子评论可能在视口外（长列表），先滚动到可见区域
                (subMain as HTMLElement).scrollIntoView({ behavior: 'instant', block: 'center' });
                const r = replyIcon.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, diag };
                }
              }
            }
          }
        }
      }
      return { rect: null, diag };
    }, { rootUsername, rootText, subUsername, subText });

    // 输出诊断日志
    logger.info({ subComments: result.diag }, '[Reply] Sub-comment DOM diagnostic');

    if (result.rect) {
      logger.info({ x: result.rect.x, y: result.rect.y, subUsername, subText: subText.slice(0, 30) }, '[Reply] Found reply icon in sub-comment');
    } else {
      logger.warn({ subUsername, subText: subText.slice(0, 30), diag: result.diag }, '[Reply] Sub-comment not found');
    }
    return result.rect;
  }

  /**
   * 滚动评论列表找到目标根评论并使其可见
   */
  private async scrollRootCommentIntoView(
    page: Page,
    rootUsername: string,
    rootText: string,
  ): Promise<boolean> {
    // 诊断：dump wujie-app 和评论结构信息
    try {
      const diag = await page.evaluate(() => {
        const apps = document.querySelectorAll('wujie-app');
        const info: any[] = [];
        for (const app of apps) {
          const sr = app.shadowRoot;
          if (!sr) { info.push({ hasShadow: false }); continue; }
          const sl = sr.querySelector('.feed-comment__wrp .scroll-list');
          if (!sl) { info.push({ hasShadow: true, hasScrollList: false }); continue; }
          const items = sl.querySelectorAll(':scope > div > .comment-item');
          const firstMain = sl.querySelector('.comment-item-main');
          const firstUname = firstMain?.querySelector('.comment-user-name')?.textContent?.trim() || '';
          const firstContent = firstMain?.querySelector('.comment-content')?.textContent?.trim() || '';
          info.push({
            hasShadow: true, hasScrollList: true,
            rootItemCount: items.length,
            firstUname, firstContent: firstContent.slice(0, 50),
          });
        }
        return info;
      });
      logger.info({ wujieApps: diag }, '[Reply] DOM diagnostic: wujie-app shadow roots');
    } catch {}

    const MAX_SCROLLS = 10;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      const found = await page.evaluate((params: { username: string; text: string }) => {
        const apps = document.querySelectorAll('wujie-app');
        for (const app of apps) {
          const sr = app.shadowRoot;
          if (!sr) continue;
          const scrollList = sr.querySelector('.feed-comment__wrp .scroll-list');
          if (!scrollList) continue;
          const rootItems = scrollList.querySelectorAll(':scope > div > .comment-item');
          for (const item of rootItems) {
            const main = item.querySelector(':scope > .comment-item-main');
            if (!main) continue;
            const uname = main.querySelector('.comment-user-name')?.textContent?.trim() || '';
            const content = main.querySelector('.comment-content')?.textContent?.trim() || '';
            if (uname === params.username && content === params.text) {
              const rect = main.getBoundingClientRect();
              if (rect.top >= 0 && rect.bottom <= window.innerHeight) return true;
              (main as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
              return true;
            }
          }
        }
        return false;
      }, { username: rootUsername, text: rootText });

      if (found) {
        await HumanActions.wait(page, 800, 1500);
        logger.info({ rootUsername, scrolls: i }, '[Reply] Root comment scrolled into view');
        return true;
      }

      // 未找到，滚动加载更多评论
      await this.scrollShadowContainer(page, '.feed-comment__wrp', 300);
      await HumanActions.wait(page, 1500, 2500);
    }
    logger.warn({ rootUsername }, '[Reply] Root comment not found after scrolling');
    return false;
  }

  /**
   * 展开根评论的所有子评论（点击"展开更多回复"直到没有更多）
   * 复用 Phase3 采集的策略：cdpClickByText → iframe → shadow DOM evaluate
   * 不需要先定位根评论，因为 scrollRootCommentIntoView 已经把根评论滚到可见区域
   */
  private async expandSubRepliesForReply(
    page: Page,
    _rootUsername: string,
    _rootText: string,
  ): Promise<void> {
    const MAX_EXPAND = 10;
    let consecutiveNoExpand = 0;

    for (let i = 0; i < MAX_EXPAND; i++) {
      // 每 3 轮滚动一下评论区，让未渲染的展开按钮进入视口
      if (i > 0 && i % 3 === 0) {
        await this.scrollShadowContainer(page, '.feed-comment__wrp', 200, 2);
        await HumanActions.wait(page, 800, 1200);
      }

      // 策略1: CDP 坐标点击"展开更多回复"文字
      const clicked = await HumanActions.cdpClickByText(page, '展开更多回复', { timeout: 3000 });

      if (!clicked) {
        if (consecutiveNoExpand === 0) {
          // 第一次失败：滚动后重试 CDP
          await this.scrollShadowContainer(page, '.feed-comment__wrp', 300, 3);
          await HumanActions.wait(page, 1000, 2000);
          const retryClicked = await HumanActions.cdpClickByText(page, '展开更多回复', { timeout: 3000 });
          if (retryClicked) {
            consecutiveNoExpand = 0;
            logger.info({ expandRound: i }, '[Reply] Clicked expand via CDP retry');
            await HumanActions.wait(page, 2000, 3500);
            continue;
          }

          // 策略2: iframe fallback
          const frameClicked = await HumanActions.cdpClickByTextInFrame(
            page, 'interaction', '展开更多回复', { timeout: 3000 }
          );
          if (frameClicked) {
            consecutiveNoExpand = 0;
            logger.info({ expandRound: i }, '[Reply] Clicked expand via iframe fallback');
            await HumanActions.wait(page, 2000, 3500);
            continue;
          }

          // 策略3: shadow DOM evaluate fallback（遍历所有 wujie-app）
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
            consecutiveNoExpand = 0;
            logger.info({ expandRound: i }, '[Reply] Clicked expand via shadow DOM fallback');
            await HumanActions.wait(page, 2000, 3500);
            continue;
          }
        }
        consecutiveNoExpand++;
        if (consecutiveNoExpand >= 2) {
          logger.info({ expandRound: i }, '[Reply] No more expand buttons');
          break;
        }
        await HumanActions.wait(page, 1500, 2500);
        continue;
      }

      consecutiveNoExpand = 0;
      logger.info({ expandRound: i }, '[Reply] Clicked expand button');
      await HumanActions.wait(page, 2000, 3500);
    }
  }

  /**
   * 拟人化回复评论（支持根评论 level=1 和子评论 level=2）
   *
   * level=1：直接定位根评论 → 点击回复图标
   * level=2：定位根评论 → 展开子评论 → 定位子评论 → 点击回复图标
   *
   * 实际 DOM 结构（wujie shadow DOM，无 iframe）:
   * - 根评论容器: .scroll-list > div > .comment-item > .comment-item-main
   * - 子评论容器: .comment-reply-list > .comment-item > .comment-item-main
   * - 回复图标: .action-icon.weui-icon-outlined-comment
   * - 展开按钮: .comment-reply-list > .load-more > .load-more__btn > span "展开更多回复"
   * - 回复输入框: textarea 或 [contenteditable="true"]
   * - 发送按钮: 文字"评论"或"发送"
   */
  async replyToComment(
    page: Page,
    target: TencentReplyTarget,
    replyText: string,
    executionId?: string,
  ): Promise<boolean> {
    const { commentCid, level, username, text } = target;
    logger.info({ commentCid, level, username, textLength: replyText.length }, '[Reply] Starting reply');

    // ── 调试模式初始化 ──
    const debugEnabled = await isDebugModeEnabled();
    let manifest: DebugManifest | null = null;
    let sessionId = '';
    let stepIdx = 0;

    if (debugEnabled) {
      sessionId = createReplySessionId({
        text: target.text || target.commentCid,
        level: target.level,
        createTime: target.createTime || 0,
      });
      manifest = createManifest(sessionId, {
        text: target.text || target.commentCid,
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
      // ★ Bugfix: 注入 esbuild __name polyfill（tsx keepNames:true 会在 evaluate 函数体内注入 __name）
      await this.injectEsbuildPolyfill(page);
      currentPhase = '准备';
      await snap('reply_start');

      // ★ Bugfix: 等待评论列表加载完成（shadow DOM 内的 .comment-item-main）
      // 页面可能已经在评论管理 URL，但评论列表还没渲染
      const commentListReady = await page.locator('wujie-app').locator('.comment-item-main').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
      if (!commentListReady) {
        logger.warn('[Reply] Comment list not loaded within 15s');
        await snap('error', { message: 'Comment list not loaded' });
        if (manifest) finishManifest(manifest, false);
        return false;
      }
      logger.info('[Reply] Comment list loaded');

      // 模拟人类思考时间
      await HumanActions.thinkingPause(page, 800, 2000);

      // 从 selectors.json 动态读取选择器，缺失时回退硬编码默认值
      const reader = getSelectorReader();
      const replyBtnSelectors = reader.getSelectorListWithFallback('tencent', 'buttons', 'btn_comment_reply', [
        '.action-icon.weui-icon-outlined-comment',
        '.action-list .action-item:nth-child(2) .action-icon',
      ]);
      const inputSelectors = reader.getSelectorListWithFallback('tencent', 'regions', 'reply_input', [
        'textarea.create-input',
        '.reply-textarea',
      ]);
      const submitSelectors = reader.getSelectorListWithFallback('tencent', 'buttons', 'btn_reply_submit', [
        '.create-ft .tag-wrap.primary',
        '.submit-reply-btn',
      ]);

      // ★ 使用辅助方法定位回复图标（区分根评论 level=1 / 子评论 level=2）
      // 根评论：直接在 .scroll-list > div > .comment-item 中匹配 username+text
      // 子评论：先定位根评论 → 展开"更多回复" → 在 .comment-reply-list 中匹配
      const wujieRoot = page.locator('wujie-app');
      let replyIconRect: { x: number; y: number; width: number; height: number } | null = null;

      if (level === 1) {
        // level=1：先滚动找到根评论（评论可能不在当前视口），再定位回复图标
        const rootFound = await this.scrollRootCommentIntoView(page, username, text);
        if (rootFound) {
          replyIconRect = await this.findReplyIconInRootComment(page, username, text);
        } else {
          logger.warn({ username, text: text.slice(0, 30) }, '[Reply] Root comment not found after scrolling (level=1)');
        }
      } else {
        replyIconRect = await this.findReplyIconInSubComment(page, target);
      }

      // CSS 选择器回退（如果辅助方法未找到）
      if (!replyIconRect) {
        const cssReplySels = replyBtnSelectors.filter(s => !s.startsWith('text=') && !s.includes('getBy'));
        for (const sel of cssReplySels) {
          try {
            const iconLocator = wujieRoot.locator(sel);
            const cnt = await iconLocator.count();
            if (cnt > 0) {
              const box = await iconLocator.first().boundingBox();
              if (box && box.width > 0) {
                replyIconRect = { x: box.x, y: box.y, width: box.width, height: box.height };
                logger.info({ sel, x: box.x, y: box.y }, '[Reply] Found via CSS fallback');
                break;
              }
            }
          } catch { continue; }
        }
      }

      if (!replyIconRect) {
        await snap('reply_icon_not_found');
        if (manifest) finishManifest(manifest, false);
        logger.error({ commentCid }, '[Reply] Reply icon not found');
        return false;
      }

      currentPhase = '定位评论';
      await snap('reply_icon_found', { x: Math.round(replyIconRect.x), y: Math.round(replyIconRect.y) });

      // CDP 点击回复图标（shadow DOM 内的元素需用坐标点击）
      const replyClickX = replyIconRect.x + replyIconRect.width / 2;
      const replyClickY = replyIconRect.y + replyIconRect.height / 2;
      await HumanActions.cdpIdleMove(page, replyClickX, replyClickY);
      await HumanActions.clickAtCoordinates(page, replyClickX, replyClickY);

      // 等待输入框出现（点击回复按钮后才会出现）
      await HumanActions.wait(page, 800, 1500);

      // ★ 使用 Playwright locator API 查找输入框（textarea 或 contenteditable）
      let inputRect: { x: number; y: number; width: number; height: number } | null = null;

      // 策略 1：找 textarea 元素
      try {
        const textareaLocator = wujieRoot.locator('textarea');
        if (await textareaLocator.first().isVisible()) {
          const box = await textareaLocator.first().boundingBox();
          if (box) {
            inputRect = { x: box.x, y: box.y, width: box.width, height: box.height };
          }
        }
      } catch {}

      // 策略 2：找 contenteditable 元素
      if (!inputRect) {
        try {
          const editableLocator = wujieRoot.locator('[contenteditable="true"]');
          if (await editableLocator.first().isVisible()) {
            const box = await editableLocator.first().boundingBox();
            if (box) {
              inputRect = { x: box.x, y: box.y, width: box.width, height: box.height };
            }
          }
        } catch {}
      }

      // 策略 3：CSS 选择器回退
      if (!inputRect) {
        const cssInputSels = inputSelectors.filter(s => !s.startsWith('text=') && !s.includes('getBy'));
        for (const sel of cssInputSels) {
          try {
            const inputLocator = wujieRoot.locator(sel);
            if (await inputLocator.first().isVisible()) {
              const box = await inputLocator.first().boundingBox();
              if (box) {
                inputRect = { x: box.x, y: box.y, width: box.width, height: box.height };
                break;
              }
            }
          } catch {
            continue;
          }
        }
      }

      if (inputRect) {
        // 点击输入框获取焦点
        const inputX = inputRect.x + inputRect.width / 2;
        const inputY = inputRect.y + inputRect.height / 2;
        await HumanActions.clickAtCoordinates(page, inputX, inputY);
        await HumanActions.wait(page, 300, 600);
      } else {
        // 回退：直接 focus 输入框
        await page.evaluate((params: { inputSels: string[] }) => {
          const root = document.querySelector('wujie-app')?.shadowRoot;
          if (!root) return;
          for (const sel of params.inputSels) {
            if (sel.startsWith('text=') || sel.includes('getBy')) continue;
            const el = root.querySelector(sel);
            if (el) {
              (el as HTMLElement).focus();
              break;
            }
          }
        }, { inputSels: inputSelectors });
        await HumanActions.wait(page, 200, 400);
      }

      currentPhase = '输入回复';
      await snap('input_focused', { inputFound: !!inputRect });

      // 拟人化输入（safeCDPType 使用 CDP keyboard 事件，可穿透 shadow DOM）
      await HumanActions.safeCDPType(page, replyText);
      await HumanActions.wait(page, 500, 1200);
      await snap('text_typed');

      // ★ 使用 Playwright 文本匹配查找发送按钮（支持 shadow DOM）
      let submitRect: { x: number; y: number; width: number; height: number } | null = null;

      // 策略 1：用 getByText 找"发送"或"评论"按钮
      for (const btnText of ['发送', '评论']) {
        try {
          const btn = wujieRoot.getByText(btnText, { exact: true });
          if (await btn.count() > 0) {
            for (let i = 0; i < await btn.count(); i++) {
              if (await btn.nth(i).isVisible()) {
                const box = await btn.nth(i).boundingBox();
                if (box && box.width > 0) {
                  submitRect = { x: box.x, y: box.y, width: box.width, height: box.height };
                  logger.info({ btnText, x: box.x, y: box.y }, '[Reply] Found submit button via getByText');
                  break;
                }
              }
            }
            if (submitRect) break;
          }
        } catch {}
      }

      // 策略 2：CSS 选择器回退
      if (!submitRect) {
        const cssSubmitSels = submitSelectors.filter(s => !s.startsWith('text=') && !s.includes('getBy'));
        for (const sel of cssSubmitSels) {
          try {
            const submitLocator = wujieRoot.locator(sel);
            if (await submitLocator.first().isVisible()) {
              const box = await submitLocator.first().boundingBox();
              if (box) {
                submitRect = { x: box.x, y: box.y, width: box.width, height: box.height };
                break;
              }
            }
          } catch {
            continue;
          }
        }
      }

      let submitted = false;
      if (submitRect) {
        const submitX = submitRect.x + submitRect.width / 2;
        const submitY = submitRect.y + submitRect.height / 2;
        await HumanActions.cdpIdleMove(page, submitX, submitY);
        await HumanActions.clickAtCoordinates(page, submitX, submitY);
        submitted = true;
      } else {
        // 回退：Enter 键发送 (CDP keypress 穿透 shadow DOM)
        logger.warn('[Reply] Submit button not found, trying Enter key');
        await HumanActions.cdpKeyPress(page, 'Enter', 'Enter', 13);
        await HumanActions.wait(page, 500, 1000);
        // ★ Bugfix: 验证 Enter 键是否真的触发了发送（输入框是否消失）
        const inputStillVisible = await page.evaluate(() => {
          const root = document.querySelector('wujie-app')?.shadowRoot;
          if (!root) return false;
          const createWrap = root.querySelector('.comment-create-wrap');
          return createWrap && (createWrap as HTMLElement).offsetHeight > 0;
        });
        if (inputStillVisible) {
          logger.error({ commentCid }, '[Reply] Enter key fallback FAILED - input area still visible');
          await snap('error', { message: 'Enter key fallback failed - input area still visible' });
          if (manifest) finishManifest(manifest, false);
          return false; // ★ 不再静默返回 true
        }
        submitted = true;
      }

      currentPhase = '提交回复';
      await snap('submit_clicked', { submitted });

      // 等待发送完成
      await HumanActions.wait(page, 1500, 3000);

      // 验证发送是否成功（检查回复区域是否消失）
      const replySent = await page.evaluate(() => {
        const root = document.querySelector('wujie-app')?.shadowRoot;
        if (!root) return true; // 无法确认，假设成功
        const createWrap = root.querySelector('.comment-create-wrap');
        // 如果回复输入区域消失，说明发送成功
        return !createWrap || (createWrap as HTMLElement).offsetHeight === 0;
      });

      await snap('verify_result', { replySent, submitted });

      if (replySent) {
        logger.info({ commentCid, submitted }, '[Reply] Reply sent successfully');
      } else {
        logger.warn({ commentCid }, '[Reply] Reply may not have been sent - input area still visible');
      }

      // 模拟发送后的人类行为
      await HumanActions.betweenActionsPause(page);

      if (manifest) finishManifest(manifest, true);
      return true;
    } catch (err: any) {
      await snap('error', { message: err.message });
      if (manifest) finishManifest(manifest, false);
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
