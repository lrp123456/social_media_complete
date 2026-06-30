// packages/browser-core/src/__tests__/loginTabRegistry.test.ts
const { LoginTabRegistry } = require('../loginTabRegistry');

/**
 * @param {string} url
 * @param {string} targetId
 * @returns {any}
 */
function mockPage(url, targetId) {
  return {
    url: () => url,
    _targetId: targetId,
    close: () => Promise.resolve(),
    evaluate: () => Promise.resolve(),
    $: () => Promise.resolve(null),
    isClosed: () => false,
    context: () => ({ pages: () => [] }),
    isVisible: () => Promise.resolve(true),
    screenshot: () => Promise.resolve(Buffer.from('fake')),
    waitForSelector: () => Promise.resolve(null),
    waitForTimeout: () => Promise.resolve(),
    goto: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  };
}

describe('LoginTabRegistry', () => {
  /** @type {import('../loginTabRegistry').LoginTabRegistry} */
  let registry;

  beforeEach(() => {
    registry = new LoginTabRegistry();
  });

  it('should register and find login tab in memory', () => {
    const record = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1',
      domain: 'www.xiaohongshu.com',
      flowId: 'mainsite',
      platform: 'xiaohongshu',
      openedAt: Date.now(),
      userId: 42,
      loginUrl: 'https://www.xiaohongshu.com/explore',
    };
    registry.register('window123', 'xiaohongshu', 'mainsite', record);
    const memKey = 'window123:xiaohongshu:mainsite';
    expect(registry.tabs.has(memKey)).toBe(true);
    expect(registry.tabs.get(memKey).userId).toBe(42);
  });

  it('should unregister and remove from memory', () => {
    const record = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1', domain: 'www.xiaohongshu.com', flowId: 'mainsite',
      platform: 'xiaohongshu',
      openedAt: Date.now(), userId: 42,
      loginUrl: 'https://www.xiaohongshu.com/explore',
    };
    registry.register('window123', 'xiaohongshu', 'mainsite', record);
    registry.unregister('window123', 'xiaohongshu', 'mainsite');
    expect(registry.tabs.has('window123:xiaohongshu:mainsite')).toBe(false);
  });

  it('should handle multiple flowIds for same window independently', () => {
    const mainsite = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1', domain: 'www.xiaohongshu.com', flowId: 'mainsite',
      platform: 'xiaohongshu',
      openedAt: Date.now(), userId: 42,
      loginUrl: 'https://www.xiaohongshu.com/explore',
    };
    const creator = {
      page: mockPage('https://creator.xiaohongshu.com/home', 'target-2'),
      targetId: 'target-2', domain: 'creator.xiaohongshu.com', flowId: 'creator',
      platform: 'xiaohongshu',
      openedAt: Date.now(), userId: 42,
      loginUrl: 'https://creator.xiaohongshu.com/home',
    };
    registry.register('window123', 'xiaohongshu', 'mainsite', mainsite);
    registry.register('window123', 'xiaohongshu', 'creator', creator);
    expect(registry.tabs.has('window123:xiaohongshu:mainsite')).toBe(true);
    expect(registry.tabs.has('window123:xiaohongshu:creator')).toBe(true);
    registry.unregister('window123', 'xiaohongshu', 'mainsite');
    expect(registry.tabs.has('window123:xiaohongshu:mainsite')).toBe(false);
    expect(registry.tabs.has('window123:xiaohongshu:creator')).toBe(true);
  });

  it('should detect logged_out via indicator', async () => {
    const mockP = {
      $: async (sel) => {
        if (sel === '.login-modal') return { isVisible: () => Promise.resolve(true) };
        return null;
      },
    };
    const config = {
      domain: 'www.xiaohongshu.com', label: '主站',
      loginUrl: 'https://www.xiaohongshu.com', closeOnLoginSuccess: true,
      loggedOutIndicators: ['.login-modal'], loggedInIndicators: [],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockP, config);
    expect(state).toBe('logged_out');
  });

  it('should detect logged_in via indicator', async () => {
    const mockP = {
      $: async (sel) => {
        if (sel === '.user-avatar') return { isVisible: () => Promise.resolve(true) };
        return null;
      },
    };
    const config = {
      domain: 'www.xiaohongshu.com', label: '主站',
      loginUrl: 'https://www.xiaohongshu.com', closeOnLoginSuccess: true,
      loggedOutIndicators: [], loggedInIndicators: ['.user-avatar'],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockP, config);
    expect(state).toBe('logged_in');
  });

  it('should return unknown when no indicators match', async () => {
    const mockP = { $: async () => null };
    const config = {
      domain: 'www.xiaohongshu.com', label: '主站',
      loginUrl: 'https://www.xiaohongshu.com', closeOnLoginSuccess: true,
      loggedOutIndicators: ['.login-modal'], loggedInIndicators: [],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockP, config);
    expect(state).toBe('unknown');
  });

  it('should prioritize loggedOut over loggedIn', async () => {
    const mockP = {
      $: async (sel) => {
        if (sel === '.login-modal') return { isVisible: () => Promise.resolve(true) };
        if (sel === '.user-avatar') return { isVisible: () => Promise.resolve(true) };
        return null;
      },
    };
    const config = {
      domain: 'www.xiaohongshu.com', label: '主站',
      loginUrl: 'https://www.xiaohongshu.com', closeOnLoginSuccess: true,
      loggedOutIndicators: ['.login-modal'], loggedInIndicators: ['.user-avatar'],
      qrSelectors: [],
    };
    const state = await registry.checkLoginState(mockP, config);
    expect(state).toBe('logged_out');
  });

  it('should close page on unregister when URL crossed domains (kuaishou)', async () => {
    let closed = false;
    const page = mockPage('https://cp.kuaishou.com/article/comment', 'target-ks');
    page.close = () => { closed = true; return Promise.resolve(); };
    const record = {
      page,
      targetId: 'target-ks',
      domain: 'cp.kuaishou.com',
      flowId: 'creator',
      platform: 'kuaishou',
      openedAt: Date.now(),
      userId: 11,
      loginUrl: 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api',
    };
    registry.register('windowKS', 'kuaishou', 'creator', record);
    await registry.unregister('windowKS', 'kuaishou', 'creator');
    expect(closed).toBe(true);
    expect(registry.tabs.has('windowKS:kuaishou:creator')).toBe(false);
  });

  it('should NOT close page on unregister when URL is same domain (douyin)', async () => {
    let closed = false;
    const page = mockPage('https://creator.douyin.com/creator-micro/home', 'target-dy');
    page.close = () => { closed = true; return Promise.resolve(); };
    const record = {
      page,
      targetId: 'target-dy',
      domain: 'creator.douyin.com',
      flowId: 'creator',
      platform: 'douyin',
      openedAt: Date.now(),
      userId: 7,
      loginUrl: 'https://creator.douyin.com/creator-micro/home',
    };
    registry.register('windowDY', 'douyin', 'creator', record);
    await registry.unregister('windowDY', 'douyin', 'creator');
    expect(closed).toBe(false);
    expect(registry.tabs.has('windowDY:douyin:creator')).toBe(false);
  });

  it('should isolate same flowId across platforms under shared window', () => {
    const douyin = {
      page: mockPage('https://creator.douyin.com/creator-micro/home', 't-dy'),
      targetId: 't-dy', domain: 'creator.douyin.com', flowId: 'creator',
      platform: 'douyin',
      openedAt: Date.now(), userId: 6,
      loginUrl: 'https://creator.douyin.com/creator-micro/home',
    };
    const tencent = {
      page: mockPage('https://channels.weixin.qq.com/login.html', 't-tx'),
      targetId: 't-tx', domain: 'channels.weixin.qq.com', flowId: 'creator',
      platform: 'tencent',
      openedAt: Date.now(), userId: 13,
      loginUrl: 'https://channels.weixin.qq.com/login.html',
    };
    // 同 windowId、同 flowId='creator'、不同 platform
    registry.register('w4', 'douyin', 'creator', douyin);
    registry.register('w4', 'tencent', 'creator', tencent);
    expect(registry.tabs.has('w4:douyin:creator')).toBe(true);
    expect(registry.tabs.has('w4:tencent:creator')).toBe(true);
    // 互不覆盖
    expect(registry.tabs.get('w4:douyin:creator').userId).toBe(6);
    expect(registry.tabs.get('w4:tencent:creator').userId).toBe(13);
  });

  it('should reject stale memory hit whose domain mismatches config', async () => {
    // 模拟旧串号残留：key 命中但 record 是抖音 page，config.domain 是视频号
    const dyPage = mockPage('https://creator.douyin.com/creator-micro/home', 't-dy');
    const staleRecord = {
      page: dyPage, targetId: 't-dy',
      domain: 'creator.douyin.com', flowId: 'creator', platform: 'douyin',
      openedAt: Date.now(), userId: 6,
      loginUrl: 'https://creator.douyin.com/creator-micro/home',
    };
    // 直接污染内存（模拟跨平台 key 冲突后的残留）
    registry.tabs.set('w4:tencent:creator', staleRecord);

    const browser = { contexts: () => [{ pages: () => [] }] };
    const found = await registry.find('w4', 'tencent', 'creator', browser, 'channels.weixin.qq.com');
    // domain 不符 → 拒绝内存命中，返回 null（无枚举兜底可用）
    expect(found).toBe(null);
    // 残留被清理
    expect(registry.tabs.has('w4:tencent:creator')).toBe(false);
  });

  it('should match platform in localStorage mark during enumeration fallback', async () => {
    const txPage = mockPage('https://channels.weixin.qq.com/login.html', 't-tx');
    txPage.evaluate = ({ markKey }) => Promise.resolve({
      flowId: 'creator', platform: 'tencent', userId: 13,
      openedAt: 123, loginUrl: 'https://channels.weixin.qq.com/login.html',
    });
    const dyPage = mockPage('https://creator.douyin.com/creator-micro/home', 't-dy');
    dyPage.evaluate = ({ markKey }) => Promise.resolve({
      flowId: 'creator', platform: 'douyin', userId: 6,
      openedAt: 123, loginUrl: 'https://creator.douyin.com/creator-micro/home',
    });
    const browser = { contexts: () => [{ pages: () => [dyPage, txPage] }] };
    // 查视频号：URL 含 channels.weixin.qq.com 的页才进入枚举；dyPage URL 不含视频号 domain 被跳过
    const found = await registry.find('w4', 'tencent', 'creator', browser, 'channels.weixin.qq.com');
    expect(found).not.toBe(null);
    expect(found.userId).toBe(13);
  });
});

