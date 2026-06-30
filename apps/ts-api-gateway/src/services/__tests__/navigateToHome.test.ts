import { describe, it, expect, jest } from '@jest/globals';

const mockResolveAndClick = jest.fn<() => Promise<boolean>>();

jest.mock('../../crawlers/menuNavigator', () => ({
  resolveAndClick: mockResolveAndClick,
  tryClickBySelector: jest.fn<() => Promise<boolean>>(),
}));

jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn<() => boolean>().mockReturnValue(false),
  isDevelopment: jest.fn<() => boolean>().mockReturnValue(false),
  getConfig: jest.fn<() => unknown>().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn<() => unknown>().mockReturnValue({ NODE_ENV: 'test' }),
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@social-media/browser-core', () => ({
  rootLogger: { child: jest.fn<() => { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock }>().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
  HumanActions: {
    wait: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    pageLoadBehavior: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearCDPContext: jest.fn<() => void>(),
  },
  RequestInterceptor: jest.fn<() => { register: jest.Mock; unregister: jest.Mock; clearAll: jest.Mock; clear: jest.Mock; setValidationConfig: jest.Mock; getRejectionLog: jest.Mock; getResponseCount: jest.Mock; waitForResponse: jest.Mock; getCollectedItems: jest.Mock; getResponses: jest.Mock; getCollectedCount: jest.Mock }>().mockReturnValue({
    register: jest.fn<() => Promise<string>>(),
    unregister: jest.fn<() => void>(),
    clearAll: jest.fn<() => void>(),
    clear: jest.fn<() => void>(),
    setValidationConfig: jest.fn<() => void>(),
    getRejectionLog: jest.fn<() => unknown[]>(),
    getResponseCount: jest.fn<() => number>(),
    waitForResponse: jest.fn<() => Promise<unknown>>(),
    getCollectedItems: jest.fn<() => unknown[]>(),
    getResponses: jest.fn<() => unknown[]>(),
    getCollectedCount: jest.fn<() => number>(),
  }),
  ExitStrategy: {},
  PageType: {},
  BrowserManager: {},
  MaintenanceProbe: jest.fn(),
}));

import { KuaishouCrawler } from '../../crawlers/kuaishouCrawler';

describe('KuaishouCrawler.navigateToHome 三分支', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAndClick.mockResolvedValue(true);
  });

  it('work page (含 /article/publish/video) → 不调用 goto', async () => {
    const ks = new KuaishouCrawler();
    const page = {
      url: jest.fn<() => string>().mockReturnValue('https://cp.kuaishou.com/article/publish/video'),
      goto: jest.fn<() => Promise<void>>(),
    } as any;
    await ks.navigateToHome(page);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('about:blank → 直接 goto 一次', async () => {
    const ks = new KuaishouCrawler();
    const page = {
      url: jest.fn<() => string>().mockReturnValue('about:blank'),
      goto: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as any;
    await ks.navigateToHome(page);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('非 cp 域名（其他域）→ 直接 goto 一次', async () => {
    const ks = new KuaishouCrawler();
    const page = {
      url: jest.fn<() => string>().mockReturnValue('https://other-domain.example/'),
      goto: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as any;
    await ks.navigateToHome(page);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('cp 域但不在 work page（点击成功）→ 走点击分支，不调 goto', async () => {
    mockResolveAndClick.mockResolvedValue(true);
    const ks = new KuaishouCrawler();
    const page = {
      url: jest.fn<() => string>().mockReturnValue('https://cp.kuaishou.com/other-page'),
      goto: jest.fn<() => Promise<void>>(),
    } as any;
    await ks.navigateToHome(page);
    expect(mockResolveAndClick).toHaveBeenCalledTimes(1);
    expect(mockResolveAndClick).toHaveBeenCalledWith(page, 'nav.to-creator', 'kuaishou', { timeout: 10000 });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('cp 域点击失败 → 回退 goto 一次', async () => {
    mockResolveAndClick.mockResolvedValue(false);
    const ks = new KuaishouCrawler();
    const page = {
      url: jest.fn<() => string>().mockReturnValue('https://cp.kuaishou.com/other-page'),
      goto: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as any;
    await ks.navigateToHome(page);
    expect(mockResolveAndClick).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});
