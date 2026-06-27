import { isEnabled } from '../../lib/antiDetectionMode';

describe('腾讯 wujie 穿透 v2 收口', () => {
  afterEach(() => { delete process.env.ANTI_DETECTION_MODE_TENCENT; });

  it('v2 模式 isEnabled(tencent) 为 true', () => {
    process.env.ANTI_DETECTION_MODE_TENCENT = 'v2';
    expect(isEnabled('tencent')).toBe(true);
  });

  it('legacy 模式 isEnabled(tencent) 为 false', () => {
    delete process.env.ANTI_DETECTION_MODE_TENCENT;
    expect(isEnabled('tencent')).toBe(false);
  });

  it('空字符串 isEnabled(tencent) 为 false', () => {
    process.env.ANTI_DETECTION_MODE_TENCENT = '';
    expect(isEnabled('tencent')).toBe(false);
  });

  it('其他平台 env 不影响 tencent', () => {
    process.env.ANTI_DETECTION_MODE_KUAISHOU = 'v2';
    delete process.env.ANTI_DETECTION_MODE_TENCENT;
    expect(isEnabled('tencent')).toBe(false);
  });
});
