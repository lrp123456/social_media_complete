jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'douyin',
}));

jest.mock('@social-media/browser-core', () => ({
  HumanActions: { wait: jest.fn().mockResolvedValue(undefined) },
  BrowserManager: jest.fn(),
  ExitStrategy: { getQuerySource: jest.fn().mockReturnValue('work_list'), getNextPageAction: jest.fn() },
  getLoginHost: jest.fn().mockReturnValue(''),
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  RequestInterceptor: jest.fn(),
  LoginTabRegistry: jest.fn(),
  PageType: 'unknown',
  SelectorReader: jest.fn(),
  MaintenanceProbe: { getInstance: jest.fn() },
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: { platformAccount: { findUnique: jest.fn().mockResolvedValue(null) } },
}));

jest.mock('../../lib/redis', () => ({
  getRedis: () => ({ del: jest.fn(), get: jest.fn().mockResolvedValue(null), set: jest.fn() }),
}));

jest.mock('../../lib/browserManager', () => ({
  getBrowserManager: () => ({ getBrowser: jest.fn() }),
}));

jest.mock('../wechatBotService', () => ({
  botManager: { sendLoginAlert: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../loginFlowHelpers', () => ({
  getFlowIdsForPlatform: jest.fn().mockReturnValue(['creator']),
  getLoginFlowConfig: jest.fn(),
  loginTabRegistry: { find: jest.fn(), captureQR: jest.fn() },
}));

jest.mock('../monitorDatabaseService', () => ({
  getCrawlMode: jest.fn().mockResolvedValue('simple'),
  getCrawlConfig: jest.fn().mockResolvedValue({ mode: 'simple', maxRootComments: 50 }),
  updateUserStatus: jest.fn(),
  logRiskScene: jest.fn(),
  insertCommentRecord: jest.fn(),
  updateMonitorProgress: jest.fn(),
}));

jest.mock('../../routes/config-automation', () => ({
  getCrawlConfig: jest.fn().mockResolvedValue({ mode: 'simple', maxRootComments: 50 }),
}));

jest.mock('../unifiedQueue', () => ({
  getWindowQueue: jest.fn(),
  enqueueMonitor: jest.fn(),
  cancelledJobIds: new Set(),
  markJobCancelled: jest.fn(),
  isJobCancelled: jest.fn().mockReturnValue(false),
  cleanupCancelledJob: jest.fn(),
}));

const mockNavigateToCreatorHome = jest.fn().mockResolvedValue(undefined);
const mockCheckForUpdates = jest.fn().mockResolvedValue({ commentsQueue: [], riskControlDetected: false });

jest.mock('../../crawlers/douyinCrawler', () => ({
  DouyinCrawler: jest.fn().mockImplementation(() => ({
    navigateToCreatorHome: mockNavigateToCreatorHome,
    registerListener: jest.fn().mockResolvedValue(undefined),
    unregisterListener: jest.fn(),
    checkForUpdates: mockCheckForUpdates,
    executeExitStrategy: jest.fn().mockResolvedValue(undefined),
  })),
  ReplyTarget: jest.fn(),
}));

import { runDouyinCheck } from '../monitorService';

describe('runDouyinCheck 入口导航', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('残留子页（/data/following/follower）→ 应触发 navigateToCreatorHome', async () => {
    const task = { userId: 6, windowId: 'w1', platform: 'douyin' } as any;
    const page = {
      url: jest.fn()
        .mockReturnValueOnce('https://creator.douyin.com/creator-micro/data/following/follower')
        .mockReturnValue('https://creator.douyin.com/creator-micro/home'),
    } as any;

    await runDouyinCheck(page, task);
    expect(mockNavigateToCreatorHome).toHaveBeenCalled();
  });

  it('已在 home 页 → 不触发 navigateToCreatorHome', async () => {
    const task = { userId: 6, windowId: 'w1', platform: 'douyin' } as any;
    const page = { url: jest.fn().mockReturnValue('https://creator.douyin.com/creator-micro/home') } as any;

    await runDouyinCheck(page, task);
    expect(mockNavigateToCreatorHome).not.toHaveBeenCalled();
  });
});
