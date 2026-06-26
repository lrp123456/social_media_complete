// @ts-api-gateway/lib/taskExecutionRecorder.ts - 任务执行记录器
// 记录任务执行阶段进度和 debug 选择器尝试步骤

import type { Job } from 'bullmq';
import { prisma } from './prisma';
import { createLogger } from './logger';
import type { PlatformTask } from '../services/unifiedQueue';

const logger = createLogger('task-exec-recorder');
const jobCache = new Map<string, Job>();
const stepCounter = new Map<string, number>();
const startTimeCache = new Map<string, number>();

const TOTAL_PHASES: Record<string, number> = { reply: 6, monitor: 3, publish: 4 };

async function getDebugMode(): Promise<boolean> {
  try {
    const status = await prisma.systemStatus.findFirst();
    return status?.isDebugMode ?? false;
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Failed to read isDebugMode, defaulting false');
    return false;
  }
}

export async function startExecution(task: PlatformTask, job: Job): Promise<string> {
  const isDebugMode = await getDebugMode();
  const execution = await prisma.taskExecution.create({
    data: {
      taskId: task.taskId,
      taskType: task.taskType,
      platform: (task as any).platform || 'unknown',
      userId: (task as any).userId ?? null,
      windowId: task.windowId,
      status: 'running',
      totalPhases: TOTAL_PHASES[task.taskType] ?? null,
      isDebugMode,
    },
  });
  jobCache.set(execution.id, job);
  startTimeCache.set(execution.id, Date.now());
  logger.info({ executionId: execution.id, taskId: task.taskId, taskType: task.taskType, isDebugMode }, 'Execution started');

  // 维护调试：1:1 关联 MaintenanceExecution
  try {
    await prisma.maintenanceExecution.create({
      data: {
        taskExecutionId: execution.id,
        platform: (task as any).platform || 'unknown',
        flowType: task.taskType,
        windowId: task.windowId,
        userId: (task as any).userId ?? null,
      },
    });
  } catch (err: any) {
    logger.warn({ executionId: execution.id, error: err.message }, 'create MaintenanceExecution failed (non-fatal)');
  }

  return execution.id;
}

export async function updatePhase(
  executionId: string,
  phaseIndex: number,
  phaseName: string,
  percent: number,
  detail?: string,
): Promise<void> {
  try {
    await prisma.taskExecution.update({
      where: { id: executionId },
      data: { currentPhase: phaseName, phaseIndex, progressPercent: percent },
    });
    const job = jobCache.get(executionId);
    if (job) {
      await job.updateProgress({ phase: phaseName, step: `第 ${phaseIndex} 阶段`, percent, detail });
    }
  } catch (err: any) {
    logger.warn({ executionId, error: err.message }, 'updatePhase failed (non-fatal)');
  }
}

export async function recordSelectorTry(
  executionId: string,
  label: string,
  data: {
    phase: string;
    selectors: Array<{ selector: string; hit: boolean; isPrimary: boolean }>;
    mouseAction?: string;
    extra?: Record<string, any>;
  },
): Promise<void> {
  try {
    const exec = await prisma.taskExecution.findUnique({
      where: { id: executionId },
      select: { isDebugMode: true },
    });
    if (!exec?.isDebugMode) return;

    const hits = data.selectors.filter(s => s.hit);
    const status = hits.length === 0 ? 'failed'
      : hits.some(s => !s.isPrimary) ? 'fallback' : 'success';

    const currentIdx = stepCounter.get(executionId) ?? 0;
    stepCounter.set(executionId, currentIdx + 1);

    await prisma.taskExecutionStep.create({
      data: {
        executionId,
        phase: data.phase,
        stepIndex: currentIdx,
        label,
        status,
        selectorTries: data.selectors as any,
        mouseAction: data.mouseAction ?? null,
        extra: (data.extra as any) ?? null,
      },
    });
  } catch (err: any) {
    logger.warn({ executionId, label, error: err.message }, 'recordSelectorTry failed (non-fatal)');
  }
}

export async function finishExecution(
  executionId: string,
  status: 'completed' | 'failed' | 'cancelled',
  errorMessage?: string,
): Promise<void> {
  try {
    const startedAt = startTimeCache.get(executionId);
    const durationMs = startedAt ? Date.now() - startedAt : null;
    await prisma.taskExecution.update({
      where: { id: executionId },
      data: { status, completedAt: new Date(), durationMs, errorMessage: errorMessage ?? null },
    });

    // 维护调试：汇总健康数据
    try {
      const { getMaintenanceCollector } = await import('../services/maintenanceCollector');
      await getMaintenanceCollector().summarizeExecution(executionId);
    } catch (err: any) {
      logger.warn({ executionId, error: err.message }, 'summarizeExecution failed (non-fatal)');
    }
  } catch (err: any) {
    logger.warn({ executionId, error: err.message }, 'finishExecution failed (non-fatal)');
  } finally {
    jobCache.delete(executionId);
    stepCounter.delete(executionId);
    startTimeCache.delete(executionId);
  }
}
