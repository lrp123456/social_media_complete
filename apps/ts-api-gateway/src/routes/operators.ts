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
        windows: {
          include: {
            platforms: { select: { platform: true, loginStatus: true, lastVerifiedAt: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 扁平化：将 windows[].platforms 聚合到 operator.platforms
    const operatorsWithPlatforms = operators.map((op) => ({
      ...op,
      platforms: op.windows.flatMap((w: any) => w.platforms || []),
    }));

    res.json({ success: true, data: operatorsWithPlatforms });
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

    // 允许同一企微用户创建多个操作员（不同窗口），不再校验 wechatUserId 唯一

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
      wechatUserId: z.string().min(1).max(64).optional(),
      displayName: z.string().min(1).max(64).optional(),
      phone: z.string().max(20).optional(),
      role: z.enum(['admin', 'operator']).optional(),
      enabled: z.boolean().optional(),
    });

    const { id } = paramsSchema.parse(req.params);
    const data = bodySchema.parse(req.body);

    // 允许同一企微用户拥有多个操作员，不再校验 wechatUserId 唯一

    const operator = await prisma.operator.update({ where: { id }, data });

    // wechatUserId 变更时级联更新所有关联窗口的 PlatformAccount
    if (data.wechatUserId) {
      await prisma.platformAccount.updateMany({
        where: { window: { boundOperatorId: id } },
        data: { wechatUserid: data.wechatUserId },
      });
    }

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

    // 停止所有关联窗口的监控
    await prisma.platformAccount.updateMany({
      where: { window: { boundOperatorId: id } },
      data: { monitoringEnabled: false },
    });

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
      vendor: z.enum(['bitbrowser', 'roxybrowser', 'all']),
    });
    const { vendor } = schema.parse(req.body);

    // 1. 从浏览器API获取窗口列表
    let windows;
    try {
      windows = vendor === 'all'
        ? await syncAllWindows()
        : await syncWindows(vendor as BrowserVendor);
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

    // 停止该窗口的监控（平台账号保留，仅停监控）
    await prisma.platformAccount.updateMany({
      where: { windowId: window.id },
      data: { monitoringEnabled: false },
    });

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

    // 先查出待删除的平台账号 ID（用于后续清理 BullMQ）
    const accountsToDelete = await prisma.platformAccount.findMany({
      where: { window: { boundOperatorId: id }, platform },
      select: { id: true },
    });
    const accountIds = accountsToDelete.map((a) => a.id);

    // 删除 operatorPlatform 绑定
    await prisma.operatorPlatform.delete({
      where: { idx_operator_platform: { operatorId: id, platform } },
    });

    // 删除 PlatformAccount — FK 级联会处理 Video/Comment 等子表
    if (accountIds.length > 0) {
      await prisma.platformAccount.deleteMany({
        where: { id: { in: accountIds } },
      });
      logger.info({ operatorId: id, platform, deletedCount: accountIds.length }, '已清理对应的监控用户记录');

      // 清理 BullMQ 中该用户的待处理监控任务
      const staleJobs = await monitorQueue.getJobs(['waiting', 'delayed']);
      let removedJobs = 0;
      for (const job of staleJobs) {
        if (accountIds.includes(job.data.userId)) {
          await job.remove().catch(() => {});
          removedJobs++;
        }
      }
      if (removedJobs > 0) {
        logger.info({ operatorId: id, platform, removedJobs }, '已清理 BullMQ 残留任务');
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

    // 获取操作员绑定的所有窗口（遍历所有窗口，逐窗口 try/catch）
    const operator = await prisma.operator.findUnique({
      where: { id },
      include: { windows: { where: { status: 'bound' } } },
    });

    if (!operator || operator.windows.length === 0) {
      logger.warn({ operatorId: id }, '操作员未绑定窗口，无法验证');
      return res.status(400).json({ success: false, error: '操作员未绑定窗口' });
    }

    // 更新状态为检查中
    await prisma.operatorPlatform.update({
      where: { idx_operator_platform: { operatorId: id, platform } },
      data: { loginStatus: 'checking' },
    });

    // 遍历所有窗口进行验证，取最佳结果
    const VERIFY_TIMEOUT_MS = 25_000;
    let bestResult: { loggedIn: boolean; detail: string } | null = null;
    let bestWindowExternalId: string | null = null;

    for (const window of operator.windows) {
      try {
        logger.info({ operatorId: id, platform, browserVendor: window.browserVendor, externalId: window.externalId, windowId: window.id }, '操作员窗口信息');

        // 预检查: 浏览器API是否可达
        const provider = getProvider(window.browserVendor as BrowserVendor);
        const healthy = await provider.healthCheck().catch(() => false);
        if (!healthy) {
          logger.warn({ operatorId: id, platform, vendor: window.browserVendor, windowId: window.id }, '浏览器API不可达，跳过该窗口');
          continue;
        }

        // 带超时的登录检测
        const result = await Promise.race([
          checkPlatformLogin(window.browserVendor as BrowserVendor, window.externalId, platform),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('验证超时 (25s)')), VERIFY_TIMEOUT_MS)
          ),
        ]);

        logger.info({ operatorId: id, platform, loggedIn: result.loggedIn, windowId: window.id }, '登录态验证完成');

        // 保留最佳结果（优先 logged_in）
        if (!bestResult || (result.loggedIn && !bestResult.loggedIn)) {
          bestResult = result;
          bestWindowExternalId = window.externalId;
        }

        // 如果已登录，直接使用这个结果
        if (result.loggedIn) break;
      } catch (winErr) {
        logger.error({ err: (winErr as Error).message, operatorId: id, platform, windowId: window.id }, '窗口验证异常');
        continue;
      }
    }

    if (!bestResult) {
      bestResult = { loggedIn: false, detail: '所有窗口验证均失败' };
    }

    const loginStatus = bestResult.loggedIn ? 'logged_in' : 'not_logged_in';

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
    const statusChangedToLoggedIn = previousStatus !== 'logged_in' && loginStatus === 'logged_in';
    if (statusChangedToLoggedIn && bestWindowExternalId) {
      logger.info({ operatorId: id, platform, previousStatus }, '登录状态变化为已登录，重置调度器倒计时');
      resetSchedulerTimer(bestWindowExternalId, platform);

      // 同时将 PlatformAccount.status 从 'login_required' 恢复为 'active'
      const updatedAccounts = await prisma.platformAccount.updateMany({
        where: {
          window: { boundOperatorId: id },
          platform,
          status: { in: ['login_required', 'risk_control'] },
        },
        data: { status: 'active' },
      });
      if (updatedAccounts.count > 0) {
        logger.info({ operatorId: id, platform, updatedCount: updatedAccounts.count }, '平台账号状态已从 login_required/risk_control 恢复为 active');
      }
    }

    // 记录验证日志
    await prisma.loginVerification.create({
      data: {
        operatorId: id,
        platform,
        status: loginStatus,
        detail: JSON.stringify({ detail: bestResult.detail }),
      },
    });

    res.json({
      success: true,
      data: {
        platform,
        loginStatus,
        detail: bestResult.detail,
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
        windows: { where: { status: 'bound' } },
        platforms: true,
      },
    });

    const results: Array<{ operatorId: number; platform: string; status: string }> = [];
    // 跟踪登录状态变化的 (externalId, platform) 对
    const changedPairs = new Set<string>();

    for (const op of operators) {
      if (op.windows.length === 0) continue;

      // 遍历所有窗口，逐窗口 try/catch
      for (const window of op.windows) {
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
              logger.info({ operatorId: op.id, platform: plat.platform, previousStatus, windowId: window.id }, '批量验证：登录状态变化为已登录');

              // 同时将 PlatformAccount.status 从 'login_required' 恢复为 'active'
              await prisma.platformAccount.updateMany({
                where: {
                  windowId: window.id,
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
    }

    // 如果有平台状态变化为已登录，重置对应 (externalId, platform) 的调度器
    for (const pairKey of changedPairs) {
      const lastUnderscore = pairKey.lastIndexOf('_');
      const externalId = pairKey.substring(0, lastUnderscore);
      const platform = pairKey.substring(lastUnderscore + 1);
      logger.info({ externalId, platform }, '批量验证：重置调度器');
      resetSchedulerTimer(externalId, platform);
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
