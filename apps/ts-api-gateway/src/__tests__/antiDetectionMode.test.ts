// apps/ts-api-gateway/src/__tests__/antiDetectionMode.test.ts
import { isAntiDetectionV2, ANTI_DETECTION_MODE } from '../lib/antiDetectionMode';

describe('antiDetectionMode', () => {
  const orig = process.env.ANTI_DETECTION_MODE;
  afterEach(() => { if (orig === undefined) delete process.env.ANTI_DETECTION_MODE; else process.env.ANTI_DETECTION_MODE = orig; });

  it('默认 legacy', () => {
    delete process.env.ANTI_DETECTION_MODE;
    expect(isAntiDetectionV2()).toBe(false);
  });
  it('v2 启用', () => {
    process.env.ANTI_DETECTION_MODE = 'v2';
    expect(isAntiDetectionV2()).toBe(true);
  });
});
