import { chromium, Browser, Page } from 'patchright';
import { Platform } from '../types';
import { HumanActions } from './humanActions';
import { rootLogger } from '../logger';
import { createProxiedPage } from './pageProxy';
import { MaintenanceProbe } from './maintenanceProbe';
import fs from 'fs';
import path from 'path';
const logger = rootLogger.child({ name: 'browserManager' });

// ============================================================
// 多厂商窗口开启器抽象
// ============================================================

/** 窗口开启器接口 — 每个浏览器厂商实现自己的 API */
export interface WindowOpener {
  readonly vendor: string;
  /** 检查窗口是否已打开，返回已有 WS URL（null 表示未打开） */
  getConnectionInfo(windowId: string): Promise<string | null>;
  /** 打开窗口，返回 CDP WebSocket URL */
  openWindow(windowId: string): Promise<string>;
}

/** RoxyBrowser 窗口开启器 */
class RoxyWindowOpener implements WindowOpener {
  readonly vendor = 'roxybrowser';
  private apiHost: string;
  private apiKey: string;

  constructor(apiHost: string, apiKey: string) {
    this.apiHost = apiHost;
    this.apiKey = apiKey;
  }

  async getConnectionInfo(windowId: string): Promise<string | null> {
    const url = `${this.apiHost}/browser/connection_info`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'token': this.apiKey },
      });
      if (!response.ok) return null;
      const result = await response.json() as any;
      if (result.code !== 0 || !result.data) return null;
      const windowInfo = result.data.find((item: any) => item.dirId === windowId);
      return windowInfo?.ws || null;
    } catch (error: any) {
      logger.warn({ windowId, error: error.message }, 'RoxyBrowser getConnectionInfo failed');
      return null;
    }
  }

  async openWindow(windowId: string): Promise<string> {
    const url = `${this.apiHost}/browser/open`;
    logger.info({ windowId, url }, 'Opening browser window via RoxyBrowser API');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'token': this.apiKey },
      body: JSON.stringify({ dirId: windowId, args: [] }),
    });
    if (!response.ok) {
      throw new Error(`RoxyBrowser API request failed: ${response.status} ${response.statusText}`);
    }
    const result = await response.json() as any;
    if (result.code !== 0) {
      throw new Error(`RoxyBrowser API error: ${result.msg} (code: ${result.code})`);
    }
    if (!result.data?.ws) {
      throw new Error('RoxyBrowser API response missing WebSocket endpoint');
    }
    logger.info({ windowId, ws: result.data.ws }, 'Browser window opened successfully via RoxyBrowser');
    return result.data.ws;
  }
}

/** BitBrowser 窗口开启器 */
export class BitWindowOpener implements WindowOpener {
  readonly vendor = 'bitbrowser';
  private apiHost: string;

  constructor(apiHost: string) {
    this.apiHost = apiHost;
  }

  async getConnectionInfo(windowId: string): Promise<string | null> {
    // BitBrowser 没有 connection_info 端点，直接尝试 open（如果已打开会返回现有 WS）
    return null;
  }

  async openWindow(windowId: string): Promise<string> {
    const url = `${this.apiHost}/browser/open`;
    logger.info({ windowId, url }, 'Opening browser window via BitBrowser API');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: windowId }),
    });
    if (!response.ok) {
      throw new Error(`BitBrowser API request failed: ${response.status} ${response.statusText}`);
    }
    const result = await response.json() as any;
    if (result.success === false) {
      throw new Error(`BitBrowser API error: ${result.msg || JSON.stringify(result)}`);
    }
    const ws = result.data?.ws;
    if (!ws) {
      throw new Error('BitBrowser API response missing WebSocket endpoint');
    }
    logger.info({ windowId, ws }, 'Browser window opened successfully via BitBrowser');
    return ws;
  }
}

interface MouseTracePoint {
  x: number;
  y: number;
  timestamp: number;
  type: 'move' | 'down' | 'up' | 'wheel';
  detail?: string;
}

interface UserSession {
  browser: Browser;
  page: Page | null;
  windowId: string;
  platform: Platform;
  connectedAt: number;
  lastActiveAt: number;
  reuseCount: number;
  maxReuse: number;
}

function randomMaxReuse(): number {
  return 15 + Math.floor(Math.random() * 11);
}

