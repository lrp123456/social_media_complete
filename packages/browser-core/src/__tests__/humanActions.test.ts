// packages/browser-core/src/__tests__/humanActions.test.ts
import { HumanActions } from '../humanActions';

// 构造 mock Page：记录原生 Locator 调用
function makeMockPage(locatorMock: any) {
  const page: any = {
    locator: jest.fn().mockReturnValue(locatorMock),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    context: () => ({ newCDPSession: jest.fn() }),
  };
  return page;
}

describe('HumanActions.readText', () => {
  it('用原生 locator.textContent 读文本', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(1), textContent: jest.fn().mockResolvedValue('hello') };
    const page = makeMockPage(locatorMock);
    const text = await HumanActions.readText(page, 'div.title');
    expect(text).toBe('hello');
    expect(page.locator).toHaveBeenCalledWith('div.title');
    expect(locatorMock.textContent).toHaveBeenCalled();
  });

  it('元素不存在返回 null', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(0), textContent: jest.fn() };
    const page = makeMockPage(locatorMock);
    const text = await HumanActions.readText(page, 'div.missing');
    expect(text).toBeNull();
    expect(locatorMock.textContent).not.toHaveBeenCalled();
  });
});

describe('HumanActions.readAttribute', () => {
  it('读属性', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(1), getAttribute: jest.fn().mockResolvedValue('btn') };
    const page = makeMockPage(locatorMock);
    const val = await HumanActions.readAttribute(page, 'button', 'class');
    expect(val).toBe('btn');
  });
});

describe('HumanActions.exists', () => {
  it('count>0 返回 true', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(2), waitFor: jest.fn() };
    const page = makeMockPage(locatorMock);
    expect(await HumanActions.exists(page, 'div')).toBe(true);
  });
  it('count=0 返回 false', async () => {
    const locatorMock = { count: jest.fn().mockResolvedValue(0), waitFor: jest.fn() };
    const page = makeMockPage(locatorMock);
    expect(await HumanActions.exists(page, 'div')).toBe(false);
  });
});

describe('HumanActions.click 拟人化前置', () => {
  it('先 hover 再 click，带 delay', async () => {
    const calls: string[] = [];
    const locatorMock = {
      count: jest.fn().mockResolvedValue(1),
      hover: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
      waitFor: jest.fn().mockResolvedValue(undefined),
    };
    const page: any = {
      locator: jest.fn().mockReturnValue(locatorMock),
      waitForTimeout: jest.fn(() => { calls.push('wait'); return Promise.resolve(); }),
      context: () => ({ newCDPSession: jest.fn() }),
    };
    await HumanActions.click(page, 'button.submit');
    expect(calls.length).toBeGreaterThan(0); // 有停顿
    expect(locatorMock.hover).toHaveBeenCalled(); // hover 前置
    expect(locatorMock.click).toHaveBeenCalled();
  });
});

describe('HumanActions.fill 逐字延迟', () => {
  it('点击聚焦后逐字输入', async () => {
    const locatorMock = {
      count: jest.fn().mockResolvedValue(1),
      click: jest.fn().mockResolvedValue(undefined),
      press: jest.fn().mockResolvedValue(undefined),
      waitFor: jest.fn().mockResolvedValue(undefined),
    };
    const page: any = {
      locator: jest.fn().mockReturnValue(locatorMock),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      context: () => ({ newCDPSession: jest.fn() }),
    };
    await HumanActions.fill(page, 'textarea', 'ab');
    expect(locatorMock.click).toHaveBeenCalled(); // 聚焦
    expect(locatorMock.press).toHaveBeenCalledTimes(2); // 逐字
  });
});

