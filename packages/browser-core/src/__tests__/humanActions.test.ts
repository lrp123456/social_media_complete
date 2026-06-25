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
