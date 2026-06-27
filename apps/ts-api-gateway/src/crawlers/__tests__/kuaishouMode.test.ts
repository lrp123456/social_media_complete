import { isEnabled } from '../../lib/antiDetectionMode';

describe('快手双路径开关', () => {
  const originalEnv = process.env.ANTI_DETECTION_MODE_KUAISHOU;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTI_DETECTION_MODE_KUAISHOU;
    } else {
      process.env.ANTI_DETECTION_MODE_KUAISHOU = originalEnv;
    }
  });

  it('v2 启用时 isEnabled 返回 true', () => {
    process.env.ANTI_DETECTION_MODE_KUAISHOU = 'v2';
    expect(isEnabled('kuaishou')).toBe(true);
  });

  it('legacy 默认（未设变量）返回 false', () => {
    delete process.env.ANTI_DETECTION_MODE_KUAISHOU;
    expect(isEnabled('kuaishou')).toBe(false);
  });

  it('legacy 显式设为 legacy 返回 false', () => {
    process.env.ANTI_DETECTION_MODE_KUAISHOU = 'legacy';
    expect(isEnabled('kuaishou')).toBe(false);
  });
});
