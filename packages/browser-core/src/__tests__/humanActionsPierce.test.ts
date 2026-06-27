// packages/browser-core/src/__tests__/humanActionsPierce.test.ts
import { HumanActions } from '../humanActions';

// 构造 mock CDPContext：cdp.send 记录调用并按 method 返回
function makeMockCtx(behavior: Record<string, (params: any) => any>) {
  const calls: Array<{ method: string; params: any }> = [];
  const cdp: any = {
    send: jest.fn(async (method: string, params: any = {}) => {
      calls.push({ method, params });
      const handler = behavior[method];
      if (!handler) throw new Error(`unexpected CDP send: ${method}`);
      return handler(params);
    }),
  };
  const dom: any = {};
  return { cdp, dom, calls };
}

// 注入 mock context 到私有 WeakMap
function injectContext(page: any, ctx: any) {
  (HumanActions as any).cdpContexts.set(page, ctx);
}

describe('HumanActions.cdpPierceShadow', () => {
  it('css step: DOM.querySelector 定位 + 读 text', async () => {
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

  it('元素不存在返回 null（不抛错）', async () => {
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
