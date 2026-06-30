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

import { TencentCrawler } from '../../crawlers/tencentCrawler';

describe('TencentCrawler.detectTencentLogin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('在 /platform 页（非 /login）→ 已登录', async () => {
    const tc = new TencentCrawler();
    const page = { url: () => 'https://channels.weixin.qq.com/platform/home' } as any;
    const result = await tc.detectTencentLogin(page);
    expect(result).toBe(true);
  });

  it('在 /login 页 → 未登录', async () => {
    const tc = new TencentCrawler();
    const page = { url: () => 'https://channels.weixin.qq.com/login.html' } as any;
    const result = await tc.detectTencentLogin(page);
    expect(result).toBe(false);
  });

  it('page.url() 抛出异常 → 安全返回 false', async () => {
    const tc = new TencentCrawler();
    const page = { url: () => { throw new Error('Target closed'); } } as any;
    const result = await tc.detectTencentLogin(page);
    expect(result).toBe(false);
  });
});
