import { MaintenanceProbe } from '@social-media/browser-core';

// mock getRedis to avoid @social-media/shared-config dependency in test env
jest.mock('../lib/redis', () => ({
  getRedis: () => ({
    lpush: jest.fn().mockResolvedValue(1),
  }),
}));

import { bootstrapProbe, teardownProbe } from './probeBootstrap';

describe('probe bootstrap', () => {
  afterEach(() => MaintenanceProbe.reset());

  it('setEnabled(true) and wires redis pusher when debug mode', async () => {
    await bootstrapProbe({ isDebugMode: true });
    expect(MaintenanceProbe.isEnabled()).toBe(true);
  });

  it('setEnabled(false) when not debug mode', async () => {
    await bootstrapProbe({ isDebugMode: false });
    expect(MaintenanceProbe.isEnabled()).toBe(false);
  });

  it('teardownProbe flushes and disables', async () => {
    await bootstrapProbe({ isDebugMode: true });
    await teardownProbe();
    expect(MaintenanceProbe.isEnabled()).toBe(false);
  });
});
