import express from 'express';
import request from 'supertest';
import { prisma } from '../lib/prisma';

// Mock 所有外部依赖
jest.mock('../lib/prisma', () => ({
  prisma: {
    maintenanceExecution: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    maintenanceStep: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    maintenanceSelectorRecord: {
      groupBy: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    maintenanceUrlRecord: {
      findMany: jest.fn(),
    },
    debugSnapshot: {
      findMany: jest.fn(),
    },
    configSnapshot: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    customSelector: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    platformConfig: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import maintenanceRouter from './maintenance';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/maintenance', maintenanceRouter);
  return app;
}

const mockPrisma = prisma as any;

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================
// Task 12: 执行健康 + 选择器 + 快照
// ============================================================

describe('GET /api/v1/maintenance/executions', () => {
  it('返回执行列表 + 分页', async () => {
    mockPrisma.maintenanceExecution.count.mockResolvedValue(2);
    mockPrisma.maintenanceExecution.findMany.mockResolvedValue([
      { id: 'e1', platform: 'douyin', flowType: 'monitor', overallHealth: 'healthy', startedAt: new Date() },
      { id: 'e2', platform: 'kuaishou', flowType: 'publish', overallHealth: 'degraded', startedAt: new Date() },
    ]);

    const res = await request(createApp()).get('/api/v1/maintenance/executions?page=1&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toEqual({ page: 1, limit: 10, total: 2, totalPages: 1 });
  });

  it('支持筛选 platform / healthStatus / flowType', async () => {
    mockPrisma.maintenanceExecution.count.mockResolvedValue(1);
    mockPrisma.maintenanceExecution.findMany.mockResolvedValue([
      { id: 'e1', platform: 'douyin', flowType: 'monitor', overallHealth: 'healthy' },
    ]);

    const res = await request(createApp())
      .get('/api/v1/maintenance/executions')
      .query({ platform: 'douyin', healthStatus: 'healthy', flowType: 'monitor' });

    expect(res.status).toBe(200);
    expect(mockPrisma.maintenanceExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ platform: 'douyin', overallHealth: 'healthy', flowType: 'monitor' }),
      }),
    );
  });

  it('返回 400 当参数无效时', async () => {
    const res = await request(createApp()).get('/api/v1/maintenance/executions?page=-1');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/maintenance/executions/:id', () => {
  it('返回执行详情 + steps', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue({
      id: 'e1',
      platform: 'douyin',
      flowType: 'monitor',
      overallHealth: 'healthy',
      steps: [
        { id: 's1', phase: 'login', stepName: '登录', healthStatus: 'healthy' },
      ],
    });

    const res = await request(createApp()).get('/api/v1/maintenance/executions/e1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('e1');
    expect(res.body.data.steps).toHaveLength(1);
  });

  it('返回 404 当执行记录不存在', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/maintenance/executions/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/maintenance/executions/:id/steps', () => {
  it('返回步骤详情 + selectorRecords + urlRecords + snapshots', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue({ id: 'e1' });
    mockPrisma.maintenanceStep.findMany.mockResolvedValue([
      {
        id: 's1',
        phase: 'upload',
        stepName: '上传视频',
        healthStatus: 'healthy',
        selectorRecords: [{ id: 'sr1', selectorKey: 'btn_submit', result: 'found' }],
        urlRecords: [{ id: 'ur1', urlPattern: '/api/upload', result: 'matched' }],
        snapshots: [{ id: 'ds1', snapshotType: 'dom', contentSize: 1024 }],
      },
    ]);

    const res = await request(createApp()).get('/api/v1/maintenance/executions/e1/steps');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0].selectorRecords).toHaveLength(1);
    expect(res.body.data[0].urlRecords).toHaveLength(1);
    expect(res.body.data[0].snapshots).toHaveLength(1);
  });

  it('返回 404 当执行记录不存在', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/maintenance/executions/nonexistent/steps');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/maintenance/selectors/health', () => {
  it('返回聚合的选择器健康数据', async () => {
    mockPrisma.maintenanceSelectorRecord.groupBy.mockResolvedValue([
      { selectorKey: 'btn_submit', _count: { id: 10 }, _min: { durationMs: 50 }, _max: { durationMs: 500 }, _avg: { durationMs: 200 } },
      { selectorKey: 'menu_home', _count: { id: 5 }, _min: { durationMs: 30 }, _max: { durationMs: 300 }, _avg: { durationMs: 100 } },
    ]);

    // Mock success/degraded counts
    mockPrisma.maintenanceSelectorRecord.count.mockImplementation(
      ({ where: { selectorKey, result, selectorSource } }: any) => {
        // btn_submit: success=8, degraded=1, primary_source=7
        if (selectorKey === 'btn_submit') {
          if (result === 'found') return 8;
          if (result?.in) return 1;
          if (selectorSource?.in) return 7;
        }
        // menu_home: success=3, degraded=1, primary_source=4
        if (selectorKey === 'menu_home') {
          if (result === 'found') return 3;
          if (result?.in) return 1;
          if (selectorSource?.in) return 4;
        }
        return 0;
      },
    );

    const res = await request(createApp()).get('/api/v1/maintenance/selectors/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].selectorKey).toBe('btn_submit');
    expect(res.body.data[0].successRate).toBe(80);
    expect(res.body.data[0].primaryRate).toBe(70);
  });
});

describe('GET /api/v1/maintenance/selectors/:key/history', () => {
  it('返回选择器历史趋势（按天聚合）', async () => {
    const now = new Date();
    mockPrisma.maintenanceSelectorRecord.findMany.mockResolvedValue([
      { id: 'r1', selectorKey: 'btn_submit', result: 'found', createdAt: new Date(now.getTime() - 86400000) },
      { id: 'r2', selectorKey: 'btn_submit', result: 'found', createdAt: now },
      { id: 'r3', selectorKey: 'btn_submit', result: 'not_found', createdAt: now },
    ]);

    const res = await request(createApp()).get('/api/v1/maintenance/selectors/btn_submit/history?days=7');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.selectorKey).toBe('btn_submit');
    expect(res.body.data.recent).toHaveLength(3);
    expect(res.body.data.daily.length).toBeGreaterThan(0);
  });
});

describe('GET /api/v1/maintenance/snapshots/:stepId', () => {
  it('返回步骤的 debug 快照', async () => {
    mockPrisma.maintenanceStep.findUnique.mockResolvedValue({ id: 's1' });
    mockPrisma.debugSnapshot.findMany.mockResolvedValue([
      { id: 'ds1', stepId: 's1', snapshotType: 'dom', content: '<html/>', contentSize: 50 },
    ]);

    const res = await request(createApp()).get('/api/v1/maintenance/snapshots/s1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  it('返回 404 当步骤不存在', async () => {
    mockPrisma.maintenanceStep.findUnique.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/maintenance/snapshots/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Task 13: 配置管理
// ============================================================

describe('POST /api/v1/maintenance/config/snapshots', () => {
  it('创建配置快照成功', async () => {
    mockPrisma.configSnapshot.create.mockResolvedValue({
      id: 'snap-1',
      snapshotName: '备份-20240101',
      platform: 'douyin',
      configType: 'selectors',
      configData: '{}',
      version: 1,
      createdAt: new Date(),
    });

    const res = await request(createApp())
      .post('/api/v1/maintenance/config/snapshots')
      .send({
        snapshotName: '备份-20240101',
        platform: 'douyin',
        configType: 'selectors',
        configData: '{"key": "value"}',
        description: '日常备份',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('snap-1');
  });

  it('返回 400 当缺少必填字段', async () => {
    const res = await request(createApp())
      .post('/api/v1/maintenance/config/snapshots')
      .send({ snapshotName: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/maintenance/config/snapshots', () => {
  it('返回快照列表', async () => {
    mockPrisma.configSnapshot.count.mockResolvedValue(2);
    mockPrisma.configSnapshot.findMany.mockResolvedValue([
      { id: 's1', snapshotName: 'snap1', platform: 'douyin', configType: 'selectors', version: 1 },
      { id: 's2', snapshotName: 'snap2', platform: 'douyin', configType: 'url_monitors', version: 1 },
    ]);

    const res = await request(createApp()).get('/api/v1/maintenance/config/snapshots');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });
});

describe('POST /api/v1/maintenance/config/snapshots/:id/rollback', () => {
  it('CAS 回滚版本匹配成功', async () => {
    mockPrisma.configSnapshot.findUnique.mockResolvedValue({
      id: 'snap-1',
      snapshotName: 'backup',
      platform: 'douyin',
      configType: 'selectors',
      configData: JSON.stringify([{ selectorKey: 'btn_submit', selectorValue: { css: '#btn' }, description: '' }]),
      version: 1,
      isActive: false,
    });

    // 模拟回滚操作中的查询
    mockPrisma.customSelector.findUnique.mockResolvedValue(null);

    mockPrisma.configSnapshot.update.mockResolvedValue({
      id: 'snap-1',
      version: 2,
      isActive: true,
    });

    const res = await request(createApp())
      .post('/api/v1/maintenance/config/snapshots/snap-1/rollback')
      .send({ expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(2);
  });

  it('stale version 返回 409', async () => {
    mockPrisma.configSnapshot.findUnique.mockResolvedValue({
      id: 'snap-1',
      platform: 'douyin',
      configType: 'selectors',
      configData: '[]',
      version: 2,
    });

    const res = await request(createApp())
      .post('/api/v1/maintenance/config/snapshots/snap-1/rollback')
      .send({ expectedVersion: 1 });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.currentVersion).toBe(2);
  });
});

describe('POST /api/v1/maintenance/config/export', () => {
  it('导出活跃配置', async () => {
    mockPrisma.customSelector.findMany.mockResolvedValue([
      { platform: 'douyin', selectorKey: 'btn_submit', selectorValue: '{"css":"#btn"}', description: '', enabled: true },
    ]);
    mockPrisma.platformConfig.findMany.mockResolvedValue([
      { platform: 'douyin', configKey: 'api_url', configValue: 'https://example.com', description: '', enabled: true },
    ]);
    mockPrisma.configSnapshot.findMany.mockResolvedValue([
      { id: 'fr1', snapshotName: 'flow-v1', platform: 'douyin', version: 1 },
    ]);
    mockPrisma.configSnapshot.findFirst
      .mockResolvedValueOnce({ id: 'sel-snap', snapshotName: 'sel-v1', version: 2 })
      .mockResolvedValueOnce(null);

    const res = await request(createApp()).post('/api/v1/maintenance/config/export');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customSelectors).toHaveLength(1);
    expect(res.body.data.activeSnapshots.selectors.id).toBe('sel-snap');
  });
});

describe('POST /api/v1/maintenance/config/import', () => {
  it('导入配置成功', async () => {
    mockPrisma.customSelector.findUnique.mockResolvedValue(null);
    mockPrisma.platformConfig.findUnique.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/maintenance/config/import')
      .send({
        customSelectors: [
          { platform: 'douyin', selectorKey: 'btn_submit', selectorValue: { css: '#btn' } },
        ],
        platformConfigs: [
          { platform: 'douyin', configKey: 'api_key', configValue: 'abc123' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customSelectors).toBe(1);
    expect(res.body.data.platformConfigs).toBe(1);
  });
});

// ============================================================
// Task 14: 验证 & 重试
// ============================================================

describe('POST /api/v1/maintenance/verify/selector', () => {
  it('参数校验通过（浏览器验证不可用时返回 registry 检查结果）', async () => {
    const res = await request(createApp())
      .post('/api/v1/maintenance/verify/selector')
      .send({ windowId: 'win-1', selectorKey: 'btn_submit', platform: 'douyin' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.windowId).toBe('win-1');
    expect(res.body.data.selectorKey).toBe('btn_submit');
  });

  it('返回 400 当缺少必填字段', async () => {
    const res = await request(createApp())
      .post('/api/v1/maintenance/verify/selector')
      .send({ windowId: 'win-1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/maintenance/verify/url', () => {
  it('URL 通配符匹配成功', async () => {
    const res = await request(createApp())
      .post('/api/v1/maintenance/verify/url')
      .send({ urlPattern: '/api/v1/users/*', actualUrl: '/api/v1/users/123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isMatch).toBe(true);
  });

  it('URL 不匹配', async () => {
    const res = await request(createApp())
      .post('/api/v1/maintenance/verify/url')
      .send({ urlPattern: '/api/v1/posts/*', actualUrl: '/api/v1/users/123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isMatch).toBe(false);
  });

  it('返回 400 当缺少参数', async () => {
    const res = await request(createApp())
      .post('/api/v1/maintenance/verify/url')
      .send({ urlPattern: '/test' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/maintenance/retry/step', () => {
  it('参数校验通过', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue({ id: 'exec-1' });
    mockPrisma.maintenanceStep.findUnique.mockResolvedValue({
      id: 'step-1',
      executionId: 'exec-1',
      stepName: '登录',
      healthStatus: 'failed',
    });

    const res = await request(createApp())
      .post('/api/v1/maintenance/retry/step')
      .send({ stepId: 'step-1', executionId: 'exec-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.stepName).toBe('登录');
  });

  it('返回 404 当执行记录不存在', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/maintenance/retry/step')
      .send({ stepId: 'step-1', executionId: 'nonexistent' });

    expect(res.status).toBe(404);
  });

  it('返回 404 当步骤不存在', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue({ id: 'exec-1' });
    mockPrisma.maintenanceStep.findUnique.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/maintenance/retry/step')
      .send({ stepId: 'nonexistent', executionId: 'exec-1' });

    expect(res.status).toBe(404);
  });

  it('返回 400 当步骤不属于该执行', async () => {
    mockPrisma.maintenanceExecution.findUnique.mockResolvedValue({ id: 'exec-1' });
    mockPrisma.maintenanceStep.findUnique.mockResolvedValue({
      id: 'step-1',
      executionId: 'exec-2',
      stepName: '登录',
      healthStatus: 'failed',
    });

    const res = await request(createApp())
      .post('/api/v1/maintenance/retry/step')
      .send({ stepId: 'step-1', executionId: 'exec-1' });

    expect(res.status).toBe(400);
  });

  it('返回 400 当缺少必填参数', async () => {
    const res = await request(createApp())
      .post('/api/v1/maintenance/retry/step')
      .send({ stepId: 'step-1' });

    expect(res.status).toBe(400);
  });
});
