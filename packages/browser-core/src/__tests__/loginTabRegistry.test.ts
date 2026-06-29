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
      openedAt: Date.now(),
      userId: 42,
      loginUrl: 'https://www.xiaohongshu.com/explore',
    };
    registry.register('window123', 'mainsite', record);
    const memKey = 'window123:mainsite';
    expect(registry.tabs.has(memKey)).toBe(true);
    expect(registry.tabs.get(memKey).userId).toBe(42);
  });

  it('should unregister and remove from memory', () => {
    const record = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1', domain: 'www.xiaohongshu.com', flowId: 'mainsite',
      openedAt: Date.now(), userId: 42,
      loginUrl: 'https://www.xiaohongshu.com/explore',
    };
    registry.register('window123', 'mainsite', record);
    registry.unregister('window123', 'mainsite');
    expect(registry.tabs.has('window123:mainsite')).toBe(false);
  });

  it('should handle multiple flowIds for same window independently', () => {
    const mainsite = {
      page: mockPage('https://www.xiaohongshu.com/explore', 'target-1'),
      targetId: 'target-1', domain: 'www.xiaohongshu.com', flowId: 'mainsite',
      openedAt: Date.now(), userId: 42,
      loginUrl: 'https://www.xiaohongshu.com/explore',
    };
    const creator = {
      page: mockPage('https://creator.xiaohongshu.com/home', 'target-2'),
      targetId: 'target-2', domain: 'creator.xiaohongshu.com', flowId: 'creator',
      openedAt: Date.now(), userId: 42,
      loginUrl: 'https://creator.xiaohongshu.com/home',
    };
    registry.register('window123', 'mainsite', mainsite);
    registry.register('window123', 'creator', creator);
    expect(registry.tabs.has('window123:mainsite')).toBe(true);
    expect(registry.tabs.has('window123:creator')).toBe(true);
    registry.unregister('window123', 'mainsite');
    expect(registry.tabs.has('window123:mainsite')).toBe(false);
    expect(registry.tabs.has('window123:creator')).toBe(true);
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
      openedAt: Date.now(),
      userId: 11,
      loginUrl: 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api',
    };
    registry.register('windowKS', 'creator', record);
    await registry.unregister('windowKS', 'creator');
    expect(closed).toBe(true);
    expect(registry.tabs.has('windowKS:creator')).toBe(false);
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
      openedAt: Date.now(),
      userId: 7,
      loginUrl: 'https://creator.douyin.com/creator-micro/home',
    };
    registry.register('windowDY', 'creator', record);
    await registry.unregister('windowDY', 'creator');
    expect(closed).toBe(false);
    expect(registry.tabs.has('windowDY:creator')).toBe(false);
  });
});
