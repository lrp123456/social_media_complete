import { WindowMutex, abortPromise, LockOwner } from './redlock';

// ============================================================
// Mock
// ============================================================

const mockRedis = {
  hset: jest.fn().mockResolvedValue(1),
  hgetall: jest.fn().mockResolvedValue({}),
  keys: jest.fn().mockResolvedValue([]),
  del: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  pttl: jest.fn().mockResolvedValue(-1),
};

jest.mock('./redis', () => ({
  getRedis: jest.fn(() => mockRedis),
}));

jest.mock('../middleware/trace', () => ({
  getTraceId: jest.fn(() => 'test-trace'),
}));

const mockOwner: LockOwner = {
  taskId: 'task-1',
  taskType: 'monitor',
  traceId: 'trace-1',
};

function createMockLock(overrides?: Partial<Record<string, jest.Mock>>) {
  return {
    release: jest.fn().mockResolvedValue({}),
    extend: jest.fn().mockResolvedValue(null as any), // extend 返回自身
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // 每次 extend 返回一个新 mock lock（redlock.extend 返回新 Lock）
  let extendCallCount = 0;
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.hset.mockResolvedValue(1);
  mockRedis.del.mockResolvedValue(1);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ============================================================
// 1. acquire 成功 → 返回 Handle，owner hash 已写入
// ============================================================
describe('acquireWithBackoff', () => {
  it('1. acquire 成功：返回 MutexHandle，写入 owner hash，启动心跳', async () => {
    const mockLock = createMockLock();
    // extend 返回新 lock 对象（与 redlock 行为一致）
    mockLock.extend.mockResolvedValue(mockLock);

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-1', mockOwner);

    expect(handle.windowId).toBe('win-1');
    expect(handle.owner).toEqual(mockOwner);
    expect(handle.acquiredAt).toBeGreaterThan(0);
    expect(handle.signal.aborted).toBe(false);

    // owner hash 写入
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'window_lock:win-1:owner',
      expect.objectContaining({
        taskId: 'task-1',
        taskType: 'monitor',
        traceId: 'trace-1',
        host: expect.any(String),
        pid: expect.any(String),
        startedAt: expect.any(String),
      }),
    );
    expect(mockRedis.expire).toHaveBeenCalledWith('window_lock:win-1:owner', 30);

    // 心跳未立即触发（间隔 10s）
    expect(mockLock.extend).not.toHaveBeenCalled();

    // 清理
    await handle.release();
  });

  // ============================================================
  // 2. acquire 排队 → 第一次失败，第二次成功，onWaiting 被调用
  // ============================================================
  it('2. acquire 排队：第一次失败，第二次成功，onWaiting 被调用', async () => {
    // 此测试需要真实 setTimeout（重试间隔 5s），不使用 fake timers
    jest.useRealTimers();

    const mockLock = createMockLock();
    mockLock.extend.mockResolvedValue(mockLock);

    let attempts = 0;
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockImplementation(async () => {
      attempts++;
      if (attempts < 2) throw new Error('locked');
      return mockLock;
    });

    const onWaiting = jest.fn();
    const handle = await WindowMutex.acquireWithBackoff('win-2', mockOwner, { onWaiting });

    expect(attempts).toBe(2);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }));

    await handle.release();

    jest.useFakeTimers();
  }, 15000);

  // ============================================================
  // 3. acquire 取消 → onWaiting 抛错 → reject
  // ============================================================
  it('3. acquire 取消：onWaiting 抛错 → acquireWithBackoff reject', async () => {
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockRejectedValue(new Error('locked'));

    const cancelErr = new Error('TASK_CANCELLED');
    const onWaiting = jest.fn(() => {
      throw cancelErr;
    });

    await expect(WindowMutex.acquireWithBackoff('win-3', mockOwner, { onWaiting })).rejects.toThrow(
      'TASK_CANCELLED',
    );
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 4. release 幂等 → 连续调用 3 次不抛错
  // ============================================================
  it('4. release 幂等：连续调用 3 次不抛错，lock.release 只调一次', async () => {
    const mockLock = createMockLock();
    mockLock.extend.mockResolvedValue(mockLock);
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-4', mockOwner);

    await handle.release();
    await handle.release();
    await handle.release();

    // lock.release 只调一次
    expect(mockLock.release).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 5. release 清理 → owner hash DEL，lock 释放
  // ============================================================
  it('5. release 清理：DEL owner hash + 释放 lock + 停心跳', async () => {
    const mockLock = createMockLock();
    mockLock.extend.mockResolvedValue(mockLock);
    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-5', mockOwner);

    await handle.release();

    expect(mockRedis.del).toHaveBeenCalledWith('window_lock:win-5:owner');
    expect(mockLock.release).toHaveBeenCalled();
  });

  // ============================================================
  // 6. 心跳续约 → 10s 后 extend 被调用，owner EXPIRE 被调用
  // ============================================================
  it('6. 心跳续约：10s 后 extend + EXPIRE owner hash', async () => {
    const mockLock = createMockLock();
    const extendedLock = createMockLock();
    extendedLock.extend.mockResolvedValue(extendedLock);
    mockLock.extend.mockResolvedValue(extendedLock);

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-6', mockOwner);

    // 推进 10 秒
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockLock.extend).toHaveBeenCalledWith(30_000);
    expect(mockRedis.expire).toHaveBeenCalledWith('window_lock:win-6:owner', 30);

    await handle.release();
  });

  // ============================================================
  // 7. 续约失败 abort → extend reject → signal.aborted
  // ============================================================
  it('7. 续约失败：extend reject → signal.aborted=true，reason 含 lock_lost', async () => {
    const mockLock = createMockLock();
    mockLock.extend.mockRejectedValue(new Error('lock expired'));

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockResolvedValue(mockLock);

    const handle = await WindowMutex.acquireWithBackoff('win-7', mockOwner);
    expect(handle.signal.aborted).toBe(false);

    // 推进 10 秒触发心跳，extend 失败
    await jest.advanceTimersByTimeAsync(10_000);

    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toContain('lock_lost');

    // release 仍可用（幂等）
    await handle.release();
  });

  // ============================================================
  // 8. inspect → mock HGETALL，返回结构化 owner 列表
  // ============================================================
  it('8. inspect：返回结构化 owner 列表', async () => {
    const now = Date.now();
    mockRedis.keys.mockResolvedValue(['window_lock:win-8:owner']);
    mockRedis.hgetall.mockResolvedValue({
      taskId: 'task-8',
      taskType: 'reply',
      traceId: 'trace-8',
      startedAt: String(now - 5000),
      host: 'test-host',
      pid: '1234',
    });
    mockRedis.pttl.mockResolvedValue(25_000);

    const snapshots = await WindowMutex.inspect('win-8');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      windowId: 'win-8',
      taskId: 'task-8',
      taskType: 'reply',
      traceId: 'trace-8',
      host: 'test-host',
      pid: 1234,
      startedAt: now - 5000,
      ageMs: expect.any(Number),
      ttlRemainingMs: 25_000,
    });
  });

  // ============================================================
  // 9. 多窗口隔离 → win-A 持锁不影响 win-B
  // ============================================================
  it('9. 多窗口隔离：win-A 持锁不影响 win-B acquire', async () => {
    const lockA = createMockLock();
    lockA.extend.mockResolvedValue(lockA);
    const lockB = createMockLock();
    lockB.extend.mockResolvedValue(lockB);

    jest.spyOn(WindowMutex as any, 'tryAcquire').mockImplementation(async (windowId: string) => {
      if (windowId === 'win-A') return lockA;
      if (windowId === 'win-B') return lockB;
      throw new Error('unknown window');
    });

    const handleA = await WindowMutex.acquireWithBackoff('win-A', mockOwner);
    const handleB = await WindowMutex.acquireWithBackoff('win-B', mockOwner);

    expect(handleA.windowId).toBe('win-A');
    expect(handleB.windowId).toBe('win-B');
    expect(mockRedis.hset).toHaveBeenCalledTimes(2);

    await handleA.release();
    await handleB.release();
  });
});

// ============================================================
// abortPromise 单独测试
// ============================================================
describe('abortPromise', () => {
  it('10. signal 未 abort 时 pending，abort 后 reject', async () => {
    const ac = new AbortController();

    const race = Promise.race([
      abortPromise(ac.signal),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);

    ac.abort('test reason');

    await expect(race).rejects.toThrow('锁失效，业务中止');
  });

  it('11. signal 已 aborted 时立即 reject', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(abortPromise(ac.signal)).rejects.toThrow('锁失效，业务中止');
  });
});
