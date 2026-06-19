// @ts-api-gateway/routes/operators.ts - 操作员与窗口管理 API
// 管理企业微信用户、指纹浏览器窗口绑定、平台登录验证

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { monitorQueue, resetSchedulerTimer } from '../services/monitorService';
import {
  syncWindows,
  syncAllWindows,
  openWindow,
  closeWindow,
  getWindowStatus,
  createWindow,
  getWindowDetail,
  checkPlatformLogin,
  registerBrowser,
  getAllProviders,
  getProvider,
  type BrowserVendor,
  type CreateWindowConfig,
} from '../services/browserApiService';

const router = Router();
const logger = createLogger('routes:operators');

// ============================================================
// 同步辅助：Operator → User（监控表）
// ============================================================

/**
 * 为操作员创建对应的监控 User 记录
 * 需要：操作员有绑定的窗口 + 已添加的平台
 */
async function syncOperatorToMonitorUser(operatorId: number): Promise<void> {
  try {
    // 获取操作员信息
    const operator = await prisma.operator.findUnique({
      where: { id: operatorId },
      include: {
        windows: { where: { status: 'bound' } },
        platforms: true,
      },
    });

    if (!operator) return;

    // 获取操作员绑定的窗口（取第一个）
    const boundWindow = operator.windows.find((w) => w.status === 'bound');
    if (!boundWindow) {
      // 没有绑定窗口，无法创建 User 记录
      return;
    }

    // 监控平台列表（只有这些平台需要创建 User 记录）
    const monitorPlatforms = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'];

    // 操作员当前拥有的监控平台集合
    const operatorMonitorPlatforms = new Set(
      operator.platforms
        .filter((p) => monitorPlatforms.includes(p.platform))
        .map((p) => p.platform),
    );

    // 清理孤儿 User 记录：该窗口下存在但操作员已不再拥有的平台
    const staleUsers = await prisma.user.findMany({
      where: {
        fingerprintWindowId: boundWindow.externalId,
        platform: { in: monitorPlatforms },
      },
      include: { videos: { select: { id: true } } },
    });

    for (const staleUser of staleUsers) {
      if (!operatorMonitorPlatforms.has(staleUser.platform)) {
        // ── 先清理无 FK 关联的子表（必须在 User 删除前执行）──
        const videoIds = staleUser.videos.map((v) => v.id);
        if (videoIds.length > 0) {
          await prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: videoIds } } });
          await prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: videoIds } } });
          await prisma.videoCommentCount.deleteMany({ where: { videoId: { in: videoIds } } });
        }
        await prisma.monitorStatus.deleteMany({ where: { accountId: String(staleUser.id) } });

        // User 删除 → 级联删除 Video → 级联删除 Comment
        await prisma.user.delete({ where: { id: staleUser.id } });
        logger.info({ operatorId, platform: staleUser.platform, windowId: boundWindow.externalId, userId: staleUser.id, cleanedVideoRecordCount: videoIds.length }, '已清理孤儿监控用户及其关联数据');

        // 移除 BullMQ 中该用户的待处理监控任务
        const staleJobs = await monitorQueue.getJobs(['waiting', 'delayed']);
        let removedJobs = 0;
        for (const job of staleJobs) {
          if (job.data.userId === staleUser.id) {
            await job.remove().catch(() => {});
            removedJobs++;
          }
        }
        if (removedJobs > 0) {
          logger.info({ operatorId, userId: staleUser.id, removedJobs }, '已清理 BullMQ 残留任务');
        }
      }
    }

    // 为每个已添加的监控平台创建 User 记录
    for (const plat of operator.platforms) {
      if (!monitorPlatforms.includes(plat.platform)) continue;

      // 检查是否已存在（基于 fingerprintWindowId + platform 唯一）
      const existing = await prisma.user.findUnique({
        where: {
          idx_users_window_platform: {
            fingerprintWindowId: boundWindow.externalId,
            platform: plat.platform,
          },
        },
      });

      if (!existing) {
        await prisma.user.create({
          data: {
            fingerprintWindowId: boundWindow.externalId,
            wechatUserid: operator.wechatUserId,
            platform: plat.platform,
            status: 'init',
            monitoringEnabled: true,
          },
        });
        logger.info({ operatorId, platform: plat.platform, windowId: boundWindow.externalId }, '已同步创建监控用户记录');
      }
    }
  } catch (err) {
    logger.error({ operatorId, err: (err as Error).message }, '同步操作员到监控用户失败');
  }
}

