import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Shared mutable mock queue — var 确保被 jest.mock 闭包捕获
var mockQueue: any = {};

jest.mock('../../lib/redis', () => ({
  getRedis: jest.fn(() => ({})),
}));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => mockQueue),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  })),
  Job: jest.fn(),
}));

jest.mock('../../lib/redlock', () => ({
  WindowMutex: {
    tryAcquireOnce: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../lib/taskExecutionRecorder', () => ({
  startExecution: jest.fn().mockResolvedValue('exec_test'),
  finishExecution: jest.fn().mockResolvedValue(undefined),
  updatePhase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../middleware/trace', () => ({
  getTraceId: jest.fn().mockReturnValue('test-trace'),
}));

describe('enqueueMonitor per-(window,platform) dedup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 默认 mock 队列：无活跃任务，add 成功
    mockQueue = {
      name: 'platform-w4',
      add: jest.fn().mockResolvedValue({ id: 'new-job' }),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    jest.resetModules();
  });

  it('should reject duplicate when same window+platform job is active', async () => {
    const activeJob = {
      data: { userId: 6, platform: 'tencent', windowId: 'w4' },
      isActive: () => Promise.resolve(true),
      isWaiting: () => Promise.resolve(false),
    };
    mockQueue = {
      name: 'platform-w4',
      add: jest.fn(),
      getJobs: jest.fn(async (states: string[]) => {
        if (states.includes('active')) return [activeJob];
        return [];
      }),
    };

    const mod = await import('../unifiedQueue');

    const result = await mod.enqueueMonitor({
      taskId: 'mon_dup', userId: 13, platform: 'tencent' as any,
      windowId: 'w4', windowExternalId: 'w4',
    });

    expect(result).toEqual({ enqueued: false, reason: 'duplicate' });
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('should reject duplicate when same window+platform job is waiting', async () => {
    const waitingJob = {
      data: { userId: 6, platform: 'tencent', windowId: 'w4' },
      isActive: () => Promise.resolve(false),
      isWaiting: () => Promise.resolve(true),
    };
    mockQueue = {
      name: 'platform-w4',
      add: jest.fn(),
      getJobs: jest.fn(async (states: string[]) => {
        if (states.includes('waiting')) return [waitingJob];
        return [];
      }),
    };

    const mod = await import('../unifiedQueue');

    const result = await mod.enqueueMonitor({
      taskId: 'mon_dup_wait', userId: 13, platform: 'tencent' as any,
      windowId: 'w4', windowExternalId: 'w4',
    });

    expect(result).toEqual({ enqueued: false, reason: 'duplicate' });
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('should NOT reject when same window different platform', async () => {
    const activeJob = {
      data: { userId: 6, platform: 'douyin', windowId: 'w4' },
      isActive: () => Promise.resolve(true),
      isWaiting: () => Promise.resolve(false),
    };
    mockQueue = {
      name: 'platform-w4',
      add: jest.fn().mockResolvedValue({ id: 'new-job' }),
      getJobs: jest.fn(async (states: string[]) => {
        if (states.includes('active')) return [activeJob];
        return [];
      }),
    };

    const mod = await import('../unifiedQueue');

    const result = await mod.enqueueMonitor({
      taskId: 'mon_diff_pf', userId: 13, platform: 'tencent' as any,
      windowId: 'w4', windowExternalId: 'w4',
    });

    expect(result.enqueued).toBe(true);
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  it('should enqueue when no active/waiting same window+platform job', async () => {
    mockQueue = {
      name: 'platform-w4',
      add: jest.fn().mockResolvedValue({ id: 'new-job' }),
      getJobs: jest.fn().mockResolvedValue([]),
    };

    const mod = await import('../unifiedQueue');

    const result = await mod.enqueueMonitor({
      taskId: 'mon_ok', userId: 13, platform: 'tencent' as any,
      windowId: 'w4', windowExternalId: 'w4',
    });

    expect(result.enqueued).toBe(true);
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });
});
