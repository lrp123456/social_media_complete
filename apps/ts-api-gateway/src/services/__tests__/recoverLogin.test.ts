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

// Mock prisma — recoverLogin dynamically imports it
const mockPrismaUpdate = jest.fn();
jest.mock('../../lib/prisma', () => ({
  prisma: { platformAccount: { update: mockPrismaUpdate } },
}));

// Mock loginFlowHelpers — recoverLogin dynamically imports it
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

import { recoverLogin } from '../monitorService';

describe('recoverLogin (前端恢复登录按钮)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('置 status=active + cooldownUntil=0 + 清 flowState + 启动倒计时', async () => {
    const result = await recoverLogin(11, 'kuaishou', 'win-1');

    // 1) prisma update with correct id + status + cooldown
    expect(mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'active', cooldownUntil: BigInt(0) },
    });

    // 2) 清该平台所有 flowState
    expect(mockRedisDel).toHaveBeenCalledWith('login_flow_state:11:creator');

    // 3) 返回文案（启动倒计时由 resetSchedulerTimer 内部处理，副作用不验证）
    expect(result).toEqual({ message: '已置为已登录并启动监控' });
  });

  it('平台为 tencent → 仍然清该平台 flowState（getFlowIdsForPlatform 由 mock 决定）', async () => {
    mockGetFlowIds.mockReturnValueOnce(['creator', 'helper']);
    await recoverLogin(22, 'tencent', 'win-2');

    expect(mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: 22 },
      data: { status: 'active', cooldownUntil: BigInt(0) },
    });
    expect(mockRedisDel).toHaveBeenCalledWith('login_flow_state:22:creator');
    expect(mockRedisDel).toHaveBeenCalledWith('login_flow_state:22:helper');
  });
});
