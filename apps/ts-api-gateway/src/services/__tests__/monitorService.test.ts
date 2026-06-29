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

const getBrowserMock = jest.fn();
jest.mock('@social-media/browser-core', () => ({
  HumanActions: { wait: jest.fn().mockResolvedValue(undefined), cdpIsElementVisible: jest.fn().mockResolvedValue(false), cdpClick: jest.fn() },
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
  LoginTabRegistry: jest.fn(),
  RequestInterceptor: jest.fn(),
  BrowserManager: jest.fn(),
  ExitStrategy: { getQuerySource: jest.fn(), getNextPageAction: jest.fn() },
  PageType: 'unknown',
  SelectorReader: jest.fn(),
  MaintenanceProbe: { getInstance: jest.fn() },
}));

jest.mock('../../lib/browserManager', () => ({
  getBrowserManager: () => ({ getBrowser: getBrowserMock }),
}));

jest.mock('../loginFlowHelpers', () => ({
  loginTabRegistry: {
    find: jest.fn(),
    openLoginTab: jest.fn(),
    captureQR: jest.fn().mockResolvedValue(null),
  },
  getLoginFlowConfig: jest.fn().mockReturnValue({ loginUrl: 'https://example.com/login', domain: 'example.com' }),
  ensureLoginTab: jest.fn().mockImplementation(async (windowId: string) => {
    // Simulate what ensureLoginTab does: getBrowser via the mocked browserManager
    const bmModule = jest.requireMock('../../lib/browserManager');
    const bm = bmModule.getBrowserManager();
    await bm.getBrowser(windowId);
    return null;
  }),
}));

jest.mock('../wechatBotService', () => ({
  botManager: { sendLoginAlert: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

const mockPage = { url: jest.fn().mockReturnValue('https://example.com/some-page') };

jest.mock('../../lib/oss', () => ({
  uploadBufferToOSS: jest.fn().mockResolvedValue('https://oss.example.com/qr.png'),
  OSS_DIRS: { QR_CODE: 'qr' },
}));

const prismaMock = {
  platformAccount: {
    findUnique: jest.fn().mockResolvedValue({
      wechatUserid: 'wx1',
      windowId: 4,
      window: { externalId: '68a259626bb2c5905ffed8116e9a2a04' },
    }),
  },
};
jest.mock('../../lib/prisma', () => ({ prisma: prismaMock }));

import { sendLoginQR } from '../monitorService';

describe('sendLoginQR windowId', () => {
  it('uses window.externalId (not DB windowId) for getBrowser', async () => {
    getBrowserMock.mockResolvedValue(null);
    await sendLoginQR(mockPage as any, 6, 'douyin', 'creator');
    expect(getBrowserMock).toHaveBeenCalledWith('68a259626bb2c5905ffed8116e9a2a04');
  });
});
