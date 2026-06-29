import express from 'express';
import request from 'supertest';
import { prisma } from '../lib/prisma';

// Mock 所有外部依赖
jest.mock('../lib/prisma', () => ({
  prisma: {
    hotVideoCandidate: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../services/materialUpdateConfig', () => ({
  getMaterialUpdateConfig: jest.fn(() => ({
    platforms: [],
    schedule: { cron: [], enabled: false },
    processing: { frameIntervalMs: 1000, evaluatePrompt: '', styles: [], minRating: 3 },
    storage: { enabled: false, rootPath: '' },
    keyCooldownState: {},
    allCooldownRetryAfterMs: 60000,
  })),
}));

jest.mock('../services/materialUpdateService', () => ({
  runMaterialUpdate: jest.fn(),
  isRunning: jest.fn(() => false),
  getRunState: jest.fn(() => ({ running: false, lastRunAt: null, lastResult: {}, runHealth: 'ok', warnings: [] })),
}));

jest.mock('../services/materialUpdateService', () => ({
  runMaterialUpdate: jest.fn(),
  isRunning: jest.fn(() => false),
  getRunState: jest.fn(() => ({ running: false, lastRunAt: null, lastResult: {}, runHealth: 'ok', warnings: [] })),
}));

import { materialUpdateRouter } from './material-update';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/material-update', materialUpdateRouter);
  return app;
}

const mockPrisma = prisma as any;

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================
// Task 1: GET /api/v1/material-update/candidates
// ============================================================

describe('GET /api/v1/material-update/candidates', () => {
  it('返回候选列表 + 分页', async () => {
    mockPrisma.hotVideoCandidate.count.mockResolvedValue(2);
    mockPrisma.hotVideoCandidate.findMany.mockResolvedValue([
      { id: 'c1', platform: 'douyin', videoId: 'v1', status: 'pending', playCount: 1000n },
      { id: 'c2', platform: 'xiaohongshu', videoId: 'v2', status: 'accepted', playCount: null },
    ]);

    const res = await request(createApp()).get('/api/v1/material-update/candidates?page=1&pageSize=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.page).toBe(1);
    // BigInt 序列化检查
    expect(res.body.data.items[0].playCount).toBe(1000);
    expect(res.body.data.items[1].playCount).toBeNull();
  });

  it('支持 platformId / status / style 筛选', async () => {
    mockPrisma.hotVideoCandidate.count.mockResolvedValue(1);
    mockPrisma.hotVideoCandidate.findMany.mockResolvedValue([
      { id: 'c1', platform: 'douyin', videoId: 'v1', status: 'accepted', style: '奶油风' },
    ]);

    const res = await request(createApp())
      .get('/api/v1/material-update/candidates')
      .query({ platformId: 'douyin', status: 'accepted', style: '奶油风' });

    expect(res.status).toBe(200);
    expect(mockPrisma.hotVideoCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ platform: 'douyin', status: 'accepted', style: '奶油风' }),
      }),
    );
  });

  it('返回 400 当参数无效', async () => {
    const res = await request(createApp()).get('/api/v1/material-update/candidates?page=abc');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ============================================================
// Task 2: POST /api/v1/material-update/reprocess/:id
// ============================================================

describe('POST /api/v1/material-update/reprocess/:id', () => {
  it('将 rejected 候选重置为 pending', async () => {
    mockPrisma.hotVideoCandidate.findUnique.mockResolvedValue({
      id: 'c1',
      platform: 'douyin',
      videoId: 'v1',
      status: 'rejected',
    });
    mockPrisma.hotVideoCandidate.update.mockResolvedValue({
      id: 'c1',
      status: 'pending',
      style: null,
      rating: null,
      storagePath: null,
      storageStatus: 'none',
      failReason: null,
    });

    const res = await request(createApp()).post('/api/v1/material-update/reprocess/c1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('pending');
    expect(mockPrisma.hotVideoCandidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1' },
        data: expect.objectContaining({ status: 'pending', style: null, rating: null }),
      }),
    );
  });

  it('将 no_url 候选重置为 pending', async () => {
    mockPrisma.hotVideoCandidate.findUnique.mockResolvedValue({
      id: 'c2',
      status: 'no_url',
    });
    mockPrisma.hotVideoCandidate.update.mockResolvedValue({
      id: 'c2',
      status: 'pending',
    });

    const res = await request(createApp()).post('/api/v1/material-update/reprocess/c2');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('返回 404 当候选不存在', async () => {
    mockPrisma.hotVideoCandidate.findUnique.mockResolvedValue(null);

    const res = await request(createApp()).post('/api/v1/material-update/reprocess/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('返回 409 当状态不是 rejected/no_url', async () => {
    mockPrisma.hotVideoCandidate.findUnique.mockResolvedValue({
      id: 'c3',
      status: 'pending',
    });

    const res = await request(createApp()).post('/api/v1/material-update/reprocess/c3');
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('pending');
  });
});
