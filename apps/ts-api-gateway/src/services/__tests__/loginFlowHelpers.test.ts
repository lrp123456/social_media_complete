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
