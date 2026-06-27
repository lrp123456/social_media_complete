import { isEnabled, isAntiDetectionV2 } from '../../lib/antiDetectionMode';

describe('小红书双路径开关', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    delete process.env.ANTI_DETECTION_MODE_XIAOHONGSHU;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('v2 启用', () => {
    process.env.ANTI_DETECTION_MODE_XIAOHONGSHU = 'v2';
    expect(isEnabled('xiaohongshu')).toBe(true);
  });

  it('legacy 默认', () => {
    expect(isEnabled('xiaohongshu')).toBe(false);
  });

  it('空字符串不启用', () => {
    process.env.ANTI_DETECTION_MODE_XIAOHONGSHU = '';
    expect(isEnabled('xiaohongshu')).toBe(false);
  });

  it('其他平台不受影响', () => {
    process.env.ANTI_DETECTION_MODE_XIAOHONGSHU = 'v2';
    expect(isEnabled('douyin')).toBe(false);
    expect(isEnabled('tencent')).toBe(false);
    expect(isEnabled('kuaishou')).toBe(false);
  });
});
