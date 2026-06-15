import { chromium, Browser, Page } from 'patchright';
import { Platform } from '../types';
import { HumanActions } from './humanActions';
import { rootLogger } from '../logger';
import fs from 'fs';
import path from 'path';
const logger = rootLogger.child({ name: 'browserManager' });

interface RoxyBrowserOpenResponse {
  code: number;
  msg: string;
  data?: {
    ws?: string;
    http?: string;
    pid?: number;
    port?: number;
    webDriver?: string;
    webSocket?: string;
    windowId?: string;
    windowName?: string;
    workspaceId?: string;
    workspaceName?: string;
  };
}

interface RoxyBrowserConnectionInfoResponse {
  code: number;
  msg: string;
  data?: Array<{
    dirId?: string;
    ws?: string;
    http?: string;
    pid?: number;
    port?: number;
    [key: string]: any;
  }>;
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
  page: Page;
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

  constructor(apiPort: number = 50000, apiKey: string = '') {
    this.apiHost = `http://127.0.0.1:${apiPort}`;
    this.apiKey = apiKey;
    this.traceLogDir = path.resolve(process.cwd(), 'data', 'mouse_traces');
    if (!fs.existsSync(this.traceLogDir)) {
      fs.mkdirSync(this.traceLogDir, { recursive: true });
    }
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

  async connect(windowId: string, spaceId: string, platform: Platform = 'douyin'): Promise<{ browser: Browser; page: Page }> {
    const sessionKey = `${windowId}_${platform}`;

    const existingSession = this.userSessions.get(sessionKey);
    if (existingSession && existingSession.browser.isConnected()) {
      try {
        const pages = existingSession.browser.contexts()[0]?.pages() || [];
        const platformPage = this.findPlatformPage(pages, platform);

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
              return { browser: existingSession.browser, page: newPage };
            } catch (rotateError: any) {
              logger.warn({ windowId, error: rotateError.message }, 'Tab rotation failed, continuing with existing page');
            }
          }

          existingSession.page = platformPage;
          return { browser: existingSession.browser, page: platformPage };
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
          return { browser: existingSession.browser, page: newPage };
        } catch (createError: any) {
          logger.warn({ windowId, error: createError.message }, 'Failed to create new tab, reconnecting');
          this.userSessions.delete(sessionKey);
        }
      } catch (error: any) {
        logger.warn({ windowId, error: error.message }, 'Existing session invalid, reconnecting');
        this.userSessions.delete(sessionKey);
      }
    }

    const wsEndpoint = await this.getOrCreateWsEndpoint(windowId);

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
        const platformPage = this.findPlatformPage(pages, platform);

        if (platformPage) {
          page = platformPage;
          logger.info({ windowId, url: page.url(), platform }, 'Found existing platform tab');
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

        return { browser, page };
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

  private findPlatformPage(pages: Page[], platform: Platform): Page | undefined {
    return pages.find(p => {
      const url = p.url();
      if (platform === 'kuaishou') {
        return url.includes('kuaishou.com') || url.includes('cp.kuaishou.com');
      }
      if (platform === 'xiaohongshu') {
        return url.includes('xiaohongshu.com') || url.includes('creator.xiaohongshu.com');
      }
      if (platform === 'tencent') {
        return url.includes('channels.weixin.qq.com');
      }
      return url.includes('douyin.com') || url.includes('creator.douyin.com');
    });
  }

  async focusPage(windowId: string, platform: Platform = 'douyin'): Promise<Page | null> {
    const sessionKey = `${windowId}_${platform}`;
    const session = this.userSessions.get(sessionKey);

    if (!session || !session.browser.isConnected()) {
      return null;
    }

    try {
      const pages = session.browser.contexts()[0]?.pages() || [];
      const page = this.findPlatformPage(pages, platform) || pages[0];

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
      const page = this.findPlatformPage(pages, platform) || session.page;
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

  private async getOrCreateWsEndpoint(windowId: string): Promise<string> {
    const existingWs = await this.getConnectionInfoWs(windowId);
    if (existingWs) {
      logger.info({ windowId, ws: existingWs }, 'Window already open, reusing WebSocket');
      return existingWs;
    }

    return this.openBrowserWindow(windowId);
  }

  private async getConnectionInfoWs(windowId: string): Promise<string | null> {
    const url = `${this.apiHost}/browser/connection_info`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'token': this.apiKey,
        },
      });

      if (!response.ok) return null;

      const result = await response.json() as RoxyBrowserConnectionInfoResponse;
      if (result.code !== 0 || !result.data) return null;

      const windowInfo = result.data.find((item: any) => item.dirId === windowId);
      if (windowInfo?.ws) {
        return windowInfo.ws;
      }

      return null;
    } catch (error: any) {
      logger.warn({ windowId, error: error.message }, 'Failed to get connection info');
      return null;
    }
  }

  private async openBrowserWindow(windowId: string): Promise<string> {
    const url = `${this.apiHost}/browser/open`;
    const body = {
      dirId: windowId,
      args: [],
    };

    logger.info({ windowId, url }, 'Opening browser window via RoxyBrowser API');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'token': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`RoxyBrowser API request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as RoxyBrowserOpenResponse;

    if (result.code !== 0) {
      throw new Error(`RoxyBrowser API error: ${result.msg} (code: ${result.code})`);
    }

    if (!result.data?.ws) {
      throw new Error('RoxyBrowser API response missing WebSocket endpoint');
    }

    logger.info({ windowId, ws: result.data.ws }, 'Browser window opened successfully');

    return result.data.ws;
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
