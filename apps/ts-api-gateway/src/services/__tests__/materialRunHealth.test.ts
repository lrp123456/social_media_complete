import { computeRunHealth, type PlatformRunInput } from '../materialRunHealth';

// ============================================================
// computeRunHealth — 纯函数测试
// ============================================================
describe('computeRunHealth', () => {
  it('全部 ok 返回 overall=ok 空 warnings', () => {
    const inputs: PlatformRunInput[] = [
      { platformId: 'douyin', platformName: '抖音', keyCount: 3, availableKeyCount: 3, fetched: 20 },
      { platformId: 'kuaishou', platformName: '快手', keyCount: 2, availableKeyCount: 1, fetched: 15 },
    ];

    const result = computeRunHealth(inputs);
    expect(result.overall).toBe('ok');
    expect(result.warnings).toEqual([]);
    expect(result.platforms).toHaveLength(2);
    expect(result.platforms.every((p) => p.health === 'ok')).toBe(true);
  });

  it('no_keys: 平台未配置任何 Key', () => {
    const inputs: PlatformRunInput[] = [
      { platformId: 'douyin', platformName: '抖音', keyCount: 0, availableKeyCount: 0, fetched: 0 },
    ];

    const result = computeRunHealth(inputs);
    expect(result.overall).toBe('no_keys');
    expect(result.platforms[0].health).toBe('no_keys');
    expect(result.platforms[0].message).toContain('未配置任何 Key');
    expect(result.warnings).toHaveLength(1);
  });

  it('all_keys_cooldown: 有 Key 但全部冷却中', () => {
    const inputs: PlatformRunInput[] = [
      { platformId: 'douyin', platformName: '抖音', keyCount: 3, availableKeyCount: 0, fetched: 0 },
    ];

    const result = computeRunHealth(inputs);
    expect(result.overall).toBe('all_keys_cooldown');
    expect(result.platforms[0].health).toBe('all_keys_cooldown');
    expect(result.platforms[0].message).toContain('Key 均冷却中');
    expect(result.warnings).toHaveLength(1);
  });

  it('parse_mismatch: Key 可用但采集到 0 视频', () => {
    const inputs: PlatformRunInput[] = [
      { platformId: 'douyin', platformName: '抖音', keyCount: 3, availableKeyCount: 2, fetched: 0 },
    ];

    const result = computeRunHealth(inputs);
    expect(result.overall).toBe('parse_mismatch');
    expect(result.platforms[0].health).toBe('parse_mismatch');
    expect(result.platforms[0].message).toContain('解析到 0 条视频');
    expect(result.warnings).toHaveLength(1);
  });

  it('混合平台取最差状态 no_keys > parse_mismatch > all_keys_cooldown > ok', () => {
    const inputs: PlatformRunInput[] = [
      { platformId: 'a', platformName: 'A', keyCount: 0, availableKeyCount: 0, fetched: 0 },
      { platformId: 'b', platformName: 'B', keyCount: 2, availableKeyCount: 2, fetched: 10 },
    ];

    // no_keys 是最严重的
    let result = computeRunHealth(inputs);
    expect(result.overall).toBe('no_keys');
    expect(result.warnings).toHaveLength(1);

    // parse_mismatch 比 all_keys_cooldown 严重
    const inputs2: PlatformRunInput[] = [
      { platformId: 'a', platformName: 'A', keyCount: 2, availableKeyCount: 2, fetched: 0 },
      { platformId: 'b', platformName: 'B', keyCount: 2, availableKeyCount: 0, fetched: 0 },
    ];

    result = computeRunHealth(inputs2);
    expect(result.overall).toBe('parse_mismatch');
    expect(result.warnings).toHaveLength(2);
  });

  it('空输入返回 overall=ok 空 warnings', () => {
    const result = computeRunHealth([]);
    expect(result.overall).toBe('ok');
    expect(result.warnings).toEqual([]);
    expect(result.platforms).toEqual([]);
  });
});