describe('find loginHost (A0)', () => {
  it('快手登录页 hostname=passport.kuaishou.com 能被 loginHost 命中（domain 异域不再跳过）', async () => {
    const registry = new LoginTabRegistry();
    const loginUrl = 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api';
    const loginHost = new URL(loginUrl).hostname; // passport.kuaishou.com
    // 模拟一个已在 passport.kuaishou.com 的页面，带 localStorage 标记
    const page = mockPage(loginUrl, 't1');
    (page.evaluate as any) = async () => ({
      platform: 'kuaishou', flowId: 'creator', openedAt: Date.now(), userId: 11, loginUrl,
    });
    const browser = { contexts: () => [{ pages: () => [page] }] } as any;
    const found = await registry.find('w4', 'kuaishou', 'creator', browser, loginHost);
    if (!found) throw new Error('expected find to hit kuaishou login page via loginHost');
    if (found.page !== page) throw new Error('expected found.page === mock page');
  });

  it('内存命中校验用 page 实际 hostname，离开登录域则 miss', async () => {
    const registry = new LoginTabRegistry();
    const loginUrl = 'https://passport.kuaishou.com/pc/account/login/';
    const loginHost = new URL(loginUrl).hostname;
    const page = mockPage(loginUrl, 't2');
    (page.isClosed as any) = () => false;
    registry.register('w4', 'kuaishou', 'creator', {
      page, targetId: 't2', domain: 'cp.kuaishou.com', flowId: 'creator', platform: 'kuaishou',
      openedAt: Date.now(), userId: 11, loginUrl,
    });
    // page 仍在登录域 → 命中
    const hit = await registry.find('w4', 'kuaishou', 'creator', { contexts: () => [{ pages: () => [] }] } as any, loginHost);
    if (!hit) throw new Error('expected memory hit while on login domain');
    // page 已导航离开登录域 → 不命中（url 改为 cp.kuaishou.com）
    (page.url as any) = () => 'https://cp.kuaishou.com/home';
    const miss = await registry.find('w4', 'kuaishou', 'creator', { contexts: () => [{ pages: () => [] }] } as any, loginHost);
    if (miss) throw new Error('expected miss after page navigated off login domain');
  });
});