export class BrowserManager {
  private apiHost: string;
  private apiKey: string;
  private mouseTraces: MouseTracePoint[] = [];
  private traceLogDir: string;
  private userSessions: Map<string, UserSession> = new Map();
  private debugModeEnabled: boolean = false;
  private openers: Map<string, WindowOpener> = new Map();
  private currentWindowId?: string;
  /** 外部注册的 vendor 解析器：根据 windowId(externalId) 返回 vendor 名称 */
  private vendorResolver: ((windowId: string) => Promise<string | null>) | null = null;

  private maybeProxyPage(page: Page): Page {
    if (MaintenanceProbe.isEnabled()) {
      return createProxiedPage(page, this.currentWindowId ?? 'unknown');
    }
    return page;
  }

  constructor(apiPort: number = 50000, apiKey: string = '') {
    this.apiHost = `http://127.0.0.1:${apiPort}`;
    this.apiKey = apiKey;
    this.traceLogDir = path.resolve(process.cwd(), 'data', 'mouse_traces');
    if (!fs.existsSync(this.traceLogDir)) {
      fs.mkdirSync(this.traceLogDir, { recursive: true });
    }
    // 默认注册 RoxyBrowser 开启器（向后兼容）
    this.openers.set('roxybrowser', new RoxyWindowOpener(this.apiHost, apiKey));
  }

  /** 注册窗口开启器（用于支持多厂商） */
  registerOpener(opener: WindowOpener): void {
    this.openers.set(opener.vendor, opener);
    logger.info({ vendor: opener.vendor }, 'Window opener registered');
  }

  /** 注册 vendor 解析器（从数据库查询 windowId 对应的 vendor） */
  setVendorResolver(resolver: (windowId: string) => Promise<string | null>): void {
    this.vendorResolver = resolver;
  }

  /** 获取指定厂商的开启器（默认回退到 RoxyBrowser） */
  private getOpener(vendor: string = 'roxybrowser'): WindowOpener {
    const opener = this.openers.get(vendor);
    if (!opener) {
      logger.warn({ vendor, available: [...this.openers.keys()] }, 'No opener for vendor, falling back to roxybrowser');
      return this.openers.get('roxybrowser')!;
    }
    return opener;
  }

  /** 解析 windowId 对应的 vendor（优先使用传入值，否则调用 resolver） */
  private async resolveVendor(windowId: string, vendor?: string): Promise<string> {
    if (vendor) return vendor;
    if (this.vendorResolver) {
      try {
        const resolved = await this.vendorResolver(windowId);
        if (resolved) {
          logger.debug({ windowId, vendor: resolved }, 'Vendor resolved from database');
          return resolved;
        }
      } catch (err: any) {
        logger.warn({ windowId, error: err.message }, 'Vendor resolver failed, falling back to roxybrowser');
      }
    }
    return 'roxybrowser';
  }

  setDebugMode(enabled: boolean): void {
    this.debugModeEnabled = enabled;
    logger.info({ enabled }, 'BrowserManager debug mode updated');
  }

  setMaxTabReuse(maxReuse: number): void {
    logger.info({ maxReuse, note: 'Each tab now uses random 15-25 reuse limit' }, 'setMaxTabReuse called (legacy, per-tab random limit is used instead)');
  }

  isDebugMode(): boolean {
    return this.debugModeEnabled;
  }

  recordMouseTrace(point: MouseTracePoint): void {
    if (!this.debugModeEnabled) return;
    this.mouseTraces.push(point);
  }

  getMouseTraces(): MouseTracePoint[] {
    return this.mouseTraces;
  }

