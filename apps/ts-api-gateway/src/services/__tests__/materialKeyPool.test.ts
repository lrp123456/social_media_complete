import { KeyPoolManager } from '../materialKeyPool';
import type { KeyPool, KeyCooldownState } from '../materialUpdateConfig';

const mockKeyPool: KeyPool = {
  placeholder: 'API_KEY',
  keys: ['key_aaa', 'key_bbb', 'key_ccc'],
  cooldownMs: 300000,
};

describe('KeyPoolManager', () => {
  it('首次选 key 返回第一个可用 key', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    const key = mgr.selectKey();
    expect(key).toBe('key_aaa');
  });

  it('冷却第一个 key 后选第二个', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    mgr.markCooldown('key_aaa');
    const key = mgr.selectKey();
    expect(key).toBe('key_bbb');
  });

  it('所有 key 都冷却后返回 null', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    mgr.markCooldown('key_aaa');
    mgr.markCooldown('key_bbb');
    mgr.markCooldown('key_ccc');
    const key = mgr.selectKey();
    expect(key).toBeNull();
  });

  it('冷却过期的 key 恢复可用', () => {
    const pastExpiry = Date.now() - 1000;
    const cooldownState: KeyCooldownState = {
      plat1: { key_aaa: pastExpiry },
    };
    const mgr = new KeyPoolManager('plat1', mockKeyPool, cooldownState);
    const key = mgr.selectKey();
    expect(key).toBe('key_aaa');
  });

  it('markCooldown 写入的过期时间为 now + cooldownMs', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    const before = Date.now();
    mgr.markCooldown('key_aaa');
    const after = Date.now();
    const state = mgr.getCooldownState();
    const expiry = state.plat1?.['key_aaa'];
    expect(expiry).toBeDefined();
    expect(expiry!).toBeGreaterThanOrEqual(before + mockKeyPool.cooldownMs);
    expect(expiry!).toBeLessThanOrEqual(after + mockKeyPool.cooldownMs);
  });

  it('检测 200 响应体中的限流错误关键词', () => {
    const mgr = new KeyPoolManager('plat1', mockKeyPool, {});
    expect(mgr.isBodyError({ message: 'rate limit exceeded' })).toBe(true);
    expect(mgr.isBodyError({ error: 'You exceeded your quota' })).toBe(true);
    expect(mgr.isBodyError({ message: 'not enough credits' })).toBe(true);
    expect(mgr.isBodyError({ data: { videos: [] } })).toBe(false);
    expect(mgr.isBodyError({ message: 'success' })).toBe(false);
  });

  it('无 key 的池始终返回 null', () => {
    const emptyPool: KeyPool = { ...mockKeyPool, keys: [] };
    const mgr = new KeyPoolManager('plat1', emptyPool, {});
    expect(mgr.selectKey()).toBeNull();
  });
});
