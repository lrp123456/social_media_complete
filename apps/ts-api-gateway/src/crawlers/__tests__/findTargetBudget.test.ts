const cdpSmartScrollMock = jest.fn().mockResolvedValue(undefined);

// 根日志桩：满足 browser-core 内部模块的需求
const stubLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => stubLogger),
};

// Mock @social-media/shared-config: logger.ts 调用 isProduction()，避免 OSS 校验
jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  // menuSelectors.ts 只用了 PlatformName 类型（编译期擦除），运行时无需 mock
  PlatformName: 'douyin',
}));

jest.mock('@social-media/browser-core', () => ({
  HumanActions: {
    cdpSmartScroll: cdpSmartScrollMock,
    wait: jest.fn().mockImplementation(() => new Promise(r => setTimeout(r, 50))),
  },
  rootLogger: stubLogger,
  RequestInterceptor: jest.fn(),
  BrowserManager: jest.fn(),
  ExitStrategy: class {
    static getQuerySource = jest.fn();
    static getNextPageAction = jest.fn();
  },
  PageType: 'unknown',
  SelectorReader: jest.fn().mockImplementation(() => ({
    getSelectorListWithFallback: jest.fn().mockReturnValue(['div[class*="container-"]']),
  })),
  MaintenanceProbe: { getInstance: jest.fn() },
}));

import { DouyinCrawler } from '../douyinCrawler';

describe('scrollExpandAndFindTarget budget', () => {
  it('breaks within budget when search is slow (does not run full 30 rounds)', async () => {
    const crawler = new DouyinCrawler('fp_test') as any;
    // findRootCommentByUsernameContent 永远找不到，tryExpandMoreAndScroll 永远返回 true（不停滚）
    crawler.findRootCommentByUsernameContent = jest.fn().mockResolvedValue(null);
    crawler.tryExpandMoreAndScroll = jest.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 4000));
      return true;
    });
    crawler.finalSweepByUsernameContent = jest.fn().mockResolvedValue(null);
    crawler.scrollCommentArea = jest.fn().mockResolvedValue(true);

    const target = { username: 'u', text: 't', level: 1 } as any;
    const start = Date.now();
    const result = await crawler.scrollExpandAndFindTarget({} as any, target);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // 预算 90s，每轮 4s → 应在 ~24 轮内退出，远小于 30 轮的 120s
    expect(elapsed).toBeLessThan(100_000);
    expect(crawler.tryExpandMoreAndScroll.mock.calls.length).toBeLessThan(30);
  });
});
