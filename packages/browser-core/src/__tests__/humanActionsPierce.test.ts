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
});
