// @ts-api-gateway/services/maintenanceCollector.ts
// MaintenanceCollector — Redis BRPOP 消费 + 批量 flush + 健康汇总

import Redis from 'ioredis';
import { getRedis } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('maintenance-collector');

// ============================================================
// Types
// ============================================================

interface SelectorPayload {
  selectorKey: string;
  selectorUsed: string;
  selectorSource: string;
  result: string;
  durationMs: number;
  elementTag?: string;
  elementText?: string;
  isVisible?: boolean;
  isHoneypotBlocked?: boolean;
  honeypotReason?: string;
  scopeSelector?: string;
  scopeMatchTimeMs?: number;
  errorMessage?: string;
}

interface UrlPayload {
  healthKey?: string;
  urlPattern: string;
  actualUrl?: string;
  httpStatus?: number;
  result: string;
  validationStep?: string;
  itemsFound?: number;
  hasMore?: boolean;
  cursorValue?: string;
  extractionValid?: boolean;
  missingFields?: string;
  requestParams?: string;
  videoId?: string;
  commentCid?: string;
  durationMs?: number;
  responseSize?: number;
}

interface SelectorEvent {
  type: 'selector';
  context: {
    flow: string;
    platform: string;
    phase: string;
    step: string;
    taskExecutionId: string;
  };
  payload: SelectorPayload;
  ts: number;
}

interface UrlEvent {
  type: 'url_check';
  context: {
    flow: string;
    platform: string;
    phase: string;
    step: string;
    taskExecutionId: string;
  };
  payload: UrlPayload;
  ts: number;
}

type ProbeEvent = SelectorEvent | UrlEvent;

interface BufferedEvent {
  event: ProbeEvent;
  receivedAt: Date;
}

// ============================================================
// MaintenanceCollector
// ============================================================

export class MaintenanceCollector {
  private buffer: BufferedEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private running = false;
  private redis: Redis;

  private readonly FLUSH_INTERVAL_MS = 5000;
  private readonly BATCH_SIZE = 50;
  private readonly QUEUE_KEY = 'probe_events';

  constructor() {
    this.redis = getRedis();
  }

  // ======================== Public API ========================

