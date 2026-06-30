import { describe, it, expect, jest } from '@jest/globals';

// ---- module-scope mocks ----
const mockPrismaFindUnique = jest.fn<() => Promise<unknown>>().mockResolvedValue({ wechatUserid: 'u', windowId: 'w1' });
const mockPrismaUpdate = jest.fn<() => Promise<unknown>>();
const mockSendLoginAlert = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
const mockUpdateUserStatus = jest.fn<() => Promise<unknown>>();
const mockGetCrawlConfig = jest.fn<() => Promise<unknown>>().mockResolvedValue({ mode: 'simple', maxRootComments: 50 });

jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'kuaishou',
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: {
    platformAccount: { findUnique: mockPrismaFindUnique, update: mockPrismaUpdate },
  },
}));

jest.mock('../loginFlowHelpers', () => ({
  getLoginFlowConfig: jest.fn<() => null>().mockReturnValue(null),
  ensureLoginTab: jest.fn<() => Promise<unknown>>(),
  getFlowIdsForPlatform: jest.fn<() => string[]>().mockReturnValue(['creator']),
  activatePlatformQR: jest.fn<() => Promise<unknown>>(),
  loadLoginFlowConfig: jest.fn<() => unknown[]>().mockReturnValue([]),
  loginTabRegistry: { find: jest.fn(), register: jest.fn(), captureQR: jest.fn<() => Promise<null>>().mockResolvedValue(null), openLoginTab: jest.fn() },
}));

jest.mock('../wechatBotService', () => ({
  botManager: { sendLoginAlert: mockSendLoginAlert },
}));

jest.mock('../monitorDatabaseService', () => ({
  updateUserStatus: mockUpdateUserStatus,
  getCrawlMode: jest.fn<() => Promise<unknown>>().mockResolvedValue('simple'),
}));

jest.mock('../../routes/config-automation', () => ({
  getCrawlConfig: mockGetCrawlConfig,
}));

// KuaishouCrawler mock — both V1 (returns undefined) and V2 (returns true by default)
jest.mock('../../crawlers/kuaishouCrawler', () => ({
  KuaishouCrawler: jest.fn().mockImplementation(() => ({
    detectKuaishouLogin: jest.fn(),
    detectKuaishouLoginV2: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    navigateToHome: jest.fn(),
    checkForUpdates: jest.fn<() => Promise<{ commentsQueue: unknown[]; riskControlDetected: boolean }>>().mockResolvedValue({ commentsQueue: [], riskControlDetected: false }),
    executeExitStrategy: jest.fn(),
    registerListener: jest.fn(),
    unregisterListener: jest.fn(),
  })),
}));

import { runKuaishouCheck } from '../monitorService';

describe('runKuaishouCheck Phase0 V2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('detectKuaishouLoginV2 已登录 → 进入 Phase1', async () => {
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video' } as any;
    const task = { userId: 1, windowId: 'w1', platform: 'kuaishou' } as any;
    const result = await runKuaishouCheck(page, task, undefined);
    // Phase0 走完进入 Phase1
    expect(result.phase).toBeDefined();
  });

  it('detectKuaishouLoginV2 抛 UNKNOWN_EXCEPTION → runKuaishouCheck 透传抛错', async () => {
    // 重置 mock：只提供 V2，让它抛 UNKNOWN_EXCEPTION
    // 注意：getKuaishouCrawler 有缓存，测试间用不同 windowId 避免取到旧实例
    const KuaishouCrawler = require('../../crawlers/kuaishouCrawler').KuaishouCrawler;
    KuaishouCrawler.mockImplementation(() => ({
      detectKuaishouLoginV2: jest.fn<() => Promise<boolean>>().mockRejectedValue(
        new Error('UNKNOWN_EXCEPTION: account/current 风控/限流 403'),
      ),
    }));

    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video' } as any;
    const task = { userId: 2, windowId: 'w2', platform: 'kuaishou' } as any;
    await expect(
      runKuaishouCheck(page, task, undefined),
    ).rejects.toThrow(/UNKNOWN_EXCEPTION/);
  });
});
