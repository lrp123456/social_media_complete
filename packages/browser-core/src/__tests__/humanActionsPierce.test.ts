// packages/browser-core/src/__tests__/humanActionsPierce.test.ts
import { HumanActions } from '../humanActions';

function makeMockCtx(behavior: any) {
  const calls: any[] = [];
  const cdp: any = {
    send: jest.fn(async (method: string, params: any) => {
      calls.push({ method, params });
      const handler = behavior[method];
      if (!handler) throw new Error('unexpected CDP send: ' + method);
      return handler(params);
    }),
    // 健康检查需要 getLayoutViewport 通过
    getLayoutViewport: jest.fn(async () => ({ pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 })),
  };
  const dom: any = {};
  return { cdp, dom, calls };
}

function injectContext(page: any, ctx: any) {
  (HumanActions as any).cdpContexts.set(page, ctx);
}

describe('HumanActions.cdpPierceShadow', () => {
  it('css step: DOM.querySelector + read text', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (p: any) => (p.selector === 'div.title' ? { nodeId: 10 } : { nodeId: 0 }),
      'DOM.getOuterHTML': () => ({ outerHTML: '<div class="title">hello</div>' }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'css', selector: 'div.title' }],
      { selector: 'div.title', read: 'text' },
    );
    expect(result).toBe('hello');
  });

  it('missing element returns null', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'css', selector: '.missing' }],
      { selector: '.missing', read: 'text' },
    );
    expect(result).toBeNull();
  });

  it('shadow step: 进 wujie-app shadowRoot 后定位 target', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (p: any) => {
        if (p.selector === 'wujie-app') return { nodeId: 5 };
        if (p.selector === '.feed-title') return { nodeId: 9 };
        return { nodeId: 0 };
      },
      'DOM.describeNode': (p: any) => {
        if (p.nodeId === 5) return { node: { shadowRoots: [{ nodeId: 7 }] } };
        return { node: {} };
      },
      'DOM.getOuterHTML': () => ({ outerHTML: '<span class="feed-title">视频标题</span>' }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'shadow', selector: 'wujie-app' }],
      { selector: '.feed-title', read: 'text' },
    );
    expect(result).toBe('视频标题');
  });

  it('shadowRoot 不可访问返回 null', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 5 }),
      'DOM.describeNode': () => ({ node: {} }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [{ type: 'shadow', selector: 'wujie-app' }],
      { selector: '.feed-title', read: 'text' },
    );
    expect(result).toBeNull();
  });

  it('混合 chain: css→shadow→frame 多级穿透', async () => {
    const page = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (p: any) => {
        if (p.selector === 'wujie-app') return { nodeId: 5 };
        if (p.selector === '.comment-feed-wrap') return { nodeId: 12 };
        return { nodeId: 0 };
      },
      'DOM.describeNode': (p: any) => {
        if (p.nodeId === 5) return { node: { shadowRoots: [{ nodeId: 7 }] } };
        if (p.nodeId === 7) return { node: { contentDocument: { nodeId: 10 } } };
        return { node: {} };
      },
      'DOM.getOuterHTML': () => ({ outerHTML: '<div class="comment-feed-wrap">评论</div>' }),
    });
    injectContext(page, ctx);

    const result = await (HumanActions as any).cdpPierceShadow(
      page,
      [
        { type: 'shadow', selector: 'wujie-app' },
        { type: 'frame' },
      ],
      { selector: '.comment-feed-wrap', read: 'text' },
    );
    expect(result).toBe('评论');
  });

  it('复用 CDP context（不新建 session）', async () => {
    const page: any = {};
    const ctx = makeMockCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 }),
    });
    page.context = () => { throw new Error('应走缓存，不应新建 session'); };
    injectContext(page, ctx);

    await (HumanActions as any).cdpPierceShadow(page, [{ type: 'css', selector: '.x' }], { selector: '.x', read: 'exists' });
  });
});

describe('HumanActions.registerPlatformPierce', () => {
  beforeEach(() => {
    (HumanActions as any).platformPierceRegistry = new Map();
  });

  it('注册 + 取用 handler', async () => {
    const handler = jest.fn().mockResolvedValue('pierced');
    HumanActions.registerPlatformPierce('tencent', 'wujie-comment-feed', handler);
    const got = HumanActions.getPlatformPierce('tencent', 'wujie-comment-feed');
    expect(got).toBe(handler);
    const page = {};
    const result = await got!(page as any, { videoId: 'v1' });
    expect(result).toBe('pierced');
    expect(handler).toHaveBeenCalledWith(page, { videoId: 'v1' });
  });

  it('未注册返回 undefined', () => {
    expect(HumanActions.getPlatformPierce('tencent', 'nope')).toBeUndefined();
  });

  it('平台隔离：同名不同平台不串', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    HumanActions.registerPlatformPierce('tencent', 'feed', h1);
    HumanActions.registerPlatformPierce('kuaishou', 'feed', h2);
    expect(HumanActions.getPlatformPierce('tencent', 'feed')).toBe(h1);
    expect(HumanActions.getPlatformPierce('kuaishou', 'feed')).toBe(h2);
  });

  it('重复注册幂等（覆盖）', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    HumanActions.registerPlatformPierce('tencent', 'feed', h1);
    HumanActions.registerPlatformPierce('tencent', 'feed', h2);
    expect(HumanActions.getPlatformPierce('tencent', 'feed')).toBe(h2);
  });
});
