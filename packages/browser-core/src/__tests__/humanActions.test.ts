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
    const locatorMock = { textContent: jest.fn().mockResolvedValue('hello') };
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
