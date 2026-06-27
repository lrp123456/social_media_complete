import { executeMonitorCheck } from '../monitorService';

// Mock root cause: isProduction() in logger needs config validation,
// and several modules call config validation at module load time.
jest.mock('@social-media/shared-config', () => ({
  isProduction: () => false,
  loadConfig: () => ({}),
  getConfig: () => ({}),
  PlatformName: {},
}));

jest.mock('../../lib/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../lib/browserManager', () => ({
  getBrowserManager: () => ({
    connect: jest.fn().mockRejectedValue(new Error('CDP connection refused')),
    disconnectSession: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../wechatBotService', () => ({
  botManager: {},
}));

jest.mock('../../lib/prisma', () => ({ prisma: {} }));

describe('executeMonitorCheck connect failure', () => {
  it('throws on connect failure instead of returning empty result', async () => {
    const task = { userId: 1, platform: 'douyin' as const, windowId: 'fp_test', taskId: 'mon_test' };
    await expect(executeMonitorCheck(task)).rejects.toThrow('连接指纹浏览器失败');
  });
});
