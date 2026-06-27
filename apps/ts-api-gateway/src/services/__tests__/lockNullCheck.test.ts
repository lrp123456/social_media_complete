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

jest.mock('../../lib/prisma', () => ({
  prisma: {
    operationLog: { create: jest.fn().mockResolvedValue({}) },
  },
}));

jest.mock('../../lib/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../monitorService', () => ({
  reportMonitorComplete: jest.fn(),
  sendMonitorNotification: jest.fn(),
  executeMonitorCheck: jest.fn(),
  generateSuggestionsForNewComments: jest.fn(),
}));

describe('handleJob lock-null handling', () => {
  it('throws when window lock cannot be acquired (monitor)', async () => {
    const { handleJobForTest } = require('../unifiedQueue');
    const job = { id: 'j1', data: { taskType: 'monitor', taskId: 'mon_t', userId: 1, platform: 'douyin', windowId: 'fp_w' }, updateProgress: jest.fn() } as any;
    await expect(handleJobForTest(job)).rejects.toThrow('窗口锁占用中');
  });
});
