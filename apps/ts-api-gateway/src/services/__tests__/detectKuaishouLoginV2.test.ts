jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
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

describe('KuaishouCrawler.detectKuaishouLoginV2', () => {
  beforeEach(() => jest.clearAllMocks());

  it('account/current result:1 + logined:true → 已登录', async () => {
    const ks = new KuaishouCrawler();
    (ks as any).interceptor = {
      register: jest.fn().mockResolvedValue('pid'),
      unregister: jest.fn(),
      waitForResponse: jest.fn().mockResolvedValue({
        status: 200,
        body: { result: 1, message: '成功', data: { logined: true, userId: 694477428, userName: 'User_x' } },
      }),
    };
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video', evaluate: jest.fn() } as any;
    expect(await ks.detectKuaishouLoginV2(page)).toBe(true);
  });

  it('account/current result:109 → 未登录', async () => {
    const ks = new KuaishouCrawler();
    (ks as any).interceptor = {
      register: jest.fn().mockResolvedValue('pid'),
      unregister: jest.fn(),
      waitForResponse: jest.fn().mockResolvedValue({
        status: 200,
        body: { result: 109, loginUrl: 'https://id.kuaishou.com/pass/xxx' },
      }),
    };
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video', evaluate: jest.fn() } as any;
    expect(await ks.detectKuaishouLoginV2(page)).toBe(false);
  });

  it('account/current 403 → 抛 UNKNOWN_EXCEPTION', async () => {
    const ks = new KuaishouCrawler();
    (ks as any).interceptor = {
      register: jest.fn().mockResolvedValue('pid'),
      unregister: jest.fn(),
      waitForResponse: jest.fn().mockResolvedValue({ status: 403, body: {} }),
    };
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video', evaluate: jest.fn() } as any;
    await expect(ks.detectKuaishouLoginV2(page)).rejects.toThrow(/UNKNOWN_EXCEPTION|未知异常/);
  });

  it('未拦截到接口 + DOM 命中登录特征 → 已登录', async () => {
    const ks = new KuaishouCrawler();
    (ks as any).interceptor = {
      register: jest.fn().mockResolvedValue('pid'),
      unregister: jest.fn(),
      waitForResponse: jest.fn().mockResolvedValue(null),
    };
    (HumanActions.exists as jest.Mock).mockImplementation(async (_p: any, sel: string) => {
      if (sel === 'ul.el-menu') return true;
      if (sel === '.user__name') return true;
      return false;
    });
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/video', evaluate: jest.fn() } as any;
    expect(await ks.detectKuaishouLoginV2(page)).toBe(true);
  });
});
