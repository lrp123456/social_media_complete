// @ts-api-gateway/services/browserApiService.ts
// 指纹浏览器统一抽象层 — 多态接口，BitBrowser / RoxyBrowser 底层实现不同，高层一致

import { createLogger } from '../lib/logger';

const logger = createLogger('browser-api');

const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * 带超时的 fetch 包装 — 避免请求挂死导致服务阻塞
 * AbortController + 定时器实现，超时后自动释放连接
 */
async function fetchWithTimeout(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Connection timeout (${CONNECTION_TIMEOUT_MS / 1000}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// 统一类型定义
// ============================================================

export type BrowserVendor = 'bitbrowser' | 'roxybrowser';

/** 统一窗口信息 — 无论底层是哪个浏览器，对外结构一致 */
export interface WindowInfo {
  id: string;              // 窗口唯一ID（各浏览器自己的ID）
  name: string;            // 窗口名称
  vendor: BrowserVendor;   // 来源
  status: 'running' | 'stopped' | 'unknown'; // 运行状态
  pid?: number;            // 进程ID（运行时有）
  seq?: number;            // 序号
  os?: string;             // 操作系统
  coreVersion?: string;    // 内核版本
  groupId?: string;        // BitBrowser 分组ID
  workspaceId?: string;    // RoxyBrowser 空间ID
  raw?: any;               // 原始数据（调试用）
}

/** 打开窗口返回的连接信息 */
export interface WindowConnection {
  windowId: string;
  wsUrl: string;           // WebSocket CDP 地址
  httpUrl: string;         // HTTP CDP 地址
  coreVersion: string;
  driver: string;          // chromedriver 路径
  pid: number;
}

/** 创建窗口参数 */
export interface CreateWindowConfig {
  name: string;
  platform?: string;       // 平台URL，如 https://www.douyin.com
  proxy?: {
    type: 'noproxy' | 'http' | 'https' | 'socks5';
    host?: string;
    port?: number;
    username?: string;
    password?: string;
  };
  groupId?: string;        // BitBrowser 分组ID
  workspaceId?: string;    // RoxyBrowser 空间ID
}

/** 浏览器供应商配置 */
export interface BrowserConfig {
  vendor: BrowserVendor;
  baseUrl: string;
  apiKey?: string;         // RoxyBrowser 需要
  groupId?: string;        // BitBrowser 默认分组
  workspaceId?: string;    // RoxyBrowser 默认空间
}

// ============================================================
// 抽象接口
// ============================================================

interface BrowserProvider {
  readonly vendor: BrowserVendor;
  healthCheck(): Promise<boolean>;
  listWindows(): Promise<WindowInfo[]>;
  getWindowDetail(windowId: string): Promise<WindowInfo>;
  openWindow(windowId: string): Promise<WindowConnection>;
  closeWindow(windowId: string): Promise<void>;
  getWindowStatus(windowId: string): Promise<'running' | 'stopped'>;
  createWindow(config: CreateWindowConfig): Promise<WindowInfo>;
}

// ============================================================
// BitBrowser 实现
// ============================================================

class BitBrowserProvider implements BrowserProvider {
  readonly vendor = 'bitbrowser';
  private baseUrl: string;
  private defaultGroupId: string;

  constructor(config: BrowserConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.defaultGroupId = config.groupId || '';
  }

  private async post<T>(path: string, body: any = {}): Promise<T> {
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch((err: Error) => {
      if (err.message.includes('timeout')) {
        throw new Error(`BitBrowser POST ${path}: Connection timeout (${CONNECTION_TIMEOUT_MS / 1000}s)`);
      }
      throw err;
    });
    if (!res.ok) throw new Error(`BitBrowser ${path}: ${res.status} ${res.statusText}`);
    const json = await res.json() as any;
    if (json.success === false) throw new Error(`BitBrowser ${path}: ${json.msg || JSON.stringify(json)}`);
    return json as T;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.post<any>('/health');
      return true;
    } catch { return false; }
  }

  async listWindows(): Promise<WindowInfo[]> {
    const res = await this.post<any>('/browser/list', { page: 0, pageSize: 100 });
    const list = res.data?.list || [];
    return list.map((w: any) => ({
      id: w.id,
      name: w.name || '',
      vendor: 'bitbrowser' as const,
      status: 'unknown' as const,
      seq: w.seq,
      groupId: w.groupId,
      raw: w,
    }));
  }

  async getWindowDetail(windowId: string): Promise<WindowInfo> {
    const res = await this.post<any>('/browser/detail', { id: windowId });
    const w = res.data;
    return {
      id: w.id,
      name: w.name || '',
      vendor: 'bitbrowser',
      status: 'unknown',
      seq: w.seq,
      groupId: w.groupId,
      raw: w,
    };
  }

  async openWindow(windowId: string): Promise<WindowConnection> {
    const res = await this.post<any>('/browser/open', { id: windowId });
    const d = res.data;
    return {
      windowId,
      wsUrl: d.ws,
      httpUrl: d.http,
      coreVersion: d.coreVersion || '',
      driver: d.driver || '',
      pid: d.pid || 0,
    };
  }

  async closeWindow(windowId: string): Promise<void> {
    await this.post<any>('/browser/close', { id: windowId });
  }

  async getWindowStatus(windowId: string): Promise<'running' | 'stopped'> {
    try {
      const res = await this.post<any>('/browser/pids', { ids: [windowId] });
      const pid = res.data?.[windowId];
      return pid ? 'running' : 'stopped';
    } catch { return 'unknown' as any; }
  }

  async createWindow(config: CreateWindowConfig): Promise<WindowInfo> {
    const body: any = {
      name: config.name,
      groupId: config.groupId || this.defaultGroupId,
      platform: config.platform || '',
      platformIcon: config.platform ? new URL(config.platform).hostname : '',
      browserFingerPrint: {},
    };
    if (config.proxy && config.proxy.type !== 'noproxy') {
      body.proxyMethod = 2;
      body.proxyType = config.proxy.type;
      body.host = config.proxy.host || '';
      body.port = config.proxy.port || 0;
      body.proxyUserName = config.proxy.username || '';
      body.proxyPassword = config.proxy.password || '';
    }
    const res = await this.post<any>('/browser/update', body);
    const w = res.data;
    return {
      id: w.id || w,
      name: config.name,
      vendor: 'bitbrowser',
      status: 'stopped',
      groupId: body.groupId,
      raw: w,
    };
  }
}

// ============================================================
// RoxyBrowser 实现
// ============================================================

class RoxyBrowserProvider implements BrowserProvider {
  readonly vendor = 'roxybrowser';
  private baseUrl: string;
  private apiKey: string;
  private defaultWorkspaceId: string;

  constructor(config: BrowserConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.defaultWorkspaceId = config.workspaceId || '';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async get<T>(path: string, params?: Record<string, any>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: this.headers() })
      .catch((err: Error) => {
        if (err.message.includes('timeout')) {
          throw new Error(`RoxyBrowser GET ${path}: Connection timeout (${CONNECTION_TIMEOUT_MS / 1000}s)`);
        }
        throw err;
      });
    if (!res.ok) throw new Error(`RoxyBrowser GET ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: any = {}): Promise<T> {
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    }).catch((err: Error) => {
      if (err.message.includes('timeout')) {
        throw new Error(`RoxyBrowser POST ${path}: Connection timeout (${CONNECTION_TIMEOUT_MS / 1000}s)`);
      }
      throw err;
    });
    if (!res.ok) throw new Error(`RoxyBrowser POST ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async ensureWorkspace(): Promise<string> {
    if (this.defaultWorkspaceId) return this.defaultWorkspaceId;
    const res = await this.get<any>('/browser/workspace');
    const rows = res.data?.rows || [];
    if (rows.length === 0) throw new Error('RoxyBrowser 无可用工作空间');
    this.defaultWorkspaceId = String(rows[0].id);
    return this.defaultWorkspaceId;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.get<any>('/health');
      return res.code === 0;
    } catch { return false; }
  }

  async listWindows(): Promise<WindowInfo[]> {
    const wsId = await this.ensureWorkspace();
    const res = await this.get<any>('/browser/list_v3', { workspaceId: wsId, page_index: 1, page_size: 100 });
    const rows = res.data?.rows || [];
    return rows.map((w: any) => ({
      id: w.dirId,
      name: w.windowName || '',
      vendor: 'roxybrowser' as const,
      status: 'unknown' as const,
      seq: w.windowSortNum,
      os: w.os,
      coreVersion: w.coreVersion,
      workspaceId: wsId,
      raw: w,
    }));
  }

  async getWindowDetail(windowId: string): Promise<WindowInfo> {
    const wsId = await this.ensureWorkspace();
    const res = await this.get<any>('/browser/detail', { workspaceId: wsId, dirId: windowId });
    const w = res.data?.rows?.[0] || {};
    return {
      id: w.dirId,
      name: w.windowName || '',
      vendor: 'roxybrowser',
      status: w.openStatus ? 'running' : 'stopped',
      os: w.os,
      coreVersion: w.coreVersion,
      workspaceId: wsId,
      raw: w,
    };
  }

  async openWindow(windowId: string): Promise<WindowConnection> {
    const wsId = await this.ensureWorkspace();
    const res = await this.post<any>('/browser/open', { workspaceId: wsId, dirId: windowId });
    const d = res.data;
    return {
      windowId,
      wsUrl: d.ws,
      httpUrl: d.http,
      coreVersion: d.coreVersion || '',
      driver: d.driver || '',
      pid: d.pid || 0,
    };
  }

  async closeWindow(windowId: string): Promise<void> {
    const wsId = await this.ensureWorkspace();
    await this.post<any>('/browser/close', { workspaceId: wsId, dirId: windowId });
  }

  async getWindowStatus(windowId: string): Promise<'running' | 'stopped'> {
    try {
      const detail = await this.getWindowDetail(windowId);
      return detail.status === 'running' ? 'running' : 'stopped';
    } catch { return 'unknown' as any; }
  }

  async createWindow(config: CreateWindowConfig): Promise<WindowInfo> {
    const wsId = config.workspaceId || await this.ensureWorkspace();
    const body: any = {
      workspaceId: wsId,
      windowName: config.name,
    };
    if (config.platform) {
      body.defaultOpenUrl = [config.platform];
    }
    if (config.proxy && config.proxy.type !== 'noproxy') {
      body.proxyInfo = {
        proxyMethod: 'custom',
        proxyCategory: config.proxy.type.toUpperCase(),
        host: config.proxy.host || '',
        port: String(config.proxy.port || ''),
        proxyUserName: config.proxy.username || '',
        proxyPassword: config.proxy.password || '',
      };
    }
    const res = await this.post<any>('/browser/create', body);
    const d = res.data;
    return {
      id: d.dirId || d,
      name: config.name,
      vendor: 'roxybrowser',
      status: 'stopped',
      workspaceId: wsId,
      raw: d,
    };
  }
}

// ============================================================
// 供应商注册表 + 工厂
// ============================================================

const providers = new Map<BrowserVendor, BrowserProvider>();

export function registerBrowser(config: BrowserConfig): void {
  let provider: BrowserProvider;
  if (config.vendor === 'bitbrowser') {
    provider = new BitBrowserProvider(config);
  } else {
    provider = new RoxyBrowserProvider(config);
  }
  providers.set(config.vendor, provider);
  logger.info(`注册浏览器: ${config.vendor} @ ${config.baseUrl}`);
}

export function getProvider(vendor: BrowserVendor): BrowserProvider {
  const p = providers.get(vendor);
  if (!p) throw new Error(`未注册的浏览器供应商: ${vendor}`);
  return p;
}

export function getAllProviders(): BrowserProvider[] {
  return Array.from(providers.values());
}

// ============================================================
// 统一对外函数 — 高层调用这些，不关心底层
// ============================================================

/** 同步指定供应商的窗口列表 */
export async function syncWindows(vendor: BrowserVendor): Promise<WindowInfo[]> {
  return getProvider(vendor).listWindows();
}

/** 同步所有已注册供应商的窗口列表 */
export async function syncAllWindows(): Promise<WindowInfo[]> {
  const results: WindowInfo[] = [];
  for (const p of getAllProviders()) {
    try {
      const windows = await p.listWindows();
      results.push(...windows);
    } catch (err) {
      logger.error({ err: (err as Error).message, vendor: p.vendor }, '同步窗口失败');
    }
  }
  return results;
}

/** 打开窗口并返回 CDP 连接信息 */
export async function openWindow(vendor: BrowserVendor, windowId: string): Promise<WindowConnection> {
  return getProvider(vendor).openWindow(windowId);
}

/** 关闭窗口 */
export async function closeWindow(vendor: BrowserVendor, windowId: string): Promise<void> {
  return getProvider(vendor).closeWindow(windowId);
}

/** 检查窗口运行状态 */
export async function getWindowStatus(vendor: BrowserVendor, windowId: string): Promise<string> {
  return getProvider(vendor).getWindowStatus(windowId);
}

/** 创建新窗口 */
export async function createWindow(vendor: BrowserVendor, config: CreateWindowConfig): Promise<WindowInfo> {
  return getProvider(vendor).createWindow(config);
}

/** 获取窗口详情 */
export async function getWindowDetail(vendor: BrowserVendor, windowId: string): Promise<WindowInfo> {
  return getProvider(vendor).getWindowDetail(windowId);
}

// ============================================================
// CDP Target 解析工具
// ============================================================

interface CdpTargetResult {
  /** 页面级 CDP WebSocket URL */
  pageWsUrl: string;
  /** 是否需要执行 Page.navigate（false=标签页已有正确 URL，只需 reload） */
  needsNavigation: boolean;
}

/**
 * 在 CDP targets 中查找匹配平台 URL 的页面标签页，激活它并返回其 WS URL。
 * - 若已存在 URL 域名匹配的标签页 → 激活 + 返回其 WS URL（不需要导航）
 * - 若不存在 → 返回第一个 page 类型 target 的 WS URL（需要导航到目标 URL）
 */
function findAndActivatePageTarget(
  httpBase: string,
  targets: any[],
  platformUrl: string,
  fallbackWsUrl: string,
  logger: any,
): CdpTargetResult {
  // 从平台 URL 提取域名用于匹配
  let platformDomain: string | null = null;
  try {
    platformDomain = new URL(platformUrl).hostname;
  } catch { /* ignore */ }

  // 查找 URL 域名匹配的标签页
  if (platformDomain && targets.length > 0) {
    const matchingTarget = targets.find((t: any) => {
      if (t.type !== 'page') return false;
      try {
        return new URL(t.url).hostname === platformDomain;
      } catch { return false; }
    });

    if (matchingTarget?.webSocketDebuggerUrl) {
      // 激活该标签页（切换到前台）
      if (matchingTarget.id) {
        fetchWithTimeout(`${httpBase}/json/activate/${matchingTarget.id}`, { method: 'GET' })
          .catch(() => { /* 激活失败不影响主流程 */ });
      }
      logger.info({ title: matchingTarget.title, url: matchingTarget.url, id: matchingTarget.id },
        '复用已有标签页（仅刷新，不创建新标签）');
      return { pageWsUrl: matchingTarget.webSocketDebuggerUrl, needsNavigation: false };
    }
  }

  // 回退：取第一个 page target
  const pageTarget = targets?.find((t: any) => t.type === 'page');
  if (pageTarget?.webSocketDebuggerUrl) {
    logger.debug({ pageTitle: pageTarget.title }, '使用第一个页面标签页（需要导航）');
    return { pageWsUrl: pageTarget.webSocketDebuggerUrl, needsNavigation: true };
  }

  // 最终回退：使用浏览器级端点
  logger.debug({ wsUrl: fallbackWsUrl }, '无 page target，使用浏览器级端点');
  return { pageWsUrl: fallbackWsUrl, needsNavigation: true };
}

// ============================================================
// 平台登录状态检查（通过 CDP 导航 + 页面元素检测）
// ============================================================

/**
 * 通过 CDP 协议检查窗口中指定平台的登录状态
 * 流程: 打开窗口 → CDP 连接 → 页面导航 → 等待渲染 → 检测登录按钮
 */
export async function checkPlatformLogin(
  vendor: BrowserVendor,
  windowId: string,
  platform: string,
): Promise<{ loggedIn: boolean; detail: string }> {
  const WS = require('ws') as any;

  // 平台创作者页面 URL
  const platformCreatorUrls: Record<string, string> = {
    douyin: 'https://creator.douyin.com/creator-micro/home',
    kuaishou: 'https://cp.kuaishou.com/profile',
    xiaohongshu: 'https://creator.xiaohongshu.com/new/home',
    bilibili: 'https://member.bilibili.com',
    baijiahao: 'https://baijiahao.baidu.com',
    tencent: 'https://channels.weixin.qq.com/platform',
    tiktok: 'https://creator.tiktok.com',
  };

  // 登录按钮检测脚本
  const loginCheckScripts: Record<string, string> = {
    douyin: `(() => {
      const btns = document.querySelectorAll('.douyin_login_comp_btn, [class*="douyin_login"], button, a');
      for (const btn of btns) {
        const text = btn.textContent?.trim() || '';
        if (text.includes('登录') || text.includes('注册')) return true;
      }
      return false;
    })()`,
    kuaishou: `(() => {
      const links = document.querySelectorAll('a.login, a[data-v-0c1cbb20]');
      for (const link of links) {
        const text = link.textContent?.trim() || '';
        if (text.includes('立即登录') || text.includes('登录')) return true;
      }
      return false;
    })()`,
    xiaohongshu: `(() => {
      // 优先检查 .creator-container（登录态） => true 表示已登录，反推
      const creatorEl = document.querySelector('.creator-container');
      if (creatorEl && creatorEl.offsetParent !== null) return false;
      // 检查 .login-container（未登录态）=> true 表示有登录按钮
      const loginEl = document.querySelector('.login-container, .login-btn-container, button.css-n0yaji, button.beer-login-btn, button[class*="beer-login-btn"]');
      if (loginEl && loginEl.offsetParent !== null) return true;
      // 回退：扫描按钮文案
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = btn.textContent?.trim().replace(/\\s+/g, '') || '';
        if (text.includes('登录')) return true;
      }
      return false;
    })()`,
    bilibili: `(() => { const el = document.querySelector('.login-btn, .login-button'); return !!el && el.offsetParent !== null; })()`,
    baijiahao: `(() => { const el = document.querySelector('.login-btn'); return !!el && el.offsetParent !== null; })()`,
    tencent: `(() => {
      // 视频号创作者平台：检查是否被重定向到登录页
      const url = window.location.href;
      if (url.includes('/login')) return true;
      // 已登录状态：URL 包含 /platform 且页面中有创作者后台元素
      if (url.includes('channels.weixin.qq.com/platform')) return false;
      // 回退：检查登录相关元素
      const el = document.querySelector('.login-btn, #login, [class*="login"]');
      return !!el && el.offsetParent !== null;
    })()`,
    tiktok: `(() => { const el = document.querySelector('[data-e2e="login"], .login-btn'); return !!el && el.offsetParent !== null; })()`,
  };

  const creatorUrl = platformCreatorUrls[platform];
  const checkScript = loginCheckScripts[platform];

  if (!creatorUrl || !checkScript) {
    return { loggedIn: false, detail: `不支持的平台: ${platform}` };
  }

  // 1. 打开窗口获取 CDP WebSocket URL
  let conn: WindowConnection;
  try {
    conn = await openWindow(vendor, windowId);
  } catch (err) {
    return { loggedIn: false, detail: `打开窗口失败: ${(err as Error).message}` };
  }

  if (!conn.wsUrl) {
    return { loggedIn: false, detail: '未获取到 CDP WebSocket 地址' };
  }

  // 2. 解析 CDP HTTP 基础地址，获取所有页面 targets
  const httpBase = conn.httpUrl
    ? (conn.httpUrl.startsWith('http') ? conn.httpUrl : `http://${conn.httpUrl}`)
    : conn.wsUrl.replace(/^ws/, 'http').replace(/\/devtools\/.*/, '');

  let targets: any[] = [];
  try {
    const targetsResp = await fetchWithTimeout(`${httpBase}/json`, { method: 'GET' });
    targets = await targetsResp.json();
    logger.debug({ count: targets.length }, 'CDP targets 获取成功');
  } catch (e) {
    logger.debug({ err: (e as Error).message, vendor }, '/json 端点不可用，使用浏览器级 CDP');
  }

  // 3. 查找并激活匹配平台的已有标签页，没有则取第一个 page target
  const { pageWsUrl, needsNavigation } = findAndActivatePageTarget(
    httpBase, targets, creatorUrl, conn.wsUrl, logger,
  );

  if (!pageWsUrl) {
    return { loggedIn: false, detail: '无法获取页面级 CDP WebSocket 地址' };
  }

  // 4. 通过 CDP 协议（复用已有标签页时仅刷新，否则导航）
  try {
    const hasLoginButton = await cdpNavigateAndCheck(pageWsUrl, creatorUrl, checkScript, { needsNavigation });
    const loggedIn = !hasLoginButton;
    const detail = loggedIn
      ? `已检测到登录态 (页面: ${creatorUrl})`
      : `未检测到登录态 (页面: ${creatorUrl}, 检测到登录按钮)`;

    logger.debug({ platform, creatorUrl, hasLoginButton, loggedIn }, '登录态检查结果');
    return { loggedIn, detail };
  } catch (err) {
    return { loggedIn: false, detail: `CDP 检测失败: ${(err as Error).message}` };
  }
}

/**
 * CDP 导航到指定 URL 并执行检测脚本
 * @param options.needsNavigation — true 时执行 Page.navigate，false 时执行 Page.reload（标签页已在正确 URL）
 * @returns true 表示检测到登录按钮（未登录）
 */
function cdpNavigateAndCheck(
  wsUrl: string,
  navigateUrl: string,
  checkScript: string,
  options: { needsNavigation?: boolean } = {},
): Promise<boolean> {
  const WS = require('ws') as any;

  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl) as any;
    let msgId = 1;
    let evalDone = false;
    let enabled = 0; // count how many enable responses we got (need 2)

    const needsNavigation = options.needsNavigation !== false; // default true

    const TIMEOUT_MS = 30_000;
    const CONNECT_TIMEOUT_MS = 10_000;

    // Connection timeout: if ws doesn't open within 10s, consider CDP unreachable
    const connectTimeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP WebSocket 连接超时 — 浏览器可能未启动或 CDP 端点不可达'));
    }, CONNECT_TIMEOUT_MS);

    const timeout = setTimeout(() => {
      if (!evalDone) {
        ws.close();
        reject(new Error(`CDP 操作超时 (${TIMEOUT_MS}ms)`));
      }
    }, TIMEOUT_MS);

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      // Enable Page domain
      ws.send(JSON.stringify({ id: msgId++, method: 'Page.enable' }));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // Log received CDP events for debugging
        if (msg.method) {
          logger.debug({ method: msg.method, id: msg.id }, 'CDP event');
        }

        // --- Page.enable response → start navigation or reload ---
        if (msg.id && !msg.error && enabled === 0 && !msg.method) {
          enabled = 1;
          if (needsNavigation) {
            logger.debug({ navigateUrl }, 'CDP 开始导航 (Page.navigate)');
            ws.send(JSON.stringify({
              id: ++msgId,
              method: 'Page.navigate',
              params: { url: navigateUrl },
            }));
          } else {
            logger.debug('CDP 复用已有标签页 (Page.reload)');
            ws.send(JSON.stringify({
              id: ++msgId,
              method: 'Page.reload',
            }));
          }
          return;
        }

        // --- Page.enable error ---
        if (msg.id && msg.error && enabled === 0) {
          clearTimeout(timeout);
          clearTimeout(connectTimeout);
          ws.close();
          reject(new Error(`Page.enable 失败: ${msg.error.message || JSON.stringify(msg.error)}`));
          return;
        }

        // --- Page.navigate / Page.reload error ---
        if (msg.id && msg.error && enabled === 1 && !evalDone) {
          clearTimeout(timeout);
          ws.close();
          const cmd = needsNavigation ? 'Page.navigate' : 'Page.reload';
          reject(new Error(`${cmd} 失败: ${msg.error.message || JSON.stringify(msg.error)}`));
          return;
        }

        // --- Page.loadEventFired: page loaded, wait and eval ---
        if (msg.method === 'Page.loadEventFired' && !evalDone) {
          evalDone = true;
          logger.debug('CDP 页面加载完毕，等待 3s 后执行检测脚本');
          setTimeout(() => {
            ws.send(JSON.stringify({
              id: ++msgId,
              method: 'Runtime.evaluate',
              params: {
                expression: checkScript,
                returnByValue: true,
              },
            }));
          }, 3000);
          return;
        }

        // --- Fallback: if navigate response is success but loadEventFired might have already fired
        // Also check Page.frameStoppedLoading as fallback
        if (msg.method === 'Page.frameStoppedLoading' && !evalDone) {
          logger.debug('CDP frameStoppedLoading, 使用 fallback 检测');
          evalDone = true;
          // Shorter wait since frame already loaded
          setTimeout(() => {
            ws.send(JSON.stringify({
              id: ++msgId,
              method: 'Runtime.evaluate',
              params: {
                expression: checkScript,
                returnByValue: true,
              },
            }));
          }, 2000);
          return;
        }

        // --- Evaluate result ---
        if (msg.id && msg.result?.result?.value !== undefined && evalDone) {
          clearTimeout(timeout);
          ws.close();
          const hasLoginButton = msg.result.result.value === true;
          logger.debug({ hasLoginButton, value: msg.result.result.value }, 'CDP 检测结果');
          resolve(hasLoginButton);
          return;
        }

        // --- Evaluate error ---
        if (msg.id && msg.error && evalDone) {
          clearTimeout(timeout);
          ws.close();
          // Evaluation failed but we tried - treat as not logged in
          logger.warn({ error: msg.error }, 'CDP evaluate 失败，默认为未登录');
          resolve(true);
          return;
        }
      } catch {
        // Ignore parsing errors
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      clearTimeout(connectTimeout);
      reject(new Error(`CDP WebSocket 错误: ${err.message}`));
    });

    ws.on('close', () => {
      // If the WebSocket closes before we resolve/reject, treat as error
      if (!evalDone) {
        clearTimeout(timeout);
        clearTimeout(connectTimeout);
        reject(new Error('CDP WebSocket 连接意外关闭'));
      }
    });
  });
}

// ============================================================
// 启动时自动注册
// ============================================================

function autoRegister(): void {
  const bitUrl = process.env.BIT_BROWSER_URL;
  const roxyUrl = process.env.ROXY_BROWSER_URL;
  const roxyKey = process.env.ROXY_BROWSER_KEY;

  if (bitUrl) {
    registerBrowser({ vendor: 'bitbrowser', baseUrl: bitUrl, groupId: '402880a99e827246019e8c0932662a17' });
  }
  if (roxyUrl) {
    registerBrowser({ vendor: 'roxybrowser', baseUrl: roxyUrl, apiKey: roxyKey, workspaceId: '111819' });
  }

  if (providers.size === 0) {
    logger.warn('未检测到浏览器环境变量 (BIT_BROWSER_URL / ROXY_BROWSER_URL)');
  }
}

autoRegister();
