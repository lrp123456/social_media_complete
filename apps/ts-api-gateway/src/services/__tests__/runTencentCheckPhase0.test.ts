import { describe, it, expect, jest } from '@jest/globals';

const mockIsProduction = jest.fn<() => boolean>().mockReturnValue(false);
const mockIsDevelopment = jest.fn<() => boolean>().mockReturnValue(false);
const mockGetConfig = jest.fn<() => unknown>().mockReturnValue({ NODE_ENV: 'test' });
const mockLoadConfig = jest.fn<() => unknown>().mockReturnValue({ NODE_ENV: 'test' });
const mockPrismaFindUnique = jest.fn<() => Promise<unknown>>();
const mockPrismaUpdate = jest.fn<() => Promise<unknown>>();
const mockCrawlSettingFindUnique = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const mockGetCrawlConfig = jest.fn<() => Promise<unknown>>().mockResolvedValue({ mode: 'simple', maxRootComments: 50 });
const mockSendLoginAlert = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
const mockGetFlowIdsForPlatform = jest.fn<() => string[]>().mockReturnValue(['creator']);
const mockGetCrawlMode = jest.fn<() => Promise<unknown>>().mockResolvedValue('simple');

jest.mock('@social-media/shared-config', () => ({
  isProduction: mockIsProduction,
  isDevelopment: mockIsDevelopment,
  getConfig: mockGetConfig,
  loadConfig: mockLoadConfig,
  PlatformName: 'douyin',
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: {
    platformAccount: { findUnique: mockPrismaFindUnique, update: mockPrismaUpdate },
    crawlSetting: { findUnique: mockCrawlSettingFindUnique },
  },
}));
jest.mock('../../routes/config-automation', () => ({
  getCrawlConfig: mockGetCrawlConfig,
}));
jest.mock('../../lib/redis', () => ({ getRedis: () => ({ del: jest.fn(), get: jest.fn(), set: jest.fn() }) }));
jest.mock('../wechatBotService', () => ({ botManager: { sendLoginAlert: mockSendLoginAlert } }));
jest.mock('../loginFlowHelpers', () => ({
  getFlowIdsForPlatform: mockGetFlowIdsForPlatform,
  getLoginFlowConfig: jest.fn(),
  loginTabRegistry: { find: jest.fn(), captureQR: jest.fn() },
}));

const mockUpdateUserStatus = jest.fn<() => Promise<unknown>>();
jest.mock('../monitorDatabaseService', () => ({
  getCrawlMode: mockGetCrawlMode,
  updateUserStatus: mockUpdateUserStatus,
}));

const mockDetectTencentLogin = jest.fn<() => Promise<boolean>>();
const mockRegisterListener = jest.fn<() => Promise<unknown>>();
const mockUnregisterListener = jest.fn<() => Promise<unknown>>();
const mockCheckForUpdates = jest.fn<() => Promise<unknown>>().mockResolvedValue({ commentsQueue: [], riskControlDetected: false });
const mockExecuteExitStrategy = jest.fn<() => Promise<unknown>>();

jest.mock('../../crawlers/tencentCrawler', () => ({
  TencentCrawler: jest.fn().mockImplementation(() => ({
    detectTencentLogin: mockDetectTencentLogin,
    registerListener: mockRegisterListener,
    unregisterListener: mockUnregisterListener,
    checkForUpdates: mockCheckForUpdates,
    executeExitStrategy: mockExecuteExitStrategy,
  })),
}));

import { runTencentCheck } from '../monitorService';

describe('runTencentCheck Phase0', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckForUpdates.mockResolvedValue({ commentsQueue: [], riskControlDetected: false });
  });

  it('未登录 → 标 login_required + return，不阻塞 handleLogin', async () => {
    mockDetectTencentLogin.mockResolvedValue(false);
    const task = { userId: 11, windowId: 'w1', platform: 'tencent' } as any;
    const page = { url: () => 'https://channels.weixin.qq.com/platform/home' } as any;
    const result = await runTencentCheck(page, task);
    expect(result.hasUpdate).toBe(false);
    expect(mockUpdateUserStatus).toHaveBeenCalledWith(11, 'login_required');
  });

  it('已登录 → 继续（不调 updateUserStatus）', async () => {
    mockDetectTencentLogin.mockResolvedValue(true);
    const task = { userId: 11, windowId: 'w1', platform: 'tencent' } as any;
    const page = { url: () => 'https://channels.weixin.qq.com/platform/cgi-bin/login' } as any;
    await runTencentCheck(page, task);
    expect(mockUpdateUserStatus).not.toHaveBeenCalled();
    expect(mockCheckForUpdates).toHaveBeenCalled();
  });
});
