jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'douyin',
}));

jest.mock('../../lib/antiDetectionMode', () => ({
  isAntiDetectionV2: jest.fn().mockReturnValue(false),
  isEnabled: jest.fn().mockReturnValue(false),
}));

// 注入 version 给 doMock 用
const mockAntiDetection = { isAntiDetectionV2: () => false };

jest.mock('../../lib/selectorStore', () => ({
  getSelectorReader: () => ({
    getConfig: () => ({
      platforms: {
        douyin: {
          loginFlows: {
            creator: {
              domain: 'creator.douyin.com',
              loginUrl: 'https://creator.douyin.com/login',
              label: 'creator',
              closeOnLoginSuccess: false,
              qrSelectors: [],
              loggedOutIndicators: [],
              loggedInIndicators: [],
            },
          },
        },
      },
    }),
  }),
}));

const getLoginFlowConfigMock = jest.fn();
const getBrowserMock = jest.fn();
const openLoginTabMock = jest.fn();
const findMock = jest.fn();
const registerMock = jest.fn();

jest.mock('@social-media/browser-core', () => ({
  HumanActions: { wait: jest.fn().mockResolvedValue(undefined), cdpIsElementVisible: jest.fn().mockResolvedValue(false), cdpClick: jest.fn() },
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
  LoginTabRegistry: jest.fn().mockImplementation(() => ({
    find: findMock,
    openLoginTab: openLoginTabMock,
    register: registerMock,
  })),
  getLoginHost: jest.fn((_loginUrl: string, fallbackDomain: string) => fallbackDomain),
  isOnLoginDomain: jest.fn((url: string, loginHost: string) => url.includes(loginHost)),
  RequestInterceptor: jest.fn(),
  BrowserManager: jest.fn(),
  ExitStrategy: { getQuerySource: jest.fn(), getNextPageAction: jest.fn() },
  PageType: 'unknown',
  SelectorReader: jest.fn(),
  MaintenanceProbe: { getInstance: jest.fn() },
}));

jest.mock('../../lib/browserManager', () => ({
  getBrowserManager: () => ({ getBrowser: getBrowserMock }),
}));

import { ensureLoginTab, loginTabRegistry } from '../loginFlowHelpers';

describe('ensureLoginTab reuse platform tab', () => {
  beforeEach(() => {
    findMock.mockClear();
    openLoginTabMock.mockClear();
    registerMock.mockClear();
    getBrowserMock.mockClear();
  });

  it('reuses existing platform tab (same domain, no login mark) instead of openLoginTab', async () => {
    findMock.mockResolvedValue(null); // 无已有登录 tab
    const reusedPage = {
      url: jest.fn().mockReturnValue('https://creator.douyin.com/creator-micro/home'),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(null), // 无 localStorage 登录标记
      isClosed: jest.fn().mockReturnValue(false),
    };
    getBrowserMock.mockResolvedValue({
      contexts: () => [{ pages: () => [reusedPage] }],
    });

    const record = await ensureLoginTab('68a259626bb2c5905ffed8116e9a2a04', 6, 'douyin', 'creator');
    expect(record).not.toBeNull();
    expect(openLoginTabMock).not.toHaveBeenCalled(); // ★ 未新建
    expect(reusedPage.goto).toHaveBeenCalled(); // ★ 复用并导航到 loginUrl
    expect(registerMock).toHaveBeenCalled();
  });

  it('falls back to openLoginTab when no reusable platform page', async () => {
    findMock.mockResolvedValue(null);
    getBrowserMock.mockResolvedValue({
      contexts: () => [{ pages: () => [] }], // 无任何 page
    });
    openLoginTabMock.mockResolvedValue({ page: { url: () => 'https://creator.douyin.com/login', isClosed: () => false }, targetId: 't1', domain: 'creator.douyin.com', flowId: 'creator', openedAt: 0, userId: 6, loginUrl: '' });

    const record = await ensureLoginTab('68a259626bb2c5905ffed8116e9a2a04', 6, 'douyin', 'creator');
    expect(record).not.toBeNull();
    expect(openLoginTabMock).toHaveBeenCalled(); // ★ 无可复用页 → 新建
  });
});

describe('activatePlatformQR (A1)', () => {
  it('快手：点 div.platform-switch 后等待 qrSelectors 可见返回 true', async () => {
    const clicked: string[] = [];
    const page: any = {
      url: () => 'https://passport.kuaishou.com/pc/account/login/',
      $: async (sel: string) => (sel === 'div.platform-switch' ? { click: async () => { clicked.push(sel); } } : null),
      waitForSelector: async (sel: string) => {
        if (sel === 'img[alt="qrcode"]') return { /* visible */ };
        throw new Error('not found');
      },
      waitForTimeout: async () => {},
    };
    // 强制非 v2 路径
    jest.resetModules();
    jest.doMock('../../lib/antiDetectionMode', () => mockAntiDetection);
    const { activatePlatformQR } = await import('../loginFlowHelpers');
    const config = {
      domain: 'cp.kuaishou.com', loginUrl: 'https://passport.kuaishou.com/x',
      qrSelectors: ['img[alt="qrcode"]', 'canvas'], qrActivationSelector: undefined,
    } as any;
    const ok = await activatePlatformQR(page, 'kuaishou', config);
    if (!ok) throw new Error('expected activatePlatformQR true');
    if (clicked.length !== 1 || clicked[0] !== 'div.platform-switch') throw new Error('expected switch clicked once');
  });
});