  /** Start BRPOP consumer (non-blocking: spawned as detached promise) */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.flushTimer = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);
    // Fire-and-forget consumer loop
    this.consumeLoop().catch((err) => {
      logger.error({ err }, 'MaintenanceCollector consume loop crashed');
      this.running = false;
    });
    logger.info('MaintenanceCollector started');
  }

  /** Graceful stop */
  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    logger.info('MaintenanceCollector stopped');
  }

  /** Force-flush any buffered events */
  async flushNow(): Promise<void> {
    await this.flush();
  }

  /** Ingest a single event directly (bypasses Redis, used for testing) */
  async ingestOne(event: ProbeEvent): Promise<void> {
    await this.persistEvent(event);
  }

  /** Summarize an execution's health and persist to DB (idempotent) */
  async summarizeExecution(taskExecutionId: string): Promise<void> {
    const exec = await prisma.maintenanceExecution.findUnique({
      where: { taskExecutionId },
      include: { steps: true },
    });
    if (!exec) {
      logger.warn({ taskExecutionId }, 'summarizeExecution: execution not found');
      return;
    }

    // Aggregate step-level stats
    const totalSteps = exec.steps.length;
    const healthySteps = exec.steps.filter((s: { healthStatus: string }) => s.healthStatus === 'healthy').length;
    const degradedSteps = exec.steps.filter((s: { healthStatus: string }) => s.healthStatus === 'degraded').length;
    const failedSteps = exec.steps.filter((s: { healthStatus: string }) => s.healthStatus === 'failed').length;

    const stepIds = exec.steps.map((s: { id: string }) => s.id);

    // Aggregate selector-level stats
    const selectorsWithResult = await prisma.maintenanceSelectorRecord.groupBy({
      by: ['result'],
      where: { stepId: { in: stepIds } },
      _count: true,
    });
    const totalSelectors = selectorsWithResult.reduce((sum: number, r: { _count: number }) => sum + r._count, 0);
    const passedSelectors = selectorsWithResult
      .filter((r: { result: string }) => r.result === 'found')
      .reduce((sum: number, r: { _count: number }) => sum + r._count, 0);
    const failedSelectors = selectorsWithResult
      .filter((r: { result: string }) => r.result !== 'found')
      .reduce((sum: number, r: { _count: number }) => sum + r._count, 0);

    // Aggregate URL-level stats
    const urlsWithResult = await prisma.maintenanceUrlRecord.groupBy({
      by: ['result'],
      where: { stepId: { in: stepIds } },
      _count: true,
    });
    const totalUrlChecks = urlsWithResult.reduce((sum: number, r: { _count: number }) => sum + r._count, 0);
    const passedUrlChecks = urlsWithResult
      .filter((r: { result: string }) => r.result === 'matched')
      .reduce((sum: number, r: { _count: number }) => sum + r._count, 0);

    // Determine overall health
    let overallHealth: string;
    if (failedSelectors > 0 || failedSteps > 0) {
      overallHealth = 'failed';
    } else if (degradedSteps > 0 || totalSelectors === 0) {
      overallHealth = 'degraded';
    } else {
      overallHealth = 'healthy';
    }

    await prisma.maintenanceExecution.update({
      where: { id: exec.id },
      data: {
        totalSteps,
        healthySteps,
        degradedSteps,
        failedSteps,
        totalSelectors,
        passedSelectors,
        failedSelectors,
        totalUrlChecks,
        passedUrlChecks,
        overallHealth,
        completedAt: new Date(),
      },
    });

    logger.info({ taskExecutionId, overallHealth }, 'Execution summarized');
  }

  // ======================== Internal ========================

  /** Background loop: BRPOP probe_events and buffer them */
  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.redis.brpop(this.QUEUE_KEY, 5);
        if (result) {
          const [, raw] = result;
          try {
            const event: ProbeEvent = JSON.parse(raw as string);
            this.buffer.push({ event, receivedAt: new Date() });
            if (this.buffer.length >= this.BATCH_SIZE) {
              await this.flush();
            }
          } catch (parseErr) {
            logger.warn({ raw }, 'Failed to parse probe event');
          }
        }
      } catch (err) {
        if (this.running) {
          logger.error({ err }, 'BRPOP error, retrying...');
          // Brief backoff before retry
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  /** Flush buffered events to database */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    logger.debug({ count: batch.length }, 'Flushing probe events');

    for (const { event } of batch) {
      try {
        await this.persistEvent(event);
      } catch (err) {
        logger.error({ err, eventType: event.type }, 'Failed to persist event');
      }
    }
  }

  /** Persist a single event to database */
  private async persistEvent(event: ProbeEvent): Promise<void> {
    if (event.type === 'selector') {
      const { context, payload } = event;
      const step = await this.findOrCreateStep(context);
      await prisma.maintenanceSelectorRecord.create({
        data: {
          stepId: step.id,
          selectorKey: payload.selectorKey,
          selectorUsed: payload.selectorUsed,
          selectorSource: payload.selectorSource,
          result: payload.result,
          durationMs: payload.durationMs,
          elementTag: payload.elementTag,
          elementText: payload.elementText,
          isVisible: payload.isVisible,
          isHoneypotBlocked: payload.isHoneypotBlocked,
          honeypotReason: payload.honeypotReason,
          scopeSelector: payload.scopeSelector,
          scopeMatchTimeMs: payload.scopeMatchTimeMs,
          errorMessage: payload.errorMessage,
        },
      });

      const isPassed = payload.result === 'found';
      await prisma.maintenanceStep.update({
        where: { id: step.id },
        data: {
          selectorCount: { increment: 1 },
          ...(isPassed ? { selectorPassed: { increment: 1 } } : {}),
        },
      });
    } else if (event.type === 'url_check') {
      const { context, payload } = event;
      const step = await this.findOrCreateStep(context);
      await prisma.maintenanceUrlRecord.create({
        data: {
          stepId: step.id,
          healthKey: payload.healthKey,
          urlPattern: payload.urlPattern,
          actualUrl: payload.actualUrl,
          httpStatus: payload.httpStatus,
          result: payload.result,
          validationStep: payload.validationStep,
          itemsFound: payload.itemsFound,
          hasMore: payload.hasMore,
          cursorValue: payload.cursorValue,
          extractionValid: payload.extractionValid,
          missingFields: payload.missingFields,
          requestParams: payload.requestParams,
          videoId: payload.videoId,
          commentCid: payload.commentCid,
          durationMs: payload.durationMs,
          responseSize: payload.responseSize,
        },
      });

      const isPassed = payload.result === 'matched';
      await prisma.maintenanceStep.update({
        where: { id: step.id },
        data: {
          urlCount: { increment: 1 },
          ...(isPassed ? { urlPassed: { increment: 1 } } : {}),
        },
      });
    }
  }

  /** Find or create a MaintenanceStep for the given execution context */
  private async findOrCreateStep(context: SelectorEvent['context']): Promise<{ id: string }> {
    // Find or auto-create execution
    let exec = await prisma.maintenanceExecution.findUnique({
      where: { taskExecutionId: context.taskExecutionId },
    });
    if (!exec) {
      exec = await prisma.maintenanceExecution.create({
        data: {
          taskExecutionId: context.taskExecutionId,
          platform: context.platform,
          flowType: context.flow,
          windowId: '',
        },
      });
    }

    // Find existing step for this execution + phase + stepName
    const existingStep = await prisma.maintenanceStep.findFirst({
      where: {
        executionId: exec.id,
        phase: context.phase,
        stepName: context.step,
      },
    });
    if (existingStep) return existingStep;

    // Create new step
    return prisma.maintenanceStep.create({
      data: {
        executionId: exec.id,
        phase: context.phase,
        stepName: context.step,
        healthStatus: 'healthy',
        outcomeSuccess: true,
      },
    });
  }
}
