// packages/browser-core/src/__tests__/interceptor.test.ts
import { RequestInterceptor } from '../interceptor';

describe('RequestInterceptor.collectResponses', () => {
  it('持续收集直到 until 谓词为 true', async () => {
    const interceptor = new RequestInterceptor();
    // 直接注入测试数据，绕过真实 CDP
    (interceptor as any).interceptedData.set('p1', [
      { url: 'u1', status: 200, body: { idx: 1 } } as any,
      { url: 'u2', status: 200, body: { idx: 2 } } as any,
      { url: 'u3', status: 200, body: { idx: 3 } } as any,
    ]);
    const collected = await interceptor.collectResponses('p1', {
      until: (r: any) => r.body.idx >= 3,
      maxItems: 10,
      pollMs: 10,
      timeoutMs: 1000,
    });
    expect(collected.length).toBe(3);
  });

  it('maxItems 限制', async () => {
    const interceptor = new RequestInterceptor();
    (interceptor as any).interceptedData.set('p1', [
      { url: 'u1', status: 200, body: { idx: 1 } } as any,
      { url: 'u2', status: 200, body: { idx: 2 } } as any,
    ]);
    const collected = await interceptor.collectResponses('p1', {
      until: () => false,
      maxItems: 1,
      pollMs: 10,
      timeoutMs: 200,
    });
    expect(collected.length).toBe(1);
  });
});

describe('RequestInterceptor.pollStatus', () => {
  it('predicate 命中时返回响应', async () => {
    const interceptor = new RequestInterceptor();
    (interceptor as any).interceptedData.set('login', [
      { url: 'u1', status: 200, body: { logged_in: true } } as any,
    ]);
    const r = await interceptor.pollStatus('login', {
      predicate: (resp: any) => resp.body.logged_in === true,
      pollMs: 10,
      timeoutMs: 500,
    });
    expect(r).not.toBeNull();
    expect((r as any).body.logged_in).toBe(true);
  });

  it('超时返回 null', async () => {
    const interceptor = new RequestInterceptor();
    const r = await interceptor.pollStatus('login', {
      predicate: () => true,
      pollMs: 10,
      timeoutMs: 50,
    });
    expect(r).toBeNull();
  });
});
