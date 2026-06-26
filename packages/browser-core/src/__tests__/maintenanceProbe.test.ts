import { MaintenanceProbe } from '../maintenanceProbe';

type Pushed = { channel: string; payload: any };
function makeProbe() {
  const pushed: Pushed[] = [];
  const pusher = async (channel: string, payload: any) => { pushed.push({ channel, payload }); };
  return { pushed, pusher };
}

describe('MaintenanceProbe', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('is disabled by default and drops events silently', async () => {
    const { pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
      result: 'found', durationMs: 5,
    });
    await MaintenanceProbe.flush();
    // disabled → no events pushed
    expect((MaintenanceProbe as any).__lastPushed).toHaveLength(0);
  });

  it('propagates context across async hops via AsyncLocalStorage', async () => {
    const { pushed, pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'phase1', 'expandMenu', 'sub1', 'exec-1');
    await new Promise(r => setImmediate(r));
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'menu_home', selectorUsed: 'getByRole', selectorSource: 'primary',
      result: 'found', durationMs: 12,
    });
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const evts = (MaintenanceProbe as any).__lastPushed;
    expect(evts).toHaveLength(1);
    expect(evts[0].type).toBe('selector');
    expect(evts[0].context.flow).toBe('monitor');
    expect(evts[0].context.taskExecutionId).toBe('exec-1');
    expect(evts[0].context.step).toBe('expandMenu');
  });

  it('getContext returns undefined outside enterStep', () => {
    expect(MaintenanceProbe.getContext()).toBeUndefined();
  });

  it('recordUrlIntercept emits a url event with videoId/commentCid', async () => {
    const { pushed, pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'phase1', 'scroll');
    await MaintenanceProbe.recordUrlIntercept({
      healthKey: 'video_list', urlPattern: '/aweme/v1/web/aweme/post', actualUrl: 'http://x',
      httpStatus: 200, result: 'matched', itemsFound: 12, hasMore: true,
      durationMs: 180, responseSize: 4096, videoId: 'aweme-1',
    });
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const evts = (MaintenanceProbe as any).__lastPushed;
    expect(evts[0].type).toBe('url');
    expect(evts[0].payload.videoId).toBe('aweme-1');
  });

  it('recordBypass emits bypass event with method+stack', async () => {
    const { pushed, pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'phase1', 'step');
    await MaintenanceProbe.recordBypass('evaluate', 'stack-trace-here', 'win-1');
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const evts = (MaintenanceProbe as any).__lastPushed;
    expect(evts[0].type).toBe('bypass');
    expect(evts[0].payload.method).toBe('evaluate');
    expect(evts[0].payload.windowId).toBe('win-1');
  });

  it('caps bypass events per step at 100', async () => {
    const { pushed, pusher } = makeProbe();
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'kuaishou', 'phase1', 'step');
    for (let i = 0; i < 150; i++) {
      await MaintenanceProbe.recordBypass('evaluate', 's', 'w');
    }
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const evts = (MaintenanceProbe as any).__lastPushed;
    expect(evts.length).toBe(100);
  });

  it('does not push when pusher throws (silent drop)', async () => {
    const pusher = async () => { throw new Error('redis down'); };
    MaintenanceProbe.setRedisPusher(pusher);
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's');
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
      result: 'found', durationMs: 1,
    });
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    expect((MaintenanceProbe as any).__lastPushed).toHaveLength(0);
  });

  it('recordSnapshot respects 50-per-exec cap', async () => {
    MaintenanceProbe.setRedisPusher(async (_c, p) => {});
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'exec-cap');
    for (let i = 0; i < 5; i++) {
      await MaintenanceProbe.recordSelectorOp({
        selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
        result: 'not_found', durationMs: 1,
      });
    }
    for (let i = 0; i < 200; i++) {
      await MaintenanceProbe.recordSnapshot('dom', { content: `<div>${i}</div>`, mimeType: 'text/html' });
    }
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const evts = (MaintenanceProbe as any).__lastPushed;
    const snaps = evts.filter((e: any) => e.type === 'snapshot');
    expect(snaps.length).toBeLessThanOrEqual(50);
  });

  it('recordSnapshot skips when consecutive failures < 3', async () => {
    MaintenanceProbe.setRedisPusher(async (_c, p) => {});
    MaintenanceProbe.setEnabled(true);
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'exec-trig');
    await MaintenanceProbe.recordSelectorOp({
      selectorKey: 'k', selectorUsed: '.x', selectorSource: 'primary',
      result: 'not_found', durationMs: 1,
    });
    await MaintenanceProbe.recordSnapshot('dom', { content: '<div></div>', mimeType: 'text/html' });
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();
    const evts = (MaintenanceProbe as any).__lastPushed;
    expect(evts.filter((e: any) => e.type === 'snapshot')).toHaveLength(0);
  });
});