  async getBrowser(windowId: string, platform?: Platform, vendor?: string): Promise<Browser | null> {
    const resolvedVendor = await this.resolveVendor(windowId, vendor);
    // 1. 按 platform 精确匹配已有 session
    if (platform) {
      const sessionKey = `${windowId}_${platform}`;
      const session = this.userSessions.get(sessionKey);
      if (session?.browser?.isConnected()) {
        try {
          await Promise.race([
            session.browser.version(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('browser version timeout')), 5000)),
          ]);
          return session.browser;
        } catch {
          this.userSessions.delete(sessionKey);
        }
      }
    }
    // 2. 遍历所有同 windowId 的 session
    for (const [key, session] of this.userSessions) {
      if (key.startsWith(`${windowId}_`) && session.browser?.isConnected()) {
        try {
          await Promise.race([
            session.browser.version(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('browser version timeout')), 5000)),
          ]);
          return session.browser;
        } catch { this.userSessions.delete(key); }
      }
    }
    // 3. 建立新 CDP 连接（握手失败重试一次，应对并发争抢/瞬时握手失败）
    const loginSessionKey = `${windowId}_login`;
    let browser: Browser | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const wsEndpoint = await this.getOrCreateWsEndpoint(windowId, resolvedVendor);
        browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30000 });
        break;
      } catch (err: any) {
        lastErr = err;
        logger.warn({ windowId, attempt, err: err.message }, 'getBrowser: CDP 握手失败，重试');
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!browser) {
      logger.error({ windowId, err: lastErr?.message }, 'getBrowser: CDP 连接失败');
      return null;
    }
    this.userSessions.set(loginSessionKey, {
      browser, page: null, windowId, platform: 'login' as any,
      connectedAt: Date.now(), lastActiveAt: Date.now(),
      reuseCount: 0, maxReuse: 999,
    });
    return browser;
  }

  async connect(windowId: string, spaceId: string, platform: Platform = 'douyin', vendor?: string): Promise<{ browser: Browser; page: Page }> {
    this.currentWindowId = windowId;
    const resolvedVendor = await this.resolveVendor(windowId, vendor);
    const sessionKey = `${windowId}_${platform}`;

    const existingSession = this.userSessions.get(sessionKey);
    if (existingSession && existingSession.browser.isConnected()) {
      try {
        const pages = existingSession.browser.contexts()[0]?.pages() || [];
        const platformPage = await this.findPlatformPage(pages, platform);

        if (platformPage) {
          existingSession.lastActiveAt = Date.now();
          existingSession.reuseCount++;

          // 激活标签页，确保爬虫在前台标签页操作
          try {
            await platformPage.bringToFront();
            logger.info({ windowId, platform }, 'Reused tab brought to front');
          } catch (bringError: any) {
            logger.warn({ windowId, platform, error: bringError.message }, 'Failed to bring reused tab to front');
          }

          // 检测复用页面是否卡死（loading 状态 或 CDP 连接无响应）
          const CDP_HEALTH_CHECK_MS = 8_000; // CDP 健康检查超时
          const PAGE_LOADING_TIMEOUT_MS = 30_000; // 30秒加载超时
          let pageHealthy = true;

          try {
            // 快速检测 1：readyState
            const loadState = await Promise.race([
              platformPage.evaluate(() => document.readyState),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Page readyState check timeout')), 5000)
              ),
            ]);

            if (loadState === 'loading') {
              logger.warn({ windowId, platform, url: platformPage.url() }, 'Reused page stuck in loading state, waiting for load completion');

              await Promise.race([
                platformPage.waitForLoadState('domcontentloaded', { timeout: PAGE_LOADING_TIMEOUT_MS }),
                new Promise<void>((_, reject) =>
                  setTimeout(() => reject(new Error(`Page loading timeout (${PAGE_LOADING_TIMEOUT_MS / 1000}s)`)), PAGE_LOADING_TIMEOUT_MS)
                ),
              ]);

              logger.info({ windowId, platform }, 'Reused page loading completed after wait');
            }

            // 快速检测 2：CDP 连接响应性（即使 readyState 正常，CDP 也可能卡死）
            const cdpAlive = await Promise.race([
              platformPage.evaluate(() => true),
              new Promise<boolean>((_, reject) =>
                setTimeout(() => reject(new Error('CDP connection unresponsive')), CDP_HEALTH_CHECK_MS)
              ),
            ]);

            if (!cdpAlive) {
              pageHealthy = false;
              logger.warn({ windowId, platform, url: platformPage.url() }, 'CDP connection unresponsive — page is stuck');
            }
          } catch (loadErr: any) {
            pageHealthy = false;
            logger.warn({ windowId, platform, error: loadErr.message }, 'Reused page health check failed');
          }

          if (!pageHealthy) {
            logger.warn({ windowId, platform }, 'Closing stuck page and recreating tab');
            try { await platformPage.close(); } catch (closeErr: any) {
              logger.warn({ windowId, error: closeErr.message }, 'Failed to close stuck page');
            }

            const defaultContext = existingSession.browser.contexts()[0];
            const newPage = await defaultContext.newPage();
            existingSession.page = newPage;
            existingSession.reuseCount = 0;
            existingSession.maxReuse = randomMaxReuse();
            existingSession.lastActiveAt = Date.now();

            logger.info({ windowId, platform }, 'Created new tab after reused page loading failure');
            return { browser: existingSession.browser, page: this.maybeProxyPage(newPage) };
          }

          logger.info({ windowId, sessionKey, reuseCount: existingSession.reuseCount, maxReuse: existingSession.maxReuse }, 'Reusing existing platform tab (Keep-Alive)');

          if (existingSession.reuseCount >= existingSession.maxReuse) {
            logger.info({ windowId, sessionKey, reuseCount: existingSession.reuseCount, maxReuse: existingSession.maxReuse }, 'Tab reuse limit reached, rotating to fresh tab');
            try {
              const oldPage = platformPage;
              const defaultContext = existingSession.browser.contexts()[0];
              const newPage = await defaultContext.newPage();
              existingSession.page = newPage;
              existingSession.reuseCount = 0;
              existingSession.maxReuse = randomMaxReuse();

              try {
                await oldPage.close();
                logger.info({ windowId, platform }, 'Old platform tab closed after rotation');
              } catch (closeError: any) {
                logger.warn({ windowId, error: closeError.message }, 'Failed to close old tab during rotation');
              }

              logger.info({ windowId, platform, newMaxReuse: existingSession.maxReuse }, 'New platform tab created for rotation');
              return { browser: existingSession.browser, page: this.maybeProxyPage(newPage) };
            } catch (rotateError: any) {
              logger.warn({ windowId, error: rotateError.message }, 'Tab rotation failed, continuing with existing page');
            }
          }

          existingSession.page = platformPage;
          return { browser: existingSession.browser, page: this.maybeProxyPage(platformPage) };
        }

        logger.info({ windowId, platform }, 'No platform-specific tab found in existing session, creating new tab');
        try {
          const defaultContext = existingSession.browser.contexts()[0];
          const newPage = await defaultContext.newPage();
          existingSession.page = newPage;
          existingSession.reuseCount = 0;
          existingSession.maxReuse = randomMaxReuse();
          existingSession.lastActiveAt = Date.now();

          logger.info({ windowId, platform, newMaxReuse: existingSession.maxReuse }, 'New platform tab created in existing browser');
          return { browser: existingSession.browser, page: this.maybeProxyPage(newPage) };
        } catch (createError: any) {
          logger.warn({ windowId, error: createError.message }, 'Failed to create new tab, reconnecting');
          this.userSessions.delete(sessionKey);
        }
      } catch (error: any) {
        logger.warn({ windowId, error: error.message }, 'Existing session invalid, reconnecting');
        this.userSessions.delete(sessionKey);
      }
    }

    const wsEndpoint = await this.getOrCreateWsEndpoint(windowId, resolvedVendor);

    logger.info({ windowId, wsEndpoint, platform }, 'Connecting to fingerprint browser via CDP');

    let browser: Browser;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        browser = await chromium.connectOverCDP(wsEndpoint, {
          timeout: 30000,
        });

        const contexts = browser.contexts();
        if (contexts.length === 0) {
          throw new Error('No browser contexts available');
        }

        const defaultContext = contexts[0];
        const pages = defaultContext.pages();

        logger.info({ windowId, pageCount: pages.length, pageUrls: pages.map((p: Page) => p.url()), platform }, 'Available pages');

        let page: Page;
        const platformPage = await this.findPlatformPage(pages, platform);

        if (platformPage) {
          page = platformPage;
          logger.info({ windowId, url: page.url(), platform }, 'Found existing platform tab');

          // 检测页面是否卡在加载状态
          const PAGE_LOADING_TIMEOUT_MS = 30_000; // 30秒加载超时
          try {
            const loadState = await Promise.race([
              page.evaluate(() => document.readyState),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Page readyState check timeout')), 5000)
              ),
            ]);

            if (loadState === 'loading') {
              logger.warn({ windowId, platform, url: page.url() }, 'Page stuck in loading state, waiting for load completion');

              // 等待页面加载完成
              await Promise.race([
                page.waitForLoadState('domcontentloaded', { timeout: PAGE_LOADING_TIMEOUT_MS }),
                new Promise<void>((_, reject) =>
                  setTimeout(() => reject(new Error(`Page loading timeout (${PAGE_LOADING_TIMEOUT_MS / 1000}s)`)), PAGE_LOADING_TIMEOUT_MS)
                ),
              ]);

              logger.info({ windowId, platform }, 'Page loading completed after wait');
            }
          } catch (loadErr: any) {
            logger.warn({ windowId, platform, error: loadErr.message }, 'Page loading failed, closing and recreating tab');

            // 关闭卡死的页面并创建新标签页
            try {
              await page.close();
            } catch (closeErr: any) {
              logger.warn({ windowId, error: closeErr.message }, 'Failed to close stuck page');
            }

            page = await defaultContext.newPage();
            logger.info({ windowId, platform }, 'Created new tab after page loading failure');
          }
        } else {
          page = await defaultContext.newPage();
          logger.info({ windowId, platform }, 'Created new tab for platform (no existing tab found)');
        }

        // 激活标签页，确保爬虫在前台标签页操作
        try {
          await page.bringToFront();
          logger.info({ windowId, platform }, 'Tab brought to front after connection');
        } catch (bringError: any) {
          logger.warn({ windowId, platform, error: bringError.message }, 'Failed to bring tab to front');
        }

        this.mouseTraces = [];

        const maxReuse = randomMaxReuse();
        this.userSessions.set(sessionKey, {
          browser,
          page,
          windowId,
          platform,
          connectedAt: Date.now(),
          lastActiveAt: Date.now(),
          reuseCount: 0,
          maxReuse,
        });

        logger.info({ windowId, sessionKey, platform, maxReuse }, 'Connected to fingerprint browser (Keep-Alive session)');

        return { browser, page: this.maybeProxyPage(page) };
      } catch (error: any) {
        lastError = error;
        logger.warn({ windowId, attempt: attempt + 1, error: error.message }, 'Connection attempt failed');

        if (error.message?.includes('Frame was detached') || error.message?.includes('Target closed') || error.message?.includes('Session closed')) {
          this.userSessions.delete(sessionKey);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Failed to connect after retries');
  }

  private async findPlatformPage(pages: Page[], platform: Platform): Promise<Page | undefined> {
    const candidates = pages.filter(p => {
      const url = p.url();
      if (platform === 'kuaishou') return url.includes('kuaishou.com') || url.includes('cp.kuaishou.com');
      if (platform === 'xiaohongshu') return url.includes('xiaohongshu.com') || url.includes('creator.xiaohongshu.com');
      if (platform === 'tencent') return url.includes('channels.weixin.qq.com');
      if (platform === 'pinterest') return url.includes('pinterest.com');
      return url.includes('douyin.com') || url.includes('creator.douyin.com');
    });

    // 排除登录标签页（有 __login_tab_mark__ 标记的不作为工作标签页）
    // 同时排除仍在 passport 域名的标签页（登录跳转前的页面）
    for (const p of candidates) {
      try {
        const url = p.url();
        // C3: 跳过 passport 域名的页面（如 passport.kuaishou.com）
        if (url.includes('passport.')) continue;

        const isLoginTab = await p.evaluate(() =>
          !!localStorage.getItem('__login_tab_mark__')
        );
        if (!isLoginTab) return p;
      } catch { continue; }
    }

    // C1: 所有候选都是登录标签页时，返回 undefined（不返回 candidates[0]）
    // 让 connect() 走新建标签页分支
    return undefined;
  }

  async focusPage(windowId: string, platform: Platform = 'douyin'): Promise<Page | null> {
    const sessionKey = `${windowId}_${platform}`;
    const session = this.userSessions.get(sessionKey);

    if (!session || !session.browser.isConnected()) {
      return null;
    }

    try {
      const pages = session.browser.contexts()[0]?.pages() || [];
      const page = await this.findPlatformPage(pages, platform) || pages[0];

      if (page) {
        try {
          await page.bringToFront();
        } catch {}
        session.lastActiveAt = Date.now();
        return page;
      }
    } catch (error: any) {
      logger.warn({ windowId, error: error.message }, 'Failed to focus page');
    }

    return null;
  }

  async injectIdleBehavior(windowId: string, platform: Platform = 'douyin'): Promise<void> {
    const sessionKey = `${windowId}_${platform}`;
    const session = this.userSessions.get(sessionKey);

    if (!session || !session.browser.isConnected()) return;

    try {
      const pages = session.browser.contexts()[0]?.pages() || [];
      const page = await this.findPlatformPage(pages, platform) || session.page;
      if (!page) return;
      const roll = Math.random();

      if (roll < 0.3) {
        try {
          const vp = page.viewportSize();
          if (vp) {
            const x = 50 + Math.random() * (vp.width - 100);
            const y = 100 + Math.random() * (vp.height - 200);
            await HumanActions.cdpIdleMove(page, x, y);
          }
        } catch {}
      } else if (roll < 0.6) {
        await HumanActions.cdpIdleWheel(page, (Math.random() - 0.5) * 60);
      }

      logger.debug({ windowId, platform }, 'Idle behavior injected');
    } catch (error: any) {
      logger.debug({ windowId, error: error.message }, 'Idle behavior injection failed');
    }
  }

  async disconnectSession(windowId: string, platform: Platform = 'douyin'): Promise<void> {
    const sessionKey = `${windowId}_${platform}`;
    const session = this.userSessions.get(sessionKey);

    if (session) {
      try {
        if (session.browser.isConnected()) {
          logger.info({ windowId, sessionKey }, 'Disconnecting browser session');
        }
      } finally {
        this.userSessions.delete(sessionKey);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [sessionKey, session] of this.userSessions) {
      try {
        if (session.browser.isConnected()) {
          logger.info({ sessionKey }, 'Disconnecting session');
        }
      } catch {}
    }
    this.userSessions.clear();
    logger.info('All browser sessions disconnected');
  }

  async disconnect(keepWindowOpen: boolean = true): Promise<void> {
    logger.info({ keepWindowOpen, activeSessions: this.userSessions.size }, 'Disconnect called - sessions preserved in Keep-Alive mode');
  }

  isSessionAlive(windowId: string, platform: Platform = 'douyin'): boolean {
    const sessionKey = `${windowId}_${platform}`;
    const session = this.userSessions.get(sessionKey);
    return session ? session.browser.isConnected() : false;
  }

  isConnected(): boolean {
    return this.userSessions.size > 0;
  }

  getTabStatuses(): Array<{
    platform: string;
    windowId: string;
    reuseCount: number;
    maxReuse: number;
    remainingReuses: number;
    lastActiveAt: number;
  }> {
    const statuses: Array<{
      platform: string;
      windowId: string;
      reuseCount: number;
      maxReuse: number;
      remainingReuses: number;
      lastActiveAt: number;
    }> = [];

    for (const [sessionKey, session] of this.userSessions) {
      statuses.push({
        platform: session.platform,
        windowId: session.windowId,
        reuseCount: session.reuseCount,
        maxReuse: session.maxReuse,
        remainingReuses: Math.max(0, session.maxReuse - session.reuseCount),
        lastActiveAt: session.lastActiveAt,
      });
    }

    return statuses;
  }

  private async getOrCreateWsEndpoint(windowId: string, vendor?: string): Promise<string> {
    const opener = this.getOpener(vendor);
    const existingWs = await opener.getConnectionInfo(windowId);
    if (existingWs) {
      logger.info({ windowId, ws: existingWs, vendor: opener.vendor }, 'Window already open, reusing WebSocket');
      return existingWs;
    }

    return opener.openWindow(windowId);
  }

  private async getConnectionInfoWs(windowId: string): Promise<string | null> {
    // Legacy method — kept for backward compatibility, delegates to default opener
    return this.getOpener('roxybrowser').getConnectionInfo(windowId);
  }

  private async openBrowserWindow(windowId: string): Promise<string> {
    // Legacy method — kept for backward compatibility, delegates to default opener
    return this.getOpener('roxybrowser').openWindow(windowId);
  }

  async saveMouseTraces(sessionId: string): Promise<string | null> {
    if (!this.debugModeEnabled) {
      this.mouseTraces = [];
      return null;
    }

    if (this.mouseTraces.length === 0) {
      logger.info('No mouse traces to save');
      return null;
    }

    const filename = `trace_${sessionId}_${Date.now()}.json`;
    const filepath = path.join(this.traceLogDir, filename);

    const traceData = {
      sessionId,
      savedAt: new Date().toISOString(),
      totalPoints: this.mouseTraces.length,
      traces: this.mouseTraces,
    };

    fs.writeFileSync(filepath, JSON.stringify(traceData, null, 2));
    logger.info({ filepath, totalPoints: this.mouseTraces.length }, 'Mouse traces saved');

    this.mouseTraces = [];
    return filepath;
  }

  static async logPageHtml(page: Page, label: string): Promise<void> {
    try {
      const url = page.url();
      let html = '';
      try {
        html = await page.content();
      } catch {
        html = '';
      }
      const truncatedHtml = html.length > 5000 ? html.substring(0, 5000) + '...[truncated]' : html;

      logger.info({
        label,
        url,
        htmlLength: html.length,
        html: truncatedHtml,
      }, 'Page HTML snapshot');
    } catch (error: any) {
      logger.warn({ label, error: error.message }, 'Failed to log page HTML');
    }
  }
}
