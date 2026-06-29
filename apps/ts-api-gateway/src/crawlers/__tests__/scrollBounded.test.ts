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

jest.mock('../../lib/antiDetectionMode', () => ({
  isAntiDetectionV2: jest.fn().mockReturnValue(false),
  isEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('@social-media/browser-core', () => ({
  // 被测方法
  HumanActions: {
    cdpSmartScroll: cdpSmartScrollMock,
    cdpGetDocumentScrollState: getScrollStateMock,
    safeEvaluate: jest.fn(),
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

  it('top: skips scroll when already at top (scrollY<=0)', async () => {
    // 已在顶部 → 前置边界检查命中，不触发任何滚动动画
    getScrollStateMock.mockResolvedValue({ scrollY: 0, clientHeight: 1305, scrollHeight: 3052 });
    const page = {} as any;
    const crawler = new DouyinCrawler('fp_test');
    const result = await (crawler as any).scrollCommentArea(page, 'top');
    expect(result).toBe(true);
    expect(cdpSmartScrollMock).not.toHaveBeenCalled();
  });

  it('bottom: skips scroll when already at bottom', async () => {
    // 4200+800=5000 >= 5000-10 → 已到底，不触发滚动
    getScrollStateMock.mockResolvedValue({ scrollY: 4200, clientHeight: 800, scrollHeight: 5000 });
    const page = {} as any;
    const crawler = new DouyinCrawler('fp_test');
    const result = await (crawler as any).scrollCommentArea(page, 'bottom');
    expect(result).toBe(true);
    expect(cdpSmartScrollMock).not.toHaveBeenCalled();
  });

  it('top: scrolls when not at boundary', async () => {
    // scrollY=500 不在顶部 → 进入循环，触发滚动
    getScrollStateMock.mockResolvedValue({ scrollY: 500, clientHeight: 1305, scrollHeight: 3052 });
    const page = {} as any;
    const crawler = new DouyinCrawler('fp_test');
    await (crawler as any).scrollCommentArea(page, 'top');
    expect(cdpSmartScrollMock).toHaveBeenCalled();
  });
});

describe('tryExpandMoreAndScroll reads document bottom', () => {
  beforeEach(() => {
    cdpSmartScrollMock.mockClear();
    getScrollStateMock.mockClear();
  });

  it('returns false when document at bottom (not tabs-content)', async () => {
    getScrollStateMock.mockResolvedValue({ scrollY: 1747, clientHeight: 1305, scrollHeight: 3052 });
    const page = { evaluate: jest.fn().mockResolvedValue(null) } as any;
    const crawler = new DouyinCrawler('fp_test') as any;
    crawler.injectEsbuildPolyfill = jest.fn().mockResolvedValue(undefined);
    const result = await crawler.tryExpandMoreAndScroll(page, 1);
    expect(result).toBe(false); // 1747+1305=3052 >= 3052-10 → 到底
    expect(cdpSmartScrollMock).not.toHaveBeenCalled();  // 到底不滚
  });

  it('scrolls page (empty selectors) and returns true when not at bottom', async () => {
    getScrollStateMock.mockResolvedValue({ scrollY: 800, clientHeight: 1305, scrollHeight: 3052 });
    const page = { evaluate: jest.fn().mockResolvedValue(null) } as any;
    const crawler = new DouyinCrawler('fp_test') as any;
    crawler.injectEsbuildPolyfill = jest.fn().mockResolvedValue(undefined);
    const result = await crawler.tryExpandMoreAndScroll(page, 1);
    expect(result).toBe(true);
    // ★ 关键断言：走空 selectors 强制页面滚动（不走 inner 容器）
    expect(cdpSmartScrollMock).toHaveBeenCalledWith(
      page, [], expect.any(Number), 'down'
    );
  });
});