describe('HumanActions.safeEvaluate', () => {
  it('默认隔离世界，序列化参数，调 Runtime.evaluate', async () => {
    const send = jest.fn().mockImplementation((method: string, params: any) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } };
      return {};
    });
    const cdpCtx: any = { cdp: { send }, dom: {}, mouse: {}, scroller: {}, noise: {} };
    jest.spyOn(HumanActions as any, 'getCDPContext').mockResolvedValue(cdpCtx);
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };

    const result = await HumanActions.safeEvaluate(page, (a: number) => a + 1, { reason: 'test', args: [1] });

    expect(result).toBe('ok');
    const evalCall = send.mock.calls.find((c: any[]) => c[0] === 'Runtime.evaluate');
    expect(evalCall).toBeDefined();
    expect(evalCall![1].contextId).toBe(42); // 隔离世界
    expect(evalCall![1].expression).toContain('a + 1'); // 函数序列化
    expect(evalCall![1].expression).toContain('[1]'); // 参数序列化
    jest.restoreAllMocks();
  });

  it('world main 不传 contextId', async () => {
    const send = jest.fn().mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'main' } };
      return {};
    });
    const cdpCtx: any = { cdp: { send }, dom: {}, mouse: {}, scroller: {}, noise: {} };
    jest.spyOn(HumanActions as any, 'getCDPContext').mockResolvedValue(cdpCtx);
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };

    const result = await HumanActions.safeEvaluate(page, () => 'x', { reason: 'main-world-required', world: 'main' });
    const evalCall = send.mock.calls.find((c: any[]) => c[0] === 'Runtime.evaluate');
    expect(evalCall![1].contextId).toBeUndefined();
    expect(result).toBe('main');
    jest.restoreAllMocks();
  });

  it('reason 缺失抛错', async () => {
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };
    await expect(HumanActions.safeEvaluate(page, () => 1, {} as any)).rejects.toThrow(/reason/);
  });
});

describe('HumanActions stepMetricsCollector', () => {
  it('记录 actionPath 到当前活跃 step', async () => {
    const collector = { collect: jest.fn() };
    HumanActions.setStepMetricsCollector(collector as any);
    const locatorMock = { count: jest.fn().mockResolvedValue(1), textContent: jest.fn().mockResolvedValue('x') };
    const page = makeMockPage(locatorMock);
    await HumanActions.readText(page, 'div');
    expect(collector.collect).toHaveBeenCalledWith(expect.objectContaining({ actionPath: 'native-locator' }));
    HumanActions.setStepMetricsCollector(null);
  });
});

describe('CDPClient.getLayoutMetrics', () => {
  it('calls Page.getLayoutMetrics and returns full structure', async () => {
    const fakeSend = jest.fn().mockResolvedValue({
      layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1366, clientHeight: 768 },
      contentSize: { x: 0, y: 0, width: 1366, height: 3000 },
      visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, clientWidth: 1366, clientHeight: 768, scale: 1 },
    });
    const fakeSession = { send: fakeSend };
    const { CDPClient } = require('../cdpClient');
    const client = new CDPClient(fakeSession as any);
    const metrics = await client.getLayoutMetrics();
    expect(fakeSend).toHaveBeenCalledWith('Page.getLayoutMetrics', {});
    expect(metrics).toEqual({
      layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1366, clientHeight: 768 },
      contentSize: { x: 0, y: 0, width: 1366, height: 3000 },
    });
  });
});

describe('HumanActions.cdpGetDocumentScrollState', () => {
  it('returns scroll state from CDP getLayoutMetrics', async () => {
    const fakeCtx = {
      cdp: {
        getLayoutMetrics: jest.fn().mockResolvedValue({
          layoutViewport: { pageX: 0, pageY: 1747, clientWidth: 1366, clientHeight: 1305 },
          contentSize: { x: 0, y: 0, width: 1366, height: 3052 },
        }),
      },
      dom: {}, mouse: {}, scroller: {}, noise: {},
    };
    jest.spyOn(HumanActions as any, 'getCDPContext').mockResolvedValue(fakeCtx);
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };

    const state = await HumanActions.cdpGetDocumentScrollState(page);
    expect(state).toEqual({ scrollY: 1747, clientHeight: 1305, scrollHeight: 3052 });
    expect(fakeCtx.cdp.getLayoutMetrics).toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('returns null when getLayoutMetrics throws', async () => {
    const fakeCtx = {
      cdp: {
        getLayoutMetrics: jest.fn().mockRejectedValue(new Error('CDP session closed')),
      },
      dom: {}, mouse: {}, scroller: {}, noise: {},
    };
    jest.spyOn(HumanActions as any, 'getCDPContext').mockResolvedValue(fakeCtx);
    const page: any = { context: () => ({ newCDPSession: jest.fn() }) };

    const state = await HumanActions.cdpGetDocumentScrollState(page);
    expect(state).toBeNull();
    jest.restoreAllMocks();
  });
});
