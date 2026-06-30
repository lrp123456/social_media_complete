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

jest.mock('@social-media/browser-core', () => ({
  HumanActions: {
    cdpIsElementVisible: jest.fn(),
    cdpGetBodyText: jest.fn(),
    cdpClick: jest.fn(),
    exists: jest.fn(),
    click: jest.fn(),
    wait: jest.fn(),
    pageLoadBehavior: jest.fn(),
    clearCDPContext: jest.fn(),
  },
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
  RequestInterceptor: jest.fn(),
  ExitStrategy: { getQuerySource: jest.fn(), getNextPageAction: jest.fn() },
  PageType: 'other',
  MaintenanceProbe: { enterStep: jest.fn(), exitStep: jest.fn() },
}));

import { HumanActions } from '@social-media/browser-core';
import { KuaishouCrawler } from '../../crawlers/kuaishouCrawler';

describe('KuaishouCrawler.detectKuaishouLogin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('右上角 .user-info-dpd 可见 → 已登录', async () => {
    (HumanActions.cdpIsElementVisible as jest.Mock).mockResolvedValue(true);
    const ks = new KuaishouCrawler();
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video' } as any;
    const result = await ks.detectKuaishouLogin(page);
    expect(result).toBe(true);
    expect(HumanActions.cdpIsElementVisible).toHaveBeenCalledWith(page, '.user-info-dpd');
  });

  it('.user-info-dpd 不存在 → 未登录', async () => {
    (HumanActions.cdpIsElementVisible as jest.Mock).mockResolvedValue(false);
    const ks = new KuaishouCrawler();
    const page = { url: () => 'https://cp.kuaishou.com/profile' } as any;
    const result = await ks.detectKuaishouLogin(page);
    expect(result).toBe(false);
  });

  it('在 passport 登录页（无 .user-info-dpd）→ 未登录，不因 URL 含 passport 直接判', async () => {
    (HumanActions.cdpIsElementVisible as jest.Mock).mockResolvedValue(false);
    const ks = new KuaishouCrawler();
    const page = { url: () => 'https://passport.kuaishou.com/pc/account/login/' } as any;
    const result = await ks.detectKuaishouLogin(page);
    expect(result).toBe(false);
    expect(HumanActions.cdpIsElementVisible).toHaveBeenCalledWith(page, '.user-info-dpd');
  });
});
