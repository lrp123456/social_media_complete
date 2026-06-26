import { prisma } from '../lib/prisma';

describe('maintenance tables smoke', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('can query all 6 new tables without error', async () => {
    await expect(prisma.maintenanceExecution.findMany()).resolves.toEqual([]);
    await expect(prisma.maintenanceStep.findMany()).resolves.toEqual([]);
    await expect(prisma.maintenanceSelectorRecord.findMany()).resolves.toEqual([]);
    await expect(prisma.maintenanceUrlRecord.findMany()).resolves.toEqual([]);
    await expect(prisma.debugSnapshot.findMany()).resolves.toEqual([]);
    await expect(prisma.configSnapshot.findMany()).resolves.toEqual([]);
  });
});
