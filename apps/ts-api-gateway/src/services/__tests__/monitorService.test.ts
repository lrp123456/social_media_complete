jest.mock('@social-media/shared-config', () => ({
  isProduction: jest.fn().mockReturnValue(false),
  isDevelopment: jest.fn().mockReturnValue(false),
  getConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  loadConfig: jest.fn().mockReturnValue({ NODE_ENV: 'test' }),
  PlatformName: 'douyin',
}));
jest.mock('../../lib/antiDetectionMode', () => ({
  isAntiDetectionV2: jest.fn().mockReturnValue(false),
  isEnabled: jest.fn().mockReturnValue(false),
}));
const getBrowserMock = jest.fn();
const redisMock = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
jest.mock('@social-media/browser-core', () => ({
  HumanActions: { wait: jest.fn().mockResolvedValue(undefined), cdpIsElementVisible: jest.fn().mockResolvedValue(false), cdpClick: jest.fn() },
  rootLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
  LoginTabRegistry: jest.fn(), RequestInterceptor: jest.fn(), BrowserManager: jest.fn(),
  ExitStrategy: { getQuerySource: jest.fn(), getNextPageAction: jest.fn() },
  PageType: 'unknown', SelectorReader: jest.fn(), MaintenanceProbe: { getInstance: jest.fn() },
}));
jest.mock('../../lib/browserManager', () => ({ getBrowserManager: () => ({ getBrowser: getBrowserMock }) }));
jest.mock('../loginFlowHelpers', () => ({
  loginTabRegistry: { find: jest.fn(), openLoginTab: jest.fn(), captureQR: jest.fn().mockResolvedValue(null) },
  getLoginFlowConfig: jest.fn().mockReturnValue({ loginUrl: 'https://example.com/login', domain: 'example.com' }),
  ensureLoginTab: jest.fn().mockResolvedValue(null),
}));
jest.mock('../wechatBotService', () => ({ botManager: { sendLoginAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../lib/logger', () => ({ createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }) }));
jest.mock('../../lib/oss', () => ({ uploadBufferToOSS: jest.fn().mockResolvedValue('https://oss.example.com/qr.png'), OSS_DIRS: { QR_CODE: 'qr' } }));
const prismaMock = { platformAccount: { findUnique: jest.fn().mockResolvedValue({ wechatUserid: 'wx1', windowId: 4, window: { externalId: '68a259626bb2c5905ffed8116e9a2a04' } }) } };
jest.mock('../../lib/prisma', () => ({ prisma: prismaMock }));
jest.mock('../../lib/redis', () => ({ getRedis: () => redisMock }));
jest.mock('../unifiedQueue', () => ({
  getWindowQueue: jest.fn(),
}));
jest.mock('../../crawlers/tencentCrawler', () => {
  const mockTcInstance = { handleLogin: jest.fn().mockResolvedValue(true) };
  return { TencentCrawler: jest.fn().mockImplementation(() => mockTcInstance), TencentReplyTarget: jest.fn() };
});
jest.mock('../../crawlers/douyinCrawler', () => {
  const mockDyInstance = { registerListener: jest.fn().mockResolvedValue(undefined), navigateToCreatorHome: jest.fn().mockResolvedValue(undefined) };
  return { DouyinCrawler: jest.fn().mockImplementation(() => mockDyInstance), ReplyTarget: jest.fn() };
});
jest.mock('../../crawlers/kuaishouCrawler', () => {
  const mockKsInstance = { registerListener: jest.fn().mockResolvedValue(undefined), navigateToHome: jest.fn().mockResolvedValue(undefined), detectKuaishouLogin: jest.fn().mockResolvedValue(true) };
  return { KuaishouCrawler: jest.fn().mockImplementation(() => mockKsInstance) };
});
jest.mock('../monitorDatabaseService', () => ({
  getCrawlMode: jest.fn().mockResolvedValue('full'),
  updateUserStatus: jest.fn(),
  logRiskScene: jest.fn(),
}));
jest.mock('../../routes/config-automation', () => ({
  getCrawlConfig: jest.fn().mockResolvedValue({ mode: 'full', maxRootComments: 10 }),
}));
const mockPage = { url: jest.fn().mockReturnValue('https://example.com/some-page') };

it('dummy', () => { expect(1).toBe(1); });

describe('triggerLoginProbe force', () => {
  let triggerLoginProbe: (userId: number, platform: string, windowId: string, flowId?: string, force?: boolean) => Promise<{ probed: true } | { probed: false; reason: 'monitor_active' }>;

  beforeAll(() => {
    triggerLoginProbe = require('../monitorService').triggerLoginProbe;
  });

  beforeEach(() => {
    redisMock.get.mockResolvedValue(JSON.stringify({
      status: 'login_required',
      cooldownLevel: 1,
      cooldownUntil: Date.now() + 999999,
      lastProbeAt: 0,
    }));
    getBrowserMock.mockResolvedValue(null);
  });

  it('skips cooldown gate when force=true', async () => {
    getBrowserMock.mockClear();
    await triggerLoginProbe(13, 'tencent', '68a259626bb2c5905ffed8116e9a2a04', 'creator', true);
    // 等待 setTimeout(..., 100) 触发
    await new Promise(r => setTimeout(r, 200));
    expect(getBrowserMock).toHaveBeenCalled();
  });

  it('respects cooldown gate when force=false', async () => {
    getBrowserMock.mockClear();
    await triggerLoginProbe(14, 'tencent', '68a259626bb2c5905ffed8116e9a2a04', 'creator', false);
    // cooldown 跳过，不进入 setTimeout，因此 getBrowser 不会被调用
    expect(getBrowserMock).not.toHaveBeenCalled();
  });
});

describe('triggerLoginProbe monitor_active guard', () => {
  it('should return monitor_active without probing when same window+platform monitor is active', async () => {
    const activeJob = { data: { userId: 13, platform: 'tencent', windowId: 'w4' }, isActive: () => Promise.resolve(true), isWaiting: () => Promise.resolve(false) };
    const { getWindowQueue } = require('../unifiedQueue');
    getWindowQueue.mockResolvedValue({ getJobs: () => Promise.resolve([activeJob]) });

    const { triggerLoginProbe } = require('../monitorService');
    const result = await triggerLoginProbe(13, 'tencent', 'w4', undefined, true);
    expect(result).toEqual({ probed: false, reason: 'monitor_active' });
  });
});

describe('Phase1 wrong-page fast-fail', () => {
  it('should fast-fail tencent Phase1 when page is on comment page', async () => {
    const page = { url: () => 'https://channels.weixin.qq.com/platform/comment/123' };
    const task = { userId: 13, windowId: 'w4', platform: 'tencent' } as any;
    const { runTencentCheck } = require('../monitorService');
    const result = await runTencentCheck(page, task, undefined);
    expect(result.phase).toBe('Phase1');
    expect(result.hasUpdate).toBe(false);
  });

  it('should fast-fail douyin Phase1 when page is on non-creator-micro page', async () => {
    const page = { url: () => 'https://www.douyin.com/foryou' };
    const task = { userId: 13, windowId: 'w4', platform: 'douyin' } as any;
    const { runDouyinCheck } = require('../monitorService');
    const result = await runDouyinCheck(page, task, undefined);
    expect(result.phase).toBe('Phase1');
    expect(result.hasUpdate).toBe(false);
  });

  it('should fast-fail kuaishou Phase1 when page is on non-video-manage page', async () => {
    const page = { url: () => 'https://cp.kuaishou.com/article/publish/photo' };
    const task = { userId: 13, windowId: 'w4', platform: 'kuaishou' } as any;
    const { runKuaishouCheck } = require('../monitorService');
    const result = await runKuaishouCheck(page, task, undefined);
    expect(result.phase).toBe('Phase1');
    expect(result.hasUpdate).toBe(false);
  });
});
