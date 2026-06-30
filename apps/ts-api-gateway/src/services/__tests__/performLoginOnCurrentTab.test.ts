import { describe, it, expect, jest } from '@jest/globals';

// ── Module mocks ──────────────────────────────────────────────

jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

const mockPrismaFindUnique = jest.fn<() => Promise<unknown>>();
jest.mock('../../lib/prisma', () => ({
  prisma: { platformAccount: { findUnique: mockPrismaFindUnique } },
}));

const mockSendLoginAlert = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
jest.mock('../wechatBotService', () => ({
  botManager: { sendLoginAlert: mockSendLoginAlert },
}));

const mockCaptureQR = jest.fn<() => Promise<Buffer | null>>();
const mockGetLoginFlowConfig = jest.fn<() => unknown>();
const mockActivatePlatformQR = jest.fn<() => Promise<unknown>>().mockResolvedValue(true);
jest.mock('../loginFlowHelpers', () => ({
  loginTabRegistry: { captureQR: mockCaptureQR },
  getLoginFlowConfig: mockGetLoginFlowConfig,
  activatePlatformQR: mockActivatePlatformQR,
}));

jest.mock('@social-media/browser-core', () => ({
  HumanActions: {
    exists: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    click: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));

const mockClickLoginEntry = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
jest.mock('../../crawlers/kuaishouCrawler', () => ({
  KuaishouCrawler: jest.fn().mockImplementation(() => ({
    clickLoginEntry: mockClickLoginEntry,
  })),
}));

// ── Module under test ─────────────────────────────────────────

import { performLoginOnCurrentTab } from '../monitorService';

// ── Shared test fixture ───────────────────────────────────────

const mockConfig = {
  loginUrl: 'https://example.com/login',
  domain: 'example.com',
  loginDomain: 'example.com',
  qrActivationSelector: '.qr-login',
};

// ── Tests ─────────────────────────────────────────────────────

describe('performLoginOnCurrentTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaFindUnique.mockResolvedValue({ wechatUserid: 'u', windowId: 1, window: { externalId: 'w1' } });
    mockGetLoginFlowConfig.mockReturnValue(mockConfig);
    mockCaptureQR.mockResolvedValue(Buffer.from([1]));
  });

  it('抖音：当前页已是登录域 → 直接 activatePlatformQR + captureQR + 发企微', async () => {
    const page = { url: () => 'https://creator.douyin.com/creator-micro/login' } as any;

    await performLoginOnCurrentTab(page, 1, 'douyin');

    expect(mockActivatePlatformQR).toHaveBeenCalledWith(page, 'douyin', mockConfig);
    expect(mockCaptureQR).toHaveBeenCalledWith(page, mockConfig);
    expect(mockSendLoginAlert).toHaveBeenCalledWith('u', 'douyin', 1, expect.any(Buffer), 'creator');
  });

  it('快手：当前页 cp 域 → clickLoginEntry 跳登录页后截 QR', async () => {
    const page = {
      url: jest.fn().mockReturnValue('https://cp.kuaishou.com/article/publish/video'),
    } as any;

    await performLoginOnCurrentTab(page, 1, 'kuaishou');

    expect(mockClickLoginEntry).toHaveBeenCalledWith(page);
    expect(mockCaptureQR).toHaveBeenCalledWith(page, mockConfig);
    expect(mockSendLoginAlert).toHaveBeenCalledWith('u', 'kuaishou', 1, expect.any(Buffer), 'creator');
  });

  it('captureQR 返回 null → 抛错（不 fallback 截图）', async () => {
    mockCaptureQR.mockResolvedValue(null);
    const page = { url: () => 'https://cp.kuaishou.com/some-other' } as any;

    await expect(performLoginOnCurrentTab(page, 1, 'kuaishou')).rejects.toThrow(/截图失败|captureQR/);
  });
});
