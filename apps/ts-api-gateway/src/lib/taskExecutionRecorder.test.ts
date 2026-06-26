import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockPrisma = {
  systemStatus: { findFirst: jest.fn() },
  taskExecution: {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
  },
  taskExecutionStep: { create: jest.fn() },
};

// Module-level mocks for MaintenanceProbe (used by recordSelectorTry)
const mockProbe = {
  isEnabled: jest.fn().mockReturnValue(false),
  recordSelectorOp: jest.fn(),
};

jest.mock('./prisma', () => ({ prisma: mockPrisma }));
jest.mock('./logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('../services/maintenanceCollector', () => ({
  getMaintenanceCollector: () => ({ summarizeExecution: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('@social-media/browser-core', () => ({
  MaintenanceProbe: mockProbe,
}));

import { startExecution, updatePhase, recordSelectorTry, finishExecution } from './taskExecutionRecorder';
import type { ReplyTaskData } from '../services/unifiedQueue';

describe('taskExecutionRecorder', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const mockTask: ReplyTaskData = {
    taskType: 'reply', taskId: 'task-123', userId: 1, platform: 'douyin',
    windowId: 'win-1', windowExternalId: 'fp-1',
    replyData: { videoId: 'v1', commentCid: 'c1', text: 'hi' },
  };
  const mockJob = { updateProgress: jest.fn() };

  it('startExecution creates record with isDebugMode from SystemStatus', async () => {
    mockPrisma.systemStatus.findFirst.mockResolvedValue({ isDebugMode: true });
    mockPrisma.taskExecution.create.mockResolvedValue({ id: 'exec-1' });
    const execId = await startExecution(mockTask, mockJob as any);
    expect(execId).toBe('exec-1');
    expect(mockPrisma.taskExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskId: 'task-123', taskType: 'reply', isDebugMode: true, status: 'running' }),
    });
  });

  it('updatePhase updates DB and calls job.updateProgress', async () => {
    await updatePhase('exec-1', 3, '定位视频', 30, '选择目标视频中');
    expect(mockPrisma.taskExecution.update).toHaveBeenCalled();
    expect(mockJob.updateProgress).toHaveBeenCalledWith({
      phase: '定位视频', step: '第 3 阶段', percent: 30, detail: '选择目标视频中',
    });
  });

  it('recordSelectorTry is no-op when probe disabled', async () => {
    mockProbe.isEnabled.mockReturnValue(false);
    await recordSelectorTry('exec-1', 'label', { phase: 'test', selectors: [] });
    expect(mockProbe.recordSelectorOp).not.toHaveBeenCalled();
  });

  it('recordSelectorTry calls recordSelectorOp when probe enabled', async () => {
    mockProbe.isEnabled.mockReturnValue(true);
    await recordSelectorTry('exec-1', 'click-btn', {
      phase: '执行回复',
      selectors: [{ selector: '.primary', hit: false, isPrimary: true }, { selector: '.fallback', hit: true, isPrimary: false }],
      mouseAction: 'click(412,287)',
    });
    expect(mockProbe.recordSelectorOp).toHaveBeenCalledTimes(2);
    expect(mockProbe.recordSelectorOp).toHaveBeenNthCalledWith(1, {
      selectorKey: 'click-btn',
      selectorUsed: '.primary',
      selectorSource: 'primary',
      result: 'not_found',
      durationMs: 0,
    });
    expect(mockProbe.recordSelectorOp).toHaveBeenNthCalledWith(2, {
      selectorKey: 'click-btn',
      selectorUsed: '.fallback',
      selectorSource: 'fallback_1',
      result: 'found',
      durationMs: 0,
    });
  });

  it('finishExecution updates status and computes durationMs', async () => {
    await finishExecution('exec-1', 'completed');
    expect(mockPrisma.taskExecution.update).toHaveBeenCalledWith({
      where: { id: 'exec-1' },
      data: expect.objectContaining({ status: 'completed', completedAt: expect.any(Date), durationMs: expect.any(Number) }),
    });
  });
});
