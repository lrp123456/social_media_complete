import { ConfigSnapshotService } from './configSnapshotService';
import { prisma } from '../lib/prisma';

describe('ConfigSnapshotService', () => {
  let svc: ConfigSnapshotService;
  beforeEach(() => { svc = new ConfigSnapshotService(); });
  afterEach(async () => {
    await prisma.configSnapshot.deleteMany({});
  });
  afterAll(async () => await prisma.$disconnect());

  it('createSnapshot stores config and marks active', async () => {
    const snap = await svc.createSnapshot({
      platform: 'douyin', configType: 'selectors',
      snapshotName: 'baseline', configData: '{"v":1}', createdBy: 'tester',
    });
    expect(snap.isActive).toBe(true);
    expect(snap.version).toBe(1);
  });

  it('creating a new active snapshot deactivates previous active', async () => {
    await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'a', configData: '{}', createdBy: 't' });
    const second = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'b', configData: '{}', createdBy: 't' });
    const actives = await prisma.configSnapshot.findMany({ where: { platform: 'douyin', configType: 'selectors', isActive: true } });
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(second.id);
  });

  it('rollback creates a new version copying target configData', async () => {
    const v1 = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v1', configData: '{"x":1}', createdBy: 't' });
    const v2 = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v2', configData: '{"x":2}', createdBy: 't' });
    const rolled = await svc.rollback({ platform: 'douyin', configType: 'selectors', snapshotId: v1.id, currentVersion: v2.version });
    expect(rolled.configData).toBe('{"x":1}');
    expect(rolled.version).toBe(v2.version + 1);
    expect(rolled.isActive).toBe(true);
  });

  it('rollback throws ConflictError when currentVersion stale', async () => {
    const v1 = await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'v1', configData: '{}', createdBy: 't' });
    await expect(
      svc.rollback({ platform: 'douyin', configType: 'selectors', snapshotId: v1.id, currentVersion: 999 }),
    ).rejects.toThrow(/已被其他人修改|Conflict/);
  });

  it('export returns active config as JSON object', async () => {
    await svc.createSnapshot({ platform: 'douyin', configType: 'selectors', snapshotName: 'e', configData: '{"k":"v"}', createdBy: 't' });
    const exported = await svc.exportConfig('douyin', 'selectors');
    expect(exported).toEqual({ k: 'v' });
  });

  it('import validates JSON and creates snapshot', async () => {
    const snap = await svc.importConfig({ platform: 'douyin', configType: 'selectors', configData: { a: 1 }, snapshotName: 'imp', createdBy: 't' });
    expect(snap.configData).toBe(JSON.stringify({ a: 1 }));
    await expect(svc.importConfig({ platform: 'douyin', configType: 'selectors', configData: undefined as any, snapshotName: 'bad', createdBy: 't' }))
      .rejects.toThrow(/invalid|格式/);
  });
});
