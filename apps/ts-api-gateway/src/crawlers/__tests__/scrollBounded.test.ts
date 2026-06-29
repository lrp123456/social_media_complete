const cdpSmartScrollMock = jest.fn().mockResolvedValue(undefined);
const getScrollStateMock = jest.fn();

// 根日志桩：满足 menuSelectors / browser-core 内部模块的需求
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
  PlatformName: 'douyin',
}));

jest.mock('@social-media/browser-core', () => ({
  // 被测方法
  HumanActions: {
    cdpSmartScroll: cdpSmartScrollMock,
    cdpGetDocumentScrollState: getScrollStateMock,
    wait: jest.fn().mockResolvedValue(undefined),
  },
  // logger 桩
  rootLogger: stubLogger,
  // 构造函数桩（被测方法不涉及具体逻辑）
  RequestInterceptor: jest.fn(),
  BrowserManager: jest.fn(),
  ExitStrategy: class {
    static getQuerySource = jest.fn();
    static getNextPageAction = jest.fn();
  },
  // 类型（运行时仅需存在，值无关紧要）
  PageType: 'unknown',
  SelectorReader: jest.fn(),
  // MaintenanceProbe 由 douyinCrawler 顶层静态调用
  MaintenanceProbe: { getInstance: jest.fn() },
}));

import { DouyinCrawler } from '../douyinCrawler';

describe('scrollCommentArea bounded', () => {
  beforeEach(() => {
    cdpSmartScrollMock.mockClear();
    getScrollStateMock.mockClear();
  });

  it('top: stops when scrollY<=0, never passes 99999', async () => {
    // 第一次读文档状态即返回已到顶
    getScrollStateMock.mockResolvedValue({ scrollY: 0, clientHeight: 1305, scrollHeight: 3052 });
    const page = {} as any;
    const crawler = new DouyinCrawler('fp_test');
    await (crawler as any).scrollCommentArea(page, 'top');

    // cdpSmartScroll 入参不应出现 99999
    for (const call of cdpSmartScrollMock.mock.calls) {
      expect(call[2]).toBeLessThan(99999);
    }
    expect(cdpSmartScrollMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('bottom: stops when at bottom', async () => {
    getScrollStateMock.mockResolvedValue({ scrollY: 4200, clientHeight: 800, scrollHeight: 5000 });
    const page = {} as any;
    const crawler = new DouyinCrawler('fp_test');
    await (crawler as any).scrollCommentArea(page, 'bottom');
    for (const call of cdpSmartScrollMock.mock.calls) {
      expect(call[2]).toBeLessThan(99999);
    }
  });
});
