import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'douyin',
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: {
    platformAccount: { findUnique: jest.fn(), update: jest.fn() },
    crawlSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}));
jest.mock('../../routes/config-automation', () => ({
  getCrawlConfig: jest.fn().mockResolvedValue({ mode: 'simple', maxRootComments: 50 }),
}));
jest.mock('../../lib/redis', () => ({ getRedis: () => ({ del: jest.fn(), get: jest.fn(), set: jest.fn() }) }));
jest.mock('../wechatBotService', () => ({ botManager: { sendLoginAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../loginFlowHelpers', () => ({
  getFlowIdsForPlatform: jest.fn().mockReturnValue(['creator']),
  getLoginFlowConfig: jest.fn(),
  loginTabRegistry: { find: jest.fn(), captureQR: jest.fn() },
}));

const mockUpdateUserStatus = jest.fn();
jest.mock('../monitorDatabaseService', () => ({
  getCrawlMode: jest.fn().mockResolvedValue('simple'),
  updateUserStatus: mockUpdateUserStatus,
}));

const mockDetectTencentLogin = jest.fn();
const mockRegisterListener = jest.fn();
const mockUnregisterListener = jest.fn();
const mockCheckForUpdates = jest.fn().mockResolvedValue({ commentsQueue: [], riskControlDetected: false });
const mockExecuteExitStrategy = jest.fn();

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
