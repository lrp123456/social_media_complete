import { describe, it, expect, jest } from '@jest/globals';

// Mock 环境依赖以阻止配置校验（OSS_ACCESS_KEY_ID 等）
jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

import { isOnDouyinWorkPage } from '../../crawlers/douyinCrawler';

describe('isOnDouyinWorkPage', () => {
  it('/creator-micro/home → true', () => {
    expect(isOnDouyinWorkPage('https://creator.douyin.com/creator-micro/home')).toBe(true);
  });
  it('/creator-micro/content/manage → true', () => {
    expect(isOnDouyinWorkPage('https://creator.douyin.com/creator-micro/content/manage')).toBe(true);
  });
  it('/creator-micro/data/following/follower 残留子页 → false', () => {
    expect(isOnDouyinWorkPage('https://creator.douyin.com/creator-micro/data/following/follower')).toBe(false);
  });
  it('about:blank → false', () => {
    expect(isOnDouyinWorkPage('about:blank')).toBe(false);
  });
  it('仅 creator.douyin.com 域但无工作路径 → false', () => {
    expect(isOnDouyinWorkPage('https://creator.douyin.com/')).toBe(false);
  });
});