/**
 * 清理指定窗口的所有监控用户数据及关联
 * 用于删除操作员、解绑窗口时调用，避免 users 表孤儿数据
 */
async function cleanupWindowMonitorData(windowExternalId: string, reason: string): Promise<void> {
  const monitorPlatforms = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'];

  const users = await prisma.user.findMany({
    where: { fingerprintWindowId: windowExternalId, platform: { in: monitorPlatforms } },
    include: { videos: { select: { id: true } } },
  });

  for (const user of users) {
    const videoIds = user.videos.map((v) => v.id);
    if (videoIds.length > 0) {
      await prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: videoIds } } });
      await prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: videoIds } } });
      await prisma.videoCommentCount.deleteMany({ where: { videoId: { in: videoIds } } });
    }
    await prisma.monitorStatus.deleteMany({ where: { accountId: String(user.id) } });
    await prisma.user.delete({ where: { id: user.id } });

    // 清理 BullMQ 待处理任务
    const staleJobs = await monitorQueue.getJobs(['waiting', 'delayed']);
    for (const job of staleJobs) {
      if ((job.data as any).userId === user.id) {
        await job.remove().catch(() => {});
      }
    }

    logger.info(
      { windowExternalId, userId: user.id, platform: user.platform, reason, cleanedVideos: videoIds.length },
      '已清理窗口监控用户数据及关联',
    );
  }
}

// ============================================================
// 窗口数量限制
// ============================================================
const VENDOR_WINDOW_LIMITS: Record<BrowserVendor, number> = {
  bitbrowser: 10,
  roxybrowser: 5,
};
const TOTAL_WINDOW_LIMIT = 15;

// ============================================================
// 操作员 CRUD
// ============================================================

