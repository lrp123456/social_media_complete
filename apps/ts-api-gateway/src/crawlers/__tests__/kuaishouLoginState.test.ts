const updateUserStatusMock = jest.fn().mockResolvedValue(undefined);

jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'kuaishou',
}));

jest.mock('../../lib/antiDetectionMode', () => ({
  isAntiDetectionV2: jest.fn().mockReturnValue(false),
  isEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('@social-media/browser-core', () => ({
  HumanActions: {
    wait: jest.fn().mockResolvedValue(undefined),
    safeEvaluate: jest.fn(),
    exists: jest.fn().mockResolvedValue(false),
    click: jest.fn().mockResolvedValue(undefined),
    cdpGetBodyText: jest.fn().mockResolvedValue(''),
  },
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() },
  RequestInterceptor: jest.fn(),
  BrowserManager: jest.fn(),
  ExitStrategy: class {
    static getQuerySource = jest.fn();
    static getNextPageAction = jest.fn();
  },
  PageType: 'unknown',
  SelectorReader: jest.fn(),
  MaintenanceProbe: { getInstance: jest.fn() },
}));

jest.mock('../../services/monitorDatabaseService', () => ({
  updateUserStatus: updateUserStatusMock,
  getAllActiveUsers: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: {
    platformAccount: {
      findUnique: jest.fn().mockResolvedValue({ wechatUserid: null, windowId: null }),
    },
  },
}));

import { KuaishouCrawler } from '../kuaishouCrawler';

describe('kuaishou handleLogin login_required', () => {
  it('sets status to login_required when login required', async () => {
    const page = {
      url: jest.fn().mockReturnValue('https://cp.kuaishou.com/article/publish/video'),
      goto: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn(() => ({ count: jest.fn().mockResolvedValue(0), first: { click: jest.fn() } })),
    } as any;

    const crawler = new KuaishouCrawler(20) as any;
    crawler.checkLoginStatus = jest.fn().mockResolvedValue(false);
    crawler.captureAndSendQR = jest.fn().mockRejectedValue(new Error('stop'));

    await crawler.handleLogin(page, 11).catch(() => {});

    expect(updateUserStatusMock).toHaveBeenCalledWith(11, 'login_required');
  });
});
