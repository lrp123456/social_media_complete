import { WindowMutex } from './redlock';

describe('WindowMutex.acquireWithBackoff', () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
      callback();
      return 0 as any;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('waits long enough by default for a 3 minute lock TTL to expire', async () => {
    const lock = { release: jest.fn() } as any;
    let attempts = 0;
    jest.spyOn(WindowMutex, 'acquire').mockImplementation(async () => {
      attempts++;
      if (attempts < 8) {
        throw new Error('locked');
      }
      return lock;
    });

    await expect(WindowMutex.acquireWithBackoff('win-1')).resolves.toBe(lock);
    expect(attempts).toBe(8);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(7);
  });
});
