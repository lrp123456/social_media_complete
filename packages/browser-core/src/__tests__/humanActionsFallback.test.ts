import { HumanActions } from '../humanActions';
import { MaintenanceProbe } from '../maintenanceProbe';
import type { ResolvedSelector } from '../selectorRegistry';

function mockPage(locatorHits: Record<string, boolean>) {
  const clicks: string[] = [];
  const page: any = {
    locator: (sel: string) => ({
      count: async () => (locatorHits[sel] ? 1 : 0),
      waitFor: async () => {},
      first: () => ({ count: async () => (locatorHits[sel] ? 1 : 0) }),
      isVisible: async () => !!locatorHits[sel],
      boundingBox: async () => locatorHits[sel] ? { x: 10, y: 10, width: 100, height: 40 } : null,
      click: async () => { clicks.push(sel); },
    }),
    evaluate: async (fn: any, ...args: any[]) => {
      return args[0];
    },
    waitForTimeout: async () => {},
  };
  return { page, clicks };
}

function cfg(over: Partial<ResolvedSelector> = {}): ResolvedSelector {
  return {
    selectorKey: 'douyin.monitor.menu_home', platform: 'douyin', flow: 'monitor',
    strategy: 'scoped_css', primary: '#primary', fallbacks: ['.fb1', '.fb2'],
    timeout: 5000, ...over,
  } as ResolvedSelector;
}

describe('HumanActions.clickWithFallback', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('uses primary when it hits', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page, clicks } = mockPage({ '#primary': true });
    await HumanActions.clickWithFallback(page, cfg(), {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(clicks).toEqual(['#primary']);
    expect(pushed[0].payload.selectorSource).toBe('primary');
    expect(pushed[0].payload.result).toBe('found');
  });

  it('falls back to fallback_1 when primary misses, fires onFallbackTriggered', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page, clicks } = mockPage({ '.fb1': true });
    let triggered: any = null;
    await HumanActions.clickWithFallback(page, cfg(), {
      onFallbackTriggered: (failed, success, key) => { triggered = { failed, success, key }; },
    });
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(clicks).toEqual(['.fb1']);
    expect(pushed[0].payload.selectorSource).toBe('primary');
    expect(pushed[0].payload.result).toBe('not_found');
    expect(pushed[1].payload.selectorSource).toBe('fallback_1');
    expect(pushed[1].payload.result).toBe('found');
    expect(triggered).toEqual({ failed: '#primary', success: '.fb1', key: 'douyin.monitor.menu_home' });
  });

  it('records timeout when nothing hits', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page } = mockPage({});
    await HumanActions.clickWithFallback(page, cfg(), {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const selEvents = pushed.filter(e => e.type === 'selector');
    expect(selEvents.every(e => e.payload.result === 'not_found')).toBe(true);
  });
});

describe('HumanActions.findInScope', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('finds element inside scope and passes physical checks', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page } = mockPage({ '.scope': true, '.target': true });
    const r = await HumanActions.findInScope(page, { ...cfg({ primary: '.target', scope: '.scope' }) }, {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(r.found).toBe(true);
    expect(pushed[0].payload.result).toBe('found');
    expect(pushed[0].payload.scopeSelector).toBe('.scope');
  });

  it('returns scope_not_found when scope missing', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const { page } = mockPage({ '.target': true });
    const r = await HumanActions.findInScope(page, { ...cfg({ primary: '.target', scope: '.scope' }) }, {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(r.found).toBe(false);
    expect(r.scopeNotFound).toBe(true);
    expect(pushed[0].payload.result).toBe('scope_not_found');
  });

  it('flags honeypot_blocked when element too small', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');
    const page: any = {
      locator: (sel: string) => ({
        count: async () => 1,
        first: () => ({ count: async () => 1 }),
        isVisible: async () => true,
        boundingBox: async () => sel === '.target' ? { x: 0, y: 0, width: 5, height: 5 } : { x: 0, y: 0, width: 200, height: 200 },
        waitFor: async () => {},
        click: async () => {},
      }),
      evaluate: async () => null,
      waitForTimeout: async () => {},
    };
    const r = await HumanActions.findInScope(page, { ...cfg({ primary: '.target', scope: '.scope' }) }, {});
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect(r.found).toBe(false);
    expect(pushed[0].payload.result).toBe('honeypot_blocked');
    expect(pushed[0].payload.honeypotReason).toBe('too-small');
  });
});
