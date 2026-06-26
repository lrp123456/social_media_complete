// @social-media/browser-core/maintenanceProbe.ts
// 健康探针：AsyncLocalStorage 隔离并发任务上下文，事件经 Redis LPUSH 异步推送。
// Redis 不可用时静默丢弃，绝不阻塞业务流程。

import { AsyncLocalStorage } from 'async_hooks';

export interface ProbeContext {
  flow: string;
  platform: string;
  phase: string;
  step: string;
  subStep?: string;
  taskExecutionId?: string;
}

export type RedisPusher = (channel: string, payload: string) => Promise<void>;

export const PROBE_CHANNEL = 'probe_events';
const BYPASS_CAP_PER_STEP = 100;
const DEBUG_SAMPLE_RATE = 0.2;
const DEBUG_TRIGGER_AFTER_N = 3;
const DEBUG_MAX_SNAPSHOTS_PER_EXEC = 50;

export interface SelectorOp {
  selectorKey: string;
  selectorUsed: string;
  selectorSource: 'primary' | 'fallback_1' | 'fallback_2';
  result: 'found' | 'not_found' | 'timeout' | 'error' | 'honeypot_blocked' | 'scope_not_found';
  durationMs: number;
  elementTag?: string;
  elementText?: string;
  isVisible?: boolean;
  isHoneypotBlocked?: boolean;
  honeypotReason?: 'off-screen' | 'obscured' | 'too-small';
  scopeSelector?: string;
  scopeMatchTimeMs?: number;
  errorMessage?: string;
}

export interface UrlInterceptOp {
  healthKey: string;
  urlPattern: string;
  actualUrl: string;
  httpStatus: number;
  result: 'matched' | 'no_match' | 'timeout' | 'extraction_failed' | 'validation_failed';
  validationStep?: string;
  itemsFound?: number;
  hasMore?: boolean;
  cursorValue?: string;
  extractionValid?: boolean;
  missingFields?: string[];
  requestParams?: Record<string, unknown>;
  durationMs: number;
  responseSize: number;
  videoId?: string;
  commentCid?: string;
}

interface ProbeEvent {
  type: 'selector' | 'url' | 'bypass' | 'snapshot';
  context: ProbeContext;
  payload: Record<string, unknown>;
  ts: number;
}

class MaintenanceProbeClass {
  private enabled = false;
  private contextStore = new AsyncLocalStorage<ProbeContext>();
  private pusher: RedisPusher | null = null;
  private buffer: ProbeEvent[] = [];
  private bypassCountInStep = 0;
  private snapshotCountPerExec = new Map<string, number>();
  private consecutiveFailuresPerExec = new Map<string, number>();
  __lastPushed: any[] = [];

  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  setRedisPusher(p: RedisPusher | null): void { this.pusher = p; }

  reset(): void {
    this.enabled = false;
    this.pusher = null;
    this.buffer = [];
    this.bypassCountInStep = 0;
    this.snapshotCountPerExec.clear();
    this.consecutiveFailuresPerExec.clear();
    this.__lastPushed = [];
    this.contextStore.disable();
  }

  enterStep(
    flow: string, platform: string, phase: string, step: string,
    subStep?: string, taskExecutionId?: string,
  ): void {
    this.bypassCountInStep = 0;
    const ctx: ProbeContext = { flow, platform, phase, step, subStep, taskExecutionId };
    this.contextStore.enterWith(ctx);
  }

  exitStep(): void {
    // AsyncLocalStorage 无法显式 pop；下游 await 自然脱离上下文。
  }

  getContext(): ProbeContext | undefined {
    return this.contextStore.getStore();
  }

  async recordSelectorOp(op: SelectorOp): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx) return;
    this.trackFailure(ctx.taskExecutionId, op.result !== 'found');
    this.buffer.push({ type: 'selector', context: ctx, payload: { ...op }, ts: 0 });
  }

  async recordUrlIntercept(op: UrlInterceptOp): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx) return;
    this.trackFailure(ctx.taskExecutionId, op.result !== 'matched');
    this.buffer.push({ type: 'url', context: ctx, payload: { ...op }, ts: 0 });
  }

  private trackFailure(execId: string | undefined, isFailure: boolean): void {
    if (!execId) return;
    const cur = this.consecutiveFailuresPerExec.get(execId) ?? 0;
    this.consecutiveFailuresPerExec.set(execId, isFailure ? cur + 1 : 0);
  }

  async recordBypass(method: string, stack: string | undefined, windowId: string): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx) return;
    if (this.bypassCountInStep >= BYPASS_CAP_PER_STEP) return;
    this.bypassCountInStep++;
    this.buffer.push({
      type: 'bypass', context: ctx,
      payload: { method, stack, windowId, selectorSource: 'bypass_detected' }, ts: 0,
    });
  }

  async recordSnapshot(
    type: 'dom' | 'response' | 'network',
    data: { selectorKey?: string; urlPattern?: string; content: string; mimeType: string },
  ): Promise<void> {
    if (!this.enabled) return;
    const ctx = this.contextStore.getStore();
    if (!ctx || !ctx.taskExecutionId) return;
    const execId = ctx.taskExecutionId;

    const count = this.snapshotCountPerExec.get(execId) ?? 0;
    if (count >= DEBUG_MAX_SNAPSHOTS_PER_EXEC) return;

    const failures = this.consecutiveFailuresPerExec.get(execId) ?? 0;
    if (failures < DEBUG_TRIGGER_AFTER_N) return;

    if (!this.sampleByHash(execId, count, data.content)) return;

    this.snapshotCountPerExec.set(execId, count + 1);
    this.buffer.push({ type: 'snapshot', context: ctx, payload: { snapshotType: type, ...data }, ts: 0 });
  }

  private sampleByHash(execId: string, count: number, content: string): boolean {
    let h = 0;
    const s = `${execId}:${count}:${content.length}`;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return (h % 100) < DEBUG_SAMPLE_RATE * 100;
  }

  async flush(): Promise<void> {
    if (!this.pusher || this.buffer.length === 0) {
      this.__lastPushed = [];
      return;
    }
    const events = this.buffer.splice(0);
    this.__lastPushed = [];
    for (const ev of events) {
      try {
        await this.pusher(PROBE_CHANNEL, JSON.stringify(ev));
        this.__lastPushed.push(ev);
      } catch (err: any) {
        // 静默丢弃
      }
    }
  }
}

export const MaintenanceProbe = new MaintenanceProbeClass();
