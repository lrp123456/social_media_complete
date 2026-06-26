import { createProxiedPage, PROXY_INTERCEPT_METHODS } from '../pageProxy';
import { MaintenanceProbe } from '../maintenanceProbe';

function fakePage() {
  const calls: string[] = [];
  return {
    calls,
    page: {
      evaluate: async (fn: any) => { calls.push('evaluate'); return fn ? 42 : 0; },
      $: async () => { calls.push('$'); return null; },
      $$: async () => { calls.push('$$'); return []; },
      locator: () => { calls.push('locator'); return { click: async () => {} }; },
      goto: async () => { calls.push('goto'); return {}; },
      screenshot: async () => { calls.push('screenshot'); return Buffer.from(''); },
      waitForTimeout: async () => { calls.push('waitForTimeout'); },
      keyboard: { press: async () => {} },
      url: 'http://x',
    } as any,
  };
}

describe('PageProxy', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('intercepts evaluate/$/$$/locator calls', async () => {
    const { calls, page } = fakePage();
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.setRedisPusher(async () => {});
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'p', 's', undefined, 'exec-x');
    const proxied = createProxiedPage(page, 'win-1');
    await proxied.evaluate(() => 42);
    await proxied.$('.a');
    await proxied.$$('.b');
    proxied.locator('.c');
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(calls).toEqual(['evaluate', '$', '$$', 'locator']);
  });

  it('does NOT intercept goto/screenshot/waitForTimeout/keyboard', async () => {
    const { calls, page } = fakePage();
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.setRedisPusher(async () => {});
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'p', 's');
    const proxied = createProxiedPage(page, 'win-1');
    await proxied.goto('http://x');
    await proxied.screenshot();
    await proxied.waitForTimeout(10);
    MaintenanceProbe.exitStep();
    expect(calls).toEqual(['goto', 'screenshot', 'waitForTimeout']);
  });

  it('records bypass event with method + windowId', async () => {
    const { page } = fakePage();
    const pushed: any[] = [];
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'p', 's', undefined, 'exec-1');
    const proxied = createProxiedPage(page, 'win-7');
    await proxied.evaluate(() => 1);
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].type).toBe('bypass');
    expect(pushed[0].payload.method).toBe('evaluate');
    expect(pushed[0].payload.windowId).toBe('win-7');
  });

  it('forwards non-function properties transparently', () => {
    const { page } = fakePage();
    const proxied = createProxiedPage(page, 'w') as any;
    expect(proxied.url).toBe('http://x');
  });

  it('PROXY_INTERCEPT_METHODS excludes navigation/screenshot/wait/input', () => {
    expect(PROXY_INTERCEPT_METHODS).not.toContain('goto');
    expect(PROXY_INTERCEPT_METHODS).not.toContain('screenshot');
    expect(PROXY_INTERCEPT_METHODS).not.toContain('waitForTimeout');
    expect(PROXY_INTERCEPT_METHODS).not.toContain('keyboard');
  });
});
