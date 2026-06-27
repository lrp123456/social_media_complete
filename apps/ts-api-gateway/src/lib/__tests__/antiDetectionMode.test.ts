import { isEnabled, isAntiDetectionV2, ANTI_DETECTION_MODE } from '../antiDetectionMode';

describe('antiDetectionMode 多平台开关', () => {
  afterEach(() => {
    delete process.env.ANTI_DETECTION_MODE;
    delete process.env.ANTI_DETECTION_MODE_TENCENT;
    delete process.env.ANTI_DETECTION_MODE_KUAISHOU;
    delete process.env.ANTI_DETECTION_MODE_XIAOHONGSHU;
  });

  it('isEnabled(platform) 读对应平台 env，v2 为 true', () => {
    process.env.ANTI_DETECTION_MODE_TENCENT = 'v2';
    expect(isEnabled('tencent')).toBe(true);
    expect(isEnabled('kuaishou')).toBe(false);
  });

  it('未设置或非 v2 返回 false（legacy）', () => {
    process.env.ANTI_DETECTION_MODE_KUAISHOU = 'legacy';
    expect(isEnabled('kuaishou')).toBe(false);
    expect(isEnabled('xiaohongshu')).toBe(false);
  });

  it('抖音走向后兼容的 isAntiDetectionV2', () => {
    process.env.ANTI_DETECTION_MODE = 'v2';
    expect(isAntiDetectionV2()).toBe(true);
    expect(isEnabled('douyin')).toBe(true);
  });

  it('未知平台返回 false', () => {
    expect(isEnabled('unknown')).toBe(false);
  });
});
