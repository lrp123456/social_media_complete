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
const mockGetLoginFlowConfig = jest.fn<() => unknown>().mockReturnValue({
  loginUrl: 'https://passport.kuaishou.com/pc/account/login/',
  domain: 'kuaishou.com',
  loginDomain: 'kuaishou.com',
});
const mockCaptureQR = jest.fn<() => Promise<Buffer | null>>().mockResolvedValue(Buffer.from([1]));
const mockClickLoginEntry = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);

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
jest.mock('../../lib/redis', () => ({ getRedis: () => ({ del: jest.fn(), get: jest.fn(), set: jest.fn() }) }));
jest.mock('../wechatBotService', () => ({ botManager: { sendLoginAlert: mockSendLoginAlert } }));
jest.mock('../loginFlowHelpers', () => ({
  getFlowIdsForPlatform: mockGetFlowIdsForPlatform,
  getLoginFlowConfig: mockGetLoginFlowConfig,
  loginTabRegistry: { find: jest.fn(), captureQR: mockCaptureQR },
}));

const mockUpdateUserStatus = jest.fn<() => Promise<unknown>>();
jest.mock('../monitorDatabaseService', () => ({
  getCrawlMode: mockGetCrawlMode,
  updateUserStatus: mockUpdateUserStatus,
}));
jest.mock('../../routes/config-automation', () => ({
  getCrawlConfig: mockGetCrawlConfig,
}));

const mockDetectKuaishouLoginV2 = jest.fn<() => Promise<boolean>>();
const mockNavigateToHome = jest.fn<() => Promise<unknown>>();
const mockRegisterListener = jest.fn<() => Promise<unknown>>();
const mockUnregisterListener = jest.fn<() => Promise<unknown>>();
const mockCheckForUpdates = jest.fn<() => Promise<unknown>>().mockResolvedValue({ commentsQueue: [], riskControlDetected: false });
const mockExecuteExitStrategy = jest.fn<() => Promise<unknown>>();

jest.mock('../../crawlers/kuaishouCrawler', () => ({
  KuaishouCrawler: jest.fn().mockImplementation(() => ({
    detectKuaishouLoginV2: mockDetectKuaishouLoginV2,
    navigateToHome: mockNavigateToHome,
    registerListener: mockRegisterListener,
    unregisterListener: mockUnregisterListener,
    checkForUpdates: mockCheckForUpdates,
    executeExitStrategy: mockExecuteExitStrategy,
    clickLoginEntry: mockClickLoginEntry,
  })),
}));

import { runKuaishouCheck } from '../monitorService';
import { botManager } from '../wechatBotService';
import { prisma } from '../../lib/prisma';

describe('runKuaishouCheck Phase0', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckForUpdates.mockResolvedValue({ commentsQueue: [], riskControlDetected: false });
  });

  it('未登录 → 标 login_required + return，不阻塞', async () => {
    mockDetectKuaishouLoginV2.mockResolvedValue(false);
    mockPrismaFindUnique.mockResolvedValue({ wechatUserid: 'test-user', windowId: 'w1' });
    const task = { userId: 11, windowId: 'w1', platform: 'kuaishou' } as any;
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video' } as any;
    const result = await runKuaishouCheck(page, task);
    expect(result.hasUpdate).toBe(false);
    expect(mockUpdateUserStatus).toHaveBeenCalledWith(11, 'login_required');
    expect(botManager.sendLoginAlert).toHaveBeenCalled();
  });

  it('已登录 → 继续（不调 updateUserStatus）', async () => {
    mockDetectKuaishouLoginV2.mockResolvedValue(true);
    const task = { userId: 11, windowId: 'w1', platform: 'kuaishou' } as any;
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video' } as any;
    await runKuaishouCheck(page, task);
    expect(mockUpdateUserStatus).not.toHaveBeenCalled();
    expect(mockRegisterListener).toHaveBeenCalled();
  });
});