/** GET /api/v1/operators — 获取所有操作员列表 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const operators = await prisma.operator.findMany({
      include: {
        windows: { select: { id: true, externalId: true, browserVendor: true, windowName: true } },
        platforms: { select: { platform: true, loginStatus: true, lastVerifiedAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: operators });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取操作员列表失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/operators — 创建操作员 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      wechatUserId: z.string().min(1).max(64),
      displayName: z.string().min(1).max(64),
      phone: z.string().max(20).optional(),
      role: z.enum(['admin', 'operator']).default('operator'),
    });

    const data = schema.parse(req.body);

    const existing = await prisma.operator.findUnique({ where: { wechatUserId: data.wechatUserId } });
    if (existing) {
      return res.status(409).json({ success: false, error: '该企业微信用户ID已存在' });
    }

    const operator = await prisma.operator.create({ data });

    await prisma.operationLog.create({
      data: {
        action: 'operator_create',
        details: JSON.stringify({ operatorId: operator.id, wechatUserId: data.wechatUserId }),
        userId: 'system',
        userName: 'Operator API',
        result: 'success',
        level: 'info',
      },
    });

    res.status(201).json({ success: true, data: operator });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '创建操作员失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** PUT /api/v1/operators/:id — 更新操作员 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const bodySchema = z.object({
      displayName: z.string().min(1).max(64).optional(),
      phone: z.string().max(20).optional(),
      role: z.enum(['admin', 'operator']).optional(),
      enabled: z.boolean().optional(),
    });

    const { id } = paramsSchema.parse(req.params);
    const data = bodySchema.parse(req.body);

    const operator = await prisma.operator.update({ where: { id }, data });
    res.json({ success: true, data: operator });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '更新操作员失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** DELETE /api/v1/operators/:id — 删除操作员 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);

    // 获取操作员绑定的窗口（在解绑前，用于清理监控数据）
    const operator = await prisma.operator.findUnique({
      where: { id },
      include: { windows: true },
    });
    if (!operator) {
      return res.status(404).json({ success: false, error: '操作员不存在' });
    }

    // 清理每个绑定窗口的监控用户数据及关联
    for (const window of operator.windows) {
      if (window.status === 'bound') {
        await cleanupWindowMonitorData(window.externalId, `operator ${id} deleted`);
      }
    }

    // 解绑所有窗口
    await prisma.browserWindow.updateMany({
      where: { boundOperatorId: id },
      data: { boundOperatorId: null, status: 'available' },
    });

    await prisma.operator.delete({ where: { id } });
    res.json({ success: true, id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '删除操作员失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 窗口管理
// ============================================================

/** POST /api/v1/operators/windows/sync — 从浏览器API同步窗口列表 */
router.post('/windows/sync', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      vendor: z.enum(['bitbrowser', 'roxybrowser']),
    });
    const { vendor } = schema.parse(req.body);

    // 1. 从浏览器API获取窗口列表
    let windows;
    try {
      windows = await syncWindows(vendor as BrowserVendor);
    } catch (syncErr) {
      logger.error({ err: (syncErr as Error).message }, '浏览器API调用失败');
      return res.status(502).json({ success: false, error: `浏览器API调用失败: ${(syncErr as Error).message}` });
    }

    // 2. 保存到数据库（如果数据库可用）
    let created = 0;
    let updated = 0;
    let dbError = false;

    try {
      for (const w of windows) {
        const existing = await prisma.browserWindow.findUnique({
          where: {
            idx_window_external_vendor: { externalId: w.id, browserVendor: w.vendor },
          },
        });

        if (existing) {
          await prisma.browserWindow.update({
            where: { id: existing.id },
            data: {
              windowName: w.name,
              workspaceId: w.workspaceId || null,
              rawConfig: w.raw ? JSON.stringify(w.raw) : null,
              syncedAt: new Date(),
            },
          });
          updated++;
        } else {
          await prisma.browserWindow.create({
            data: {
              externalId: w.id,
              browserVendor: w.vendor,
              windowName: w.name,
              workspaceId: w.workspaceId || null,
              rawConfig: w.raw ? JSON.stringify(w.raw) : null,
              status: 'available',
            },
          });
          created++;
        }
      }
    } catch (dbErr) {
      dbError = true;
      logger.warn({ err: (dbErr as Error).message }, '数据库不可用，仅返回内存数据');
    }

    logger.info(`窗口同步完成: ${vendor} — 新增 ${created}, 更新 ${updated}, 总计 ${windows.length}`);
    res.json({
      success: true,
      data: {
        created,
        updated,
        total: windows.length,
        windows: windows.map((w) => ({ id: w.id, name: w.name, vendor: w.vendor })),
        dbSaved: !dbError,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '窗口同步失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/operators/windows — 获取所有窗口列表 */
router.get('/windows', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      status: z.enum(['available', 'bound', 'error', 'all']).default('all'),
      vendor: z.enum(['bitbrowser', 'roxybrowser', 'all']).default('all'),
    });

    const { status, vendor } = schema.parse(req.query);

    const where: any = {};
    if (status !== 'all') where.status = status;
    if (vendor !== 'all') where.browserVendor = vendor;

    const windows = await prisma.browserWindow.findMany({
      where,
      include: {
        operator: { select: { id: true, wechatUserId: true, displayName: true } },
      },
      orderBy: { windowName: 'asc' },
    });

    // 计算每个供应商的窗口数量和限制
    const vendorCounts: Record<string, number> = {};
    for (const v of ['bitbrowser', 'roxybrowser'] as BrowserVendor[]) {
      vendorCounts[v] = await prisma.browserWindow.count({ where: { browserVendor: v } });
    }

    const limits = {
      bitbrowser: { current: vendorCounts.bitbrowser, max: VENDOR_WINDOW_LIMITS.bitbrowser },
      roxybrowser: { current: vendorCounts.roxybrowser, max: VENDOR_WINDOW_LIMITS.roxybrowser },
      total: { current: windows.length, max: TOTAL_WINDOW_LIMIT },
    };

    res.json({ success: true, data: { windows, limits } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取窗口列表失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/operators/windows/:id/bind — 绑定窗口到操作员 */
router.post('/windows/:id/bind', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const bodySchema = z.object({ operatorId: z.number().int().positive() });

    const { id } = paramsSchema.parse(req.params);
    const { operatorId } = bodySchema.parse(req.body);

    // 检查窗口是否存在且可用
    const window = await prisma.browserWindow.findUnique({ where: { id } });
    if (!window) {
      return res.status(404).json({ success: false, error: '窗口不存在' });
    }
    if (window.status === 'bound' && window.boundOperatorId !== operatorId) {
      return res.status(409).json({ success: false, error: '窗口已被其他用户绑定' });
    }

    // 检查操作员是否存在
    const operator = await prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator) {
      return res.status(404).json({ success: false, error: '操作员不存在' });
    }

    const updated = await prisma.browserWindow.update({
      where: { id },
      data: { boundOperatorId: operatorId, status: 'bound' },
    });

    // 同步创建监控 User 记录
    await syncOperatorToMonitorUser(operatorId);

    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '绑定窗口失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/operators/windows/:id/unbind — 解绑窗口 */
router.post('/windows/:id/unbind', async (req: Request, res: Response) => {
  try {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);

    const window = await prisma.browserWindow.findUnique({ where: { id } });
    if (!window) {
      return res.status(404).json({ success: false, error: '窗口不存在' });
    }

    // 清理该窗口的监控用户数据及关联（防止孤儿数据）
    if (window.boundOperatorId) {
      await cleanupWindowMonitorData(window.externalId, `window ${id} unbound`);
    }

    const updated = await prisma.browserWindow.update({
      where: { id },
      data: { boundOperatorId: null, status: 'available' },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '解绑窗口失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/operators/windows/create — 创建新窗口（带限制检查） */
router.post('/windows/create', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      vendor: z.enum(['bitbrowser', 'roxybrowser']),
      name: z.string().min(1).max(255),
      platform: z.string().url().optional(),
      proxy: z.object({
        type: z.enum(['noproxy', 'http', 'https', 'socks5']),
        host: z.string().optional(),
        port: z.number().int().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      }).optional(),
    });

    const { vendor, ...config } = schema.parse(req.body);

    // 检查供应商限制
    const vendorCount = await prisma.browserWindow.count({ where: { browserVendor: vendor } });
    const vendorLimit = VENDOR_WINDOW_LIMITS[vendor as BrowserVendor];
    if (vendorCount >= vendorLimit) {
      return res.status(400).json({
        success: false,
        error: `${vendor} 已达到窗口上限 ${vendorLimit} 个`,
      });
    }

    // 检查总限制
    const totalCount = await prisma.browserWindow.count();
    if (totalCount >= TOTAL_WINDOW_LIMIT) {
      return res.status(400).json({
        success: false,
        error: `所有浏览器窗口总数已达到上限 ${TOTAL_WINDOW_LIMIT} 个`,
      });
    }

    // 调用浏览器API创建窗口
    let windowInfo;
    try {
      windowInfo = await createWindow(vendor as BrowserVendor, config);
    } catch (apiErr) {
      logger.error({ err: (apiErr as Error).message }, '浏览器API创建窗口失败');
      return res.status(502).json({ success: false, error: `创建窗口失败: ${(apiErr as Error).message}` });
    }

    // 保存到数据库
    let dbWindow;
    try {
      dbWindow = await prisma.browserWindow.create({
        data: {
          externalId: windowInfo.id,
          browserVendor: vendor,
          windowName: windowInfo.name,
          workspaceId: windowInfo.workspaceId || null,
          rawConfig: windowInfo.raw ? JSON.stringify(windowInfo.raw) : null,
          status: 'available',
        },
      });
    } catch (dbErr) {
      logger.warn({ err: (dbErr as Error).message }, '数据库保存窗口失败');
      // 仍然返回创建成功的信息
      dbWindow = {
        id: 0,
        externalId: windowInfo.id,
        browserVendor: vendor,
        windowName: windowInfo.name,
        status: 'available',
      };
    }

    logger.info(`创建窗口成功: ${vendor} - ${windowInfo.name} (${windowInfo.id})`);
    res.status(201).json({ success: true, data: dbWindow });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '创建窗口失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 平台管理
// ============================================================

/** POST /api/v1/operators/:id/platforms — 为操作员添加平台 */
router.post('/:id/platforms', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const bodySchema = z.object({
      platform: z.enum(['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok']),
    });

    const { id } = paramsSchema.parse(req.params);
    const { platform } = bodySchema.parse(req.body);

    const existing = await prisma.operatorPlatform.findUnique({
      where: { idx_operator_platform: { operatorId: id, platform } },
    });

    if (existing) {
      return res.status(409).json({ success: false, error: '该平台已绑定' });
    }

    const binding = await prisma.operatorPlatform.create({
      data: { operatorId: id, platform, loginStatus: 'unknown' },
    });

    // 同步创建监控 User 记录
    await syncOperatorToMonitorUser(id);

    res.status(201).json({ success: true, data: binding });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '添加平台失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** DELETE /api/v1/operators/:id/platforms/:platform — 移除操作员平台 */
router.delete('/:id/platforms/:platform', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      id: z.coerce.number().int().positive(),
      platform: z.string().min(1),
    });

    const { id, platform } = schema.parse(req.params);

    // 先获取操作员绑定的窗口，用于清理 User 记录
    const operator = await prisma.operator.findUnique({
      where: { id },
      include: { windows: { where: { status: 'bound' } } },
    });

    await prisma.operatorPlatform.delete({
      where: { idx_operator_platform: { operatorId: id, platform } },
    });

    // 清理对应的 User（监控用户）记录及其关联数据，防止孤儿记录继续被调度
    if (operator) {
      const boundWindow = operator.windows.find((w) => w.status === 'bound');
      if (boundWindow) {
        // 先查出所有要删除的 User 及其视频 ID（必须在 User 删除前获取）
        const usersToDelete = await prisma.user.findMany({
          where: { fingerprintWindowId: boundWindow.externalId, platform },
          include: { videos: { select: { id: true } } },
        });

        // 收集所有视频 ID
        const allVideoIds: string[] = [];
        const userIds: number[] = [];
        for (const u of usersToDelete) {
          userIds.push(u.id);
          allVideoIds.push(...u.videos.map((v) => v.id));
        }

        // 清理无 FK 关联的子表
        if (allVideoIds.length > 0) {
          await prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: allVideoIds } } });
          await prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: allVideoIds } } });
          await prisma.videoCommentCount.deleteMany({ where: { videoId: { in: allVideoIds } } });
        }
        if (userIds.length > 0) {
          await prisma.monitorStatus.deleteMany({ where: { accountId: { in: userIds.map(String) } } });
        }

        // User 删除 → 级联删除 Video → 级联删除 Comment
        const deleted = await prisma.user.deleteMany({
          where: { fingerprintWindowId: boundWindow.externalId, platform },
        });
        if (deleted.count > 0) {
          logger.info({ operatorId: id, platform, windowId: boundWindow.externalId, deletedCount: deleted.count, cleanedVideoRecordCount: allVideoIds.length }, '已清理对应的监控用户记录及关联数据');

          // 移除 BullMQ 中该用户的所有待处理监控任务
          const staleJobs = await monitorQueue.getJobs(['waiting', 'delayed']);
          let removedJobs = 0;
          const deletedUserIds = new Set(userIds);
          for (const job of staleJobs) {
            if (deletedUserIds.has(job.data.userId)) {
              await job.remove().catch(() => {});
              removedJobs++;
            }
          }
          if (removedJobs > 0) {
            logger.info({ operatorId: id, platform, removedJobs }, '已清理 BullMQ 残留任务');
          }
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '移除平台失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 登录验证
// ============================================================

/** POST /api/v1/operators/:id/verify-login — 验证操作员的平台登录状态 */
router.post('/:id/verify-login', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const bodySchema = z.object({
      platform: z.enum(['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok']),
    });

    const { id } = paramsSchema.parse(req.params);
    const { platform } = bodySchema.parse(req.body);

    logger.info({ operatorId: id, platform }, '开始验证登录态');

    // 获取操作员绑定的窗口
    const operator = await prisma.operator.findUnique({
      where: { id },
      include: { windows: { take: 1 } },
    });

    if (!operator || operator.windows.length === 0) {
      logger.warn({ operatorId: id }, '操作员未绑定窗口，无法验证');
      return res.status(400).json({ success: false, error: '操作员未绑定窗口' });
    }

    const window = operator.windows[0];

    logger.info({ operatorId: id, platform, browserVendor: window.browserVendor, externalId: window.externalId }, '操作员窗口信息');

    // 更新状态为检查中
    await prisma.operatorPlatform.update({
      where: { idx_operator_platform: { operatorId: id, platform } },
      data: { loginStatus: 'checking' },
    });

    // 预检查: 浏览器API是否可达
    try {
      const provider = getProvider(window.browserVendor as BrowserVendor);
      const healthy = await provider.healthCheck().catch(() => false);
      if (!healthy) {
        // 更新状态为检查失败
        await prisma.operatorPlatform.update({
          where: { idx_operator_platform: { operatorId: id, platform } },
          data: { loginStatus: 'unknown', lastVerifiedAt: new Date() },
        });
        logger.warn({ operatorId: id, platform, vendor: window.browserVendor }, '浏览器API不可达，无法验证登录态');
        return res.json({
          success: true,
          data: { platform, loginStatus: 'unknown', detail: '浏览器API不可达，请确认浏览器服务已启动', wechatUserId: operator.wechatUserId },
        });
      }
      logger.info({ operatorId: id, platform, vendor: window.browserVendor }, '浏览器API健康检查通过');
    } catch (healthErr) {
      // healthCheck threw - provider not registered or unreachable
      logger.error({ err: (healthErr as Error).message, operatorId: id, vendor: window.browserVendor }, '浏览器健康检查失败');
    }

    // 带超时的登录检测
    const VERIFY_TIMEOUT_MS = 25_000;
    let result: { loggedIn: boolean; detail: string };

    try {
      result = await Promise.race([
        checkPlatformLogin(window.browserVendor as BrowserVendor, window.externalId, platform),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('验证超时 (25s)')), VERIFY_TIMEOUT_MS)
        ),
      ]);
      logger.info({ operatorId: id, platform, loggedIn: result.loggedIn }, '登录态验证完成');
    } catch (verifyErr) {
      logger.error({ err: (verifyErr as Error).message, operatorId: id, platform }, '登录态验证失败');
      result = { loggedIn: false, detail: `验证失败: ${(verifyErr as Error).message}` };
    }

    const loginStatus = result.loggedIn ? 'logged_in' : 'not_logged_in';

    // 获取之前的登录状态，用于检测状态变化
    const previousPlatform = await prisma.operatorPlatform.findUnique({
      where: { idx_operator_platform: { operatorId: id, platform } },
      select: { loginStatus: true },
    });
    const previousStatus = previousPlatform?.loginStatus || 'unknown';

    // 更新平台登录状态（即使验证失败也会执行）
    await prisma.operatorPlatform.update({
      where: { idx_operator_platform: { operatorId: id, platform } },
      data: { loginStatus, lastVerifiedAt: new Date() },
    });

    // 关键修复：当登录状态从非登录变为已登录时，重置调度器倒计时
    // 这确保用户登录后监控能立即开始执行
    const statusChangedToLoggedIn = previousStatus !== 'logged_in' && loginStatus === 'logged_in';
    if (statusChangedToLoggedIn) {
      logger.info({ operatorId: id, platform, previousStatus }, '登录状态变化为已登录，重置调度器倒计时');
      resetSchedulerTimer(window.externalId, platform);

      // 关键修复：同时将 User.status 从 'login_required' 恢复为 'active'
      // 否则用户会被 getAllActiveUsers() 过滤掉，导致无法加入监控队列
      const updatedUser = await prisma.user.updateMany({
        where: {
          fingerprintWindowId: window.externalId,
          platform,
          status: { in: ['login_required', 'risk_control'] },
        },
        data: { status: 'active' },
      });
      if (updatedUser.count > 0) {
        logger.info({ operatorId: id, platform, updatedCount: updatedUser.count }, '用户状态已从 login_required/risk_control 恢复为 active');
      }
    }

    // 记录验证日志
    await prisma.loginVerification.create({
      data: {
        operatorId: id,
        platform,
        status: loginStatus,
        detail: JSON.stringify({ windowExternalId: window.externalId, detail: result.detail }),
      },
    });

    res.json({
      success: true,
      data: {
        platform,
        loginStatus,
        detail: result.detail,
        wechatUserId: operator.wechatUserId,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '验证登录失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /api/v1/operators/verify-all — 批量验证所有操作员的所有平台 */
router.post('/verify-all', async (_req: Request, res: Response) => {
  try {
    const operators = await prisma.operator.findMany({
      where: { enabled: true },
      include: {
        windows: { take: 1 },
        platforms: true,
      },
    });

    const results: Array<{ operatorId: number; platform: string; status: string }> = [];
    // 跟踪登录状态变化的 (windowId, platform) 对
    const changedPairs = new Set<string>();

    for (const op of operators) {
      if (op.windows.length === 0) continue;

      const window = op.windows[0];

      for (const plat of op.platforms) {
        try {
          const result = await checkPlatformLogin(
            window.browserVendor as BrowserVendor,
            window.externalId,
            plat.platform,
          );
          const loginStatus = result.loggedIn ? 'logged_in' : 'not_logged_in';

          // 检查状态变化
          const previousStatus = plat.loginStatus || 'unknown';
          const statusChangedToLoggedIn = previousStatus !== 'logged_in' && loginStatus === 'logged_in';
          if (statusChangedToLoggedIn) {
            changedPairs.add(`${window.externalId}_${plat.platform}`);
            logger.info({ operatorId: op.id, platform: plat.platform, previousStatus }, '批量验证：登录状态变化为已登录');

            // 同时将 User.status 从 'login_required' 恢复为 'active'
            await prisma.user.updateMany({
              where: {
                fingerprintWindowId: window.externalId,
                platform: plat.platform,
                status: { in: ['login_required', 'risk_control'] },
              },
              data: { status: 'active' },
            }).catch(() => {});
          }

          await prisma.operatorPlatform.update({
            where: { idx_operator_platform: { operatorId: op.id, platform: plat.platform } },
            data: { loginStatus, lastVerifiedAt: new Date() },
          });

          results.push({ operatorId: op.id, platform: plat.platform, status: loginStatus });
        } catch (err) {
          results.push({ operatorId: op.id, platform: plat.platform, status: 'error' });
        }
      }
    }

    // 如果有平台状态变化为已登录，重置对应 (windowId, platform) 的调度器
    for (const pairKey of changedPairs) {
      const lastUnderscore = pairKey.lastIndexOf('_');
      const windowId = pairKey.substring(0, lastUnderscore);
      const platform = pairKey.substring(lastUnderscore + 1);
      logger.info({ windowId, platform }, '批量验证：重置调度器');
      resetSchedulerTimer(windowId, platform);
    }

    res.json({ success: true, data: results });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '批量验证失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// 浏览器供应商配置
// ============================================================

/** POST /api/v1/operators/browser-config — 注册浏览器供应商配置 */
router.post('/browser-config', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      vendor: z.enum(['bitbrowser', 'roxybrowser']),
      baseUrl: z.string().url(),
      apiKey: z.string().optional(),
      workspaceId: z.string().optional(),
    });

    const config = schema.parse(req.body);
    registerBrowser(config);

    res.json({ success: true, message: `已注册 ${config.vendor} 配置` });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '注册浏览器配置失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /api/v1/operators/browser-config — 获取已注册的浏览器供应商配置 */
router.get('/browser-config', async (_req: Request, res: Response) => {
  try {
    const providers = getAllProviders();
    const data = providers.map((p) => ({ vendor: p.vendor }));
    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取浏览器配置失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
