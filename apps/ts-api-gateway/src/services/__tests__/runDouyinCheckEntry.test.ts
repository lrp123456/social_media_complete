import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'douyin',
}));

jest.mock('@social-media/browser-core', () => ({
  ExitStrategy: { getQuerySource: jest.fn().mockReturnValue('work_list'), getNextPageAction: jest.fn() },
  HumanActions: { wait: jest.fn().mockResolvedValue(undefined) },
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../lib/prisma', () => ({ prisma: { platformAccount: { findUnique: jest.fn().mockResolvedValue(null) } } }));
jest.mock('../../lib/redis', () => ({ getRedis: () => ({ del: jest.fn(), get: jest.fn(), set: jest.fn() }) }));
jest.mock('../wechatBotService', () => ({ botManager: { sendLoginAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../loginFlowHelpers', () => ({
  getFlowIdsForPlatform: jest.fn().mockReturnValue(['creator']),
  getLoginFlowConfig: jest.fn(),
  loginTabRegistry: { find: jest.fn(), captureQR: jest.fn() },
}));

jest.mock('../monitorDatabaseService', () => ({
  getCrawlMode: jest.fn().mockResolvedValue('simple'),
  getCrawlConfig: jest.fn().mockResolvedValue({ mode: 'simple', maxRootComments: 50 }),
  updateUserStatus: jest.fn(),
}));

jest.mock('../../routes/config-automation', () => ({
  getCrawlConfig: jest.fn().mockResolvedValue({ mode: 'simple', maxRootComments: 50 }),
}));

const mockNavigateToCreatorHome = jest.fn();
const mockCheckForUpdates = jest.fn().mockResolvedValue({ commentsQueue: [], riskControlDetected: false });

jest.mock('../../crawlers/douyinCrawler', () => ({
  DouyinCrawler: jest.fn().mockImplementation(() => ({
    navigateToCreatorHome: mockNavigateToCreatorHome,
    registerListener: jest.fn(),
    unregisterListener: jest.fn(),
    checkForUpdates: mockCheckForUpdates,
    executeExitStrategy: jest.fn(),
  })),
}));

import { runDouyinCheck } from '../monitorService';

describe('runDouyinCheck 入口导航', () => {
  beforeEach(() => jest.clearAllMocks());

  it('残留子页（/data/following/follower）→ 触发 navigateToCreatorHome 并进入 Phase1', async () => {
    const task = { userId: 6, windowId: 'w1', platform: 'douyin' } as any;
    const page = {
      url: jest.fn()
        .mockReturnValueOnce('https://creator.douyin.com/creator-micro/data/following/follower')
        .mockReturnValue('https://creator.douyin.com/creator-micro/home'),
    } as any;
    const result = await runDouyinCheck(page, task);
    expect(mockNavigateToCreatorHome).toHaveBeenCalledTimes(1);
    expect(result.hasUpdate).toBe(false);
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it('已在 home 页 → 不触发 navigateToCreatorHome', async () => {
    const task = { userId: 6, windowId: 'w1', platform: 'douyin' } as any;
    const page = { url: jest.fn().mockReturnValue('https://creator.douyin.com/creator-micro/home') } as any;
    const result = await runDouyinCheck(page, task);
    expect(mockNavigateToCreatorHome).not.toHaveBeenCalled();
    expect(result.hasUpdate).toBe(false);
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it('已在 content/manage 页 → 不触发 navigateToCreatorHome', async () => {
    const task = { userId: 6, windowId: 'w1', platform: 'douyin' } as any;
    const page = { url: jest.fn().mockReturnValue('https://creator.douyin.com/creator-micro/content/manage') } as any;
    const result = await runDouyinCheck(page, task);
    expect(mockNavigateToCreatorHome).not.toHaveBeenCalled();
    expect(result.hasUpdate).toBe(false);
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it('导航后仍不在工作页 → fast-fail（导航救不回来）', async () => {
    const task = { userId: 6, windowId: 'w1', platform: 'douyin' } as any;
    const page = {
      url: jest.fn()
        .mockReturnValueOnce('https://creator.douyin.com/creator-micro/data/following/follower')
        .mockReturnValue('https://creator.douyin.com/creator-micro/data/important/following'), // navigateToCreatorHome 失败后仍不在工作页
    } as any;
    const result = await runDouyinCheck(page, task);
    expect(mockNavigateToCreatorHome).toHaveBeenCalledTimes(1);
    expect(result.hasUpdate).toBe(false);
    expect(result.riskDetected).toBe(false);
    expect(mockCheckForUpdates).not.toHaveBeenCalled(); // fast-fail 了，不应进入 Phase1
  });
});
