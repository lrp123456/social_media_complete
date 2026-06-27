const cdpSmartScrollMock = jest.fn().mockResolvedValue(undefined);
const evaluateMock = jest.fn();

// 根日志桩：满足 menuSelectors / browser-core 内部模块的需求
const stubLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => stubLogger),
};

jest.mock('@social-media/browser-core', () => ({
  // 被测方法
  HumanActions: {
    cdpSmartScroll: cdpSmartScrollMock,
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
    evaluateMock.mockClear();
  });

  it('top: stops when scrollTop<=0, never passes 99999', async () => {
    // 第一轮 evaluate 返回已到顶
    evaluateMock.mockResolvedValue({ scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });
    const page = { evaluate: evaluateMock } as any;
    const crawler = new DouyinCrawler('fp_test');
    await (crawler as any).scrollCommentArea(page, 'top');

    // cdpSmartScroll 入参不应出现 99999
    for (const call of cdpSmartScrollMock.mock.calls) {
      expect(call[2]).toBeLessThan(99999);
    }
    expect(cdpSmartScrollMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('bottom: stops when at bottom', async () => {
    evaluateMock.mockResolvedValue({ scrollTop: 4200, scrollHeight: 5000, clientHeight: 800 });
    const page = { evaluate: evaluateMock } as any;
    const crawler = new DouyinCrawler('fp_test');
    await (crawler as any).scrollCommentArea(page, 'bottom');
    for (const call of cdpSmartScrollMock.mock.calls) {
      expect(call[2]).toBeLessThan(99999);
    }
  });
});
