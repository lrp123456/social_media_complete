import { MaintenanceCollector } from './maintenanceCollector';
import { prisma } from '../lib/prisma';

async function ingest(collector: MaintenanceCollector, events: any[]) {
  for (const e of events) await (collector as any).ingestOne(e);
  await (collector as any).flushNow();
}

function ev(over: Partial<any> = {}) {
  return {
    type: 'selector',
    context: { flow: 'monitor', platform: 'douyin', phase: 'phase1', step: 'expandMenu', taskExecutionId: 'exec-1' },
    payload: { selectorKey: 'menu_home', selectorUsed: '#h', selectorSource: 'primary', result: 'found', durationMs: 5 },
    ts: 0,
    ...over,
  };
}

describe('MaintenanceCollector', () => {
  let collector: MaintenanceCollector;

  beforeEach(() => { collector = new MaintenanceCollector(); });
  afterAll(async () => { await prisma.maintenanceExecution.deleteMany({}); await prisma.taskExecution.deleteMany({}); await prisma.$disconnect(); });

  it('flush persists selector events into maintenance_selector_records linked to a step', async () => {
    await prisma.taskExecution.create({
      data: { id: 'exec-t1', taskId: 'job-t1', taskType: 'monitor', platform: 'douyin', windowId: 'w1' },
    });
    const exec = await prisma.maintenanceExecution.create({
      data: { taskExecutionId: 'exec-t1', platform: 'douyin', flowType: 'monitor', windowId: 'w1' },
    });
    await ingest(collector, [
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t1' } }),
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t1' }, payload: { ...ev().payload, result: 'not_found' } }),
    ]);
    const records = await prisma.maintenanceSelectorRecord.findMany({
      include: { step: true },
    });
    const mine = records.filter((r: { step: { executionId: string } }) => r.step.executionId === exec.id);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    await prisma.maintenanceSelectorRecord.deleteMany({ where: { step: { executionId: exec.id } } });
    await prisma.maintenanceStep.deleteMany({ where: { executionId: exec.id } });
    await prisma.maintenanceExecution.delete({ where: { id: exec.id } });
    await prisma.taskExecution.delete({ where: { id: 'exec-t1' } });
  });

  it('summarizeExecution computes healthy/degraded/failed counts', async () => {
    await prisma.taskExecution.create({
      data: { id: 'exec-t2', taskId: 'job-t2', taskType: 'monitor', platform: 'douyin', windowId: 'w1' },
    });
    const exec = await prisma.maintenanceExecution.create({
      data: { taskExecutionId: 'exec-t2', platform: 'douyin', flowType: 'monitor', windowId: 'w1' },
    });
    await ingest(collector, [
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t2' }, payload: { ...ev().payload, result: 'found' } }),
      ev({ context: { ...ev().context, taskExecutionId: 'exec-t2', step: 'scroll' }, payload: { ...ev().payload, result: 'not_found' } }),
    ]);
    await collector.summarizeExecution('exec-t2');
    const summed = await prisma.maintenanceExecution.findUnique({ where: { taskExecutionId: 'exec-t2' } });
    expect(summed!.totalSelectors).toBeGreaterThanOrEqual(2);
    expect(summed!.passedSelectors).toBeGreaterThanOrEqual(1);
    expect(summed!.failedSelectors).toBeGreaterThanOrEqual(1);
    expect(['degraded', 'failed']).toContain(summed!.overallHealth);
    await prisma.maintenanceSelectorRecord.deleteMany({ where: { step: { executionId: exec.id } } });
    await prisma.maintenanceStep.deleteMany({ where: { executionId: exec.id } });
    await prisma.maintenanceExecution.delete({ where: { id: exec.id } });
    await prisma.taskExecution.delete({ where: { id: 'exec-t2' } });
  });

  it('summarizeExecution is idempotent (no duplicate steps on re-summarize)', async () => {
    await prisma.taskExecution.create({
      data: { id: 'exec-t3', taskId: 'job-t3', taskType: 'monitor', platform: 'douyin', windowId: 'w1' },
    });
    const exec = await prisma.maintenanceExecution.create({
      data: { taskExecutionId: 'exec-t3', platform: 'douyin', flowType: 'monitor', windowId: 'w1' },
    });
    await ingest(collector, [ev({ context: { ...ev().context, taskExecutionId: 'exec-t3' } })]);
    await collector.summarizeExecution('exec-t3');
    await collector.summarizeExecution('exec-t3');
    const steps = await prisma.maintenanceStep.findMany({ where: { executionId: exec.id } });
    const keys = steps.map((s: { phase: string; stepName: string }) => `${s.phase}/${s.stepName}`);
    expect(new Set(keys).size).toBe(keys.length);
    await prisma.maintenanceSelectorRecord.deleteMany({ where: { step: { executionId: exec.id } } });
    await prisma.maintenanceStep.deleteMany({ where: { executionId: exec.id } });
    await prisma.maintenanceExecution.delete({ where: { id: exec.id } });
    await prisma.taskExecution.delete({ where: { id: 'exec-t3' } });
  });
});
