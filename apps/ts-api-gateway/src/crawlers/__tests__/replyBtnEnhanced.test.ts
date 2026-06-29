const cdpSmartScrollMock = jest.fn().mockResolvedValue(undefined);

const stubLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => stubLogger),
};

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
  HumanActions: {
    cdpSmartScroll: cdpSmartScrollMock,
    cdpGetDocumentScrollState: jest.fn().mockResolvedValue(null),
    safeEvaluate: jest.fn(),
    wait: jest.fn().mockResolvedValue(undefined),
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

describe('scrollExpandAndFindTarget level=1 replyBtn', () => {
  it('returns replyBtn directly when findRootComment returns it, no findReplyBtnInContainer call', async () => {
    const crawler = new DouyinCrawler('fp_test') as any;
    const replyBtn = { x: 100, y: 200 };
    crawler.findRootCommentByUsernameContent = jest.fn().mockResolvedValue({
      x: 1, y: 2, containerSel: 'div[class*="container-"]',
      isExpanded: false, subReplyCountInPage: 0, replyBtn,
    });
    crawler.findReplyBtnInContainer = jest.fn();
    crawler.scrollRootIntoView = jest.fn();
    crawler.scrollCommentArea = jest.fn().mockResolvedValue(true);
    crawler.tryExpandMoreAndScroll = jest.fn();
    crawler.injectEsbuildPolyfill = jest.fn().mockResolvedValue(undefined);

    const target = { username: 'u', text: 't', level: 1 } as any;
    const result = await crawler.scrollExpandAndFindTarget({} as any, target);

    expect(result).toEqual(replyBtn);
    expect(crawler.findReplyBtnInContainer).not.toHaveBeenCalled();
    expect(crawler.scrollRootIntoView).not.toHaveBeenCalled();
  });

  it('falls back to scrollRootIntoView + retry when replyBtn is null', async () => {
    const crawler = new DouyinCrawler('fp_test') as any;
    const replyBtn2 = { x: 150, y: 250 };
    crawler.findRootCommentByUsernameContent = jest.fn()
      .mockResolvedValueOnce({ x: 1, y: 2, containerSel: 'div[class*="container-"]', isExpanded: false, subReplyCountInPage: 0, replyBtn: null })
      .mockResolvedValueOnce({ x: 1, y: 2, containerSel: 'div[class*="container-"]', isExpanded: false, subReplyCountInPage: 0, replyBtn: replyBtn2 });
    crawler.findReplyBtnInContainer = jest.fn();
    crawler.scrollRootIntoView = jest.fn().mockResolvedValue(undefined);
    crawler.scrollCommentArea = jest.fn().mockResolvedValue(true);
    crawler.tryExpandMoreAndScroll = jest.fn();
    crawler.injectEsbuildPolyfill = jest.fn().mockResolvedValue(undefined);

    const target = { username: 'u', text: 't', level: 1 } as any;
    const result = await crawler.scrollExpandAndFindTarget({} as any, target);

    expect(result).toEqual(replyBtn2);
    expect(crawler.scrollRootIntoView).toHaveBeenCalledTimes(1);
    expect(crawler.findReplyBtnInContainer).not.toHaveBeenCalled();
  });
});
