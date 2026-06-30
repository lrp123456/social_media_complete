import { describe, it, expect, jest } from '@jest/globals';

// === Top-level mocks (monitorService module-level deps) ===

jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'douyin',
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

// Mock prisma — markLoginRecovered dynamically imports it
const mockPrismaUpdate = jest.fn();
jest.mock('../../lib/prisma', () => ({
  prisma: { platformAccount: { update: mockPrismaUpdate } },
}));

// Mock loginFlowHelpers — markLoginRecovered dynamically imports it
const mockGetFlowIds = jest.fn().mockReturnValue(['creator']);
jest.mock('../loginFlowHelpers', () => ({
  getFlowIdsForPlatform: mockGetFlowIds,
}));

// Mock redis — monitorService top-level import, needed by delFlowState (same module)
const mockRedisDel = jest.fn();
jest.mock('../../lib/redis', () => ({
  getRedis: () => ({ del: mockRedisDel, get: jest.fn(), set: jest.fn() }),
}));

// Mock wechatBotService — prevents oss.ts client init during module loading
jest.mock('../wechatBotService', () => ({
  botManager: { sendLoginAlert: jest.fn() },
}));

import { markLoginRecovered } from '../monitorService';

describe('markLoginRecovered (B1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('重置 status=active + cooldownUntil=0 + 清该平台所有 flowState', async () => {
    await markLoginRecovered(11, 'tencent');

    // 1) prisma update with correct id + status + cooldown
    expect(mockPrismaUpdate).toHaveBeenCalledTimes(1);
    expect(mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'active', cooldownUntil: BigInt(0) },
    });

    // 2) getFlowIdsForPlatform called with correct platform
    expect(mockGetFlowIds).toHaveBeenCalledWith('tencent');

    // 3) delFlowState called for each flow id
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith('login_flow_state:11:creator');
  });
});
