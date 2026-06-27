// Mock shared-config before anything else — prevents module-load-time config validation
jest.mock('@social-media/shared-config', () => ({
  isProduction: () => false,
  loadConfig: () => ({}),
  getConfig: () => ({}),
  PlatformName: {},
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../lib/browserManager', () => ({
  getBrowserManager: () => ({
    connect: jest.fn().mockResolvedValue({
      browser: {},
      page: {
        url: () => 'https://creator.douyin.com',
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue({ dataCids: 1, commentTexts: 0, bodyLen: 0 }),
      },
    }),
    disconnectSession: jest.fn(),
  }),
}));

jest.mock('../../lib/taskExecutionRecorder', () => ({
  updatePhase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: {
    comment: { findFirst: jest.fn().mockResolvedValue(null) },
    videoRootCommentCount: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock('../wechatBotService', () => ({
  botManager: {},
}));

// douyinCrawler: mock the DouyinCrawler class so that new DouyinCrawler()
// returns an instance whose replyToComment hangs forever.
// getDouyinCrawler() in monitorService.ts creates instances via `new DouyinCrawler()`.
jest.mock('../../crawlers/douyinCrawler', () => ({
  DouyinCrawler: jest.fn().mockImplementation(() => ({
    navigateToCreatorHome: jest.fn(),
    navigateToCommentManage: jest.fn().mockResolvedValue(true),
    openSelectWorkDrawer: jest.fn().mockResolvedValue(false),
    findAndClickVideoInDrawer: jest.fn(),
    isDrawerVisible: jest.fn(),
    closeDrawer: jest.fn(),
    replyToComment: jest.fn().mockImplementation(() => new Promise(() => {})),
  })),
  ReplyTarget: {},
}));

import { executeReplyAction } from '../monitorService';

describe('executeReplyAction douyin step timeout', () => {
  it('rejects with timeout when replyToComment hangs', async () => {
    // Override setTimeout to fire immediately — accelerates the 2min step timeout
    // so the test completes within the 15s jest timeout.
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: any, _ms?: any, ...args: any[]) => {
      return originalSetTimeout(fn, 0, ...args);
    }) as typeof global.setTimeout;

    try {
      const task = {
        userId: 1,
        platform: 'douyin' as const,
        windowId: 'fp_test',
        taskId: 'reply_test',
      };
      const replyData = { videoId: 'v1', commentCid: 'c1', text: 'hi' };
      await expect(executeReplyAction(task, replyData, 'exec_test')).rejects.toThrow('定位/执行回复超时');
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  }, 15000);
});
