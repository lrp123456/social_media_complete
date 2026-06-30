// packages/browser-core/src/__tests__/captureQRSelectors.test.ts
const { LoginTabRegistry } = require('../loginTabRegistry');

/**
 * 创建 mock page 对象，注入 $ 钩子以便断言选择器调用。
 * @param {object} opts
 * @param {function} [opts.mockDollar] - 自定义 page.$ 实现
 * @param {Array} [opts.frames] - 子 frame 列表
 * @returns {any}
 */
function mockPage(opts) {
  opts = opts || {};
  const frames = opts.frames || [];
  return {
    url: () => 'https://channels.weixin.qq.com/login.html',
    close: () => Promise.resolve(),
    evaluate: () => Promise.resolve(),
    $: opts.mockDollar || (() => Promise.resolve(null)),
    isClosed: () => false,
    context: () => ({ pages: () => [] }),
    screenshot: () => Promise.resolve(Buffer.from('fake-qr-screenshot')),
    waitForSelector: () => Promise.resolve(null),
    waitForTimeout: () => Promise.resolve(),
    goto: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    mainFrame: () => ({ url: () => 'https://channels.weixin.qq.com/login.html' }),
    frames: () => frames,
    mouse: { click: () => Promise.resolve() },
  };
}

describe('captureQR - qrRefreshSelector', () => {
  /** @type {import('../loginTabRegistry').LoginTabRegistry} */
  let registry;

  beforeEach(() => {
    registry = new LoginTabRegistry();
  });

  it('should use configured qrRefreshSelector when timeout overlay exists', async () => {
    const usedSelectors = [];
    const page = mockPage({
      mockDollar: (sel) => {
        usedSelectors.push(sel);
        if (sel.indexOf('qrcode-status-timeout') !== -1) {
          return { boundingBox: () => Promise.resolve({ x: 0, y: 0, width: 100, height: 100 }) };
        }
        if (sel.indexOf('.refresh-wrap') !== -1) {
          return {
            click: () => Promise.resolve(),
            boundingBox: () => Promise.resolve({ x: 10, y: 10, width: 50, height: 50 }),
          };
        }
        return null;
      },
      frames: [],
    });

    const config = {
      domain: 'channels.weixin.qq.com',
      label: '视频号',
      loginUrl: 'https://channels.weixin.qq.com/login.html?from=assistant',
      closeOnLoginSuccess: false,
      loggedOutIndicators: [],
      loggedInIndicators: [],
      qrSelectors: [],
      qrRefreshSelector: '.refresh-wrap',
    };

    const result = await registry.captureQR(page, config);

    // 验证 refresh 选择器调用：应包含配置的 .refresh-wrap
    const refreshCall = usedSelectors.find(
      (s) => s.indexOf('.refresh-wrap') !== -1 && s.indexOf('.qrcode-refresh') !== -1
    );
    expect(refreshCall).toBeTruthy();
    expect(refreshCall.indexOf('.refresh-wrap')).toBe(0); // 在组合选择器开头
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should fallback to default refresh selector when qrRefreshSelector is not configured', async () => {
    const usedSelectors = [];
    const page = mockPage({
      mockDollar: (sel) => {
        usedSelectors.push(sel);
        if (sel.indexOf('qrcode-status-timeout') !== -1) {
          return { boundingBox: () => Promise.resolve({ x: 0, y: 0, width: 100, height: 100 }) };
        }
        if (sel.indexOf('.qrcode-refresh') !== -1) {
          return {
            click: () => Promise.resolve(),
            boundingBox: () => Promise.resolve({ x: 10, y: 10, width: 50, height: 50 }),
          };
        }
        return null;
      },
      frames: [],
    });

    const config = {
      domain: 'channels.weixin.qq.com',
      label: '测试',
      loginUrl: 'https://channels.weixin.qq.com/login.html',
      closeOnLoginSuccess: false,
      loggedOutIndicators: [],
      loggedInIndicators: [],
      qrSelectors: [],
      // qrRefreshSelector 未配置
    };

    const result = await registry.captureQR(page, config);

    // 应使用通用 .qrcode-refresh 选择器
    const refreshCall = usedSelectors.find(
      (s) => s.indexOf('.qrcode-refresh') !== -1
    );
    expect(refreshCall).toBeTruthy();
    // 确保不含 .refresh-wrap
    expect(refreshCall.indexOf('.refresh-wrap')).toBe(-1);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should not crash when qrRefreshSelector selector matches nothing', async () => {
    const page = mockPage({
      mockDollar: (sel) => {
        if (sel.indexOf('qrcode-status-timeout') !== -1) {
          return { boundingBox: () => Promise.resolve({ x: 0, y: 0, width: 100, height: 100 }) };
        }
        return null;
      },
      frames: [],
    });

    const config = {
      domain: 'channels.weixin.qq.com',
      label: '视频号',
      loginUrl: 'https://channels.weixin.qq.com/login.html?from=assistant',
      closeOnLoginSuccess: false,
      loggedOutIndicators: [],
      loggedInIndicators: [],
      qrSelectors: [],
      qrRefreshSelector: '.refresh-wrap',
    };

    await expect(registry.captureQR(page, config)).resolves.not.toThrow();
  });
});

describe('captureQR - hostname guard', () => {
  /** @type {import('../loginTabRegistry').LoginTabRegistry} */
  let registry;

  beforeEach(() => {
    registry = new LoginTabRegistry();
  });

  it('should return null without screenshot when page hostname mismatches config', async () => {
    let screenshotCalled = false;
    const page = {
      url: () => 'https://creator.douyin.com/creator-micro/home',
      close: () => Promise.resolve(),
      evaluate: () => Promise.resolve(),
      $: () => Promise.resolve(null),
      isClosed: () => false,
      screenshot: () => { screenshotCalled = true; return Promise.resolve(Buffer.from('should-not-happen')); },
      waitForSelector: () => Promise.resolve(null),
      waitForTimeout: () => Promise.resolve(),
      mainFrame: () => ({ url: () => 'https://creator.douyin.com/creator-micro/home' }),
      frames: () => [],
      mouse: { click: () => Promise.resolve() },
    };
    const config = {
      domain: 'channels.weixin.qq.com',
      loginUrl: 'https://channels.weixin.qq.com/login.html',
      qrSelectors: ['img.qrcode'],
    };
    const buf = await registry.captureQR(page, config);
    expect(buf).toBe(null);
    expect(screenshotCalled).toBe(false);
  });

  it('should proceed when hostname matches config', async () => {
    const page = {
      url: () => 'https://channels.weixin.qq.com/login.html',
      close: () => Promise.resolve(),
      evaluate: () => Promise.resolve(),
      $: () => Promise.resolve({ isVisible: () => Promise.resolve(false) }),
      isClosed: () => false,
      screenshot: () => Promise.resolve(Buffer.from('qr-ok')),
      waitForSelector: () => Promise.resolve({ boundingBox: () => Promise.resolve({ x: 0, y: 0, width: 200, height: 200 }) }),
      waitForTimeout: () => Promise.resolve(),
      mainFrame: () => ({ url: () => 'https://channels.weixin.qq.com/login.html' }),
      frames: () => [],
      mouse: { click: () => Promise.resolve() },
    };
    const config = {
      domain: 'channels.weixin.qq.com',
      loginUrl: 'https://channels.weixin.qq.com/login.html',
      qrSelectors: ['img.qrcode'],
    };
    const buf = await registry.captureQR(page, config);
    expect(buf).not.toBe(null);
  });
});
