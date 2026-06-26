// @ts-api-gateway/routes/maintenance.ts - 维护调试 REST API
// 执行健康 / 选择器 / 快照 / 配置管理 / 验证 / 重试

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';


const router = Router();
const logger = createLogger('routes:maintenance');

// ============================================================
// Task 12: 执行健康 + 选择器 + 快照
// ============================================================

/**
 * GET /executions — 查询执行记录
 * 筛选: platform, healthStatus, flowType, startDate, endDate
 * 分页: page, limit
 */
router.get('/executions', async (req: Request, res: Response) => {
  try {
    const querySchema = z.object({
      platform: z.string().optional(),
      healthStatus: z.string().optional(),
      flowType: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    });
    const { platform, healthStatus, flowType, startDate, endDate, page, limit } = querySchema.parse(req.query);

    const where: any = {};
    if (platform) where.platform = platform;
    if (healthStatus) where.overallHealth = healthStatus;
    if (flowType) where.flowType = flowType;
    if (startDate || endDate) {
      where.startedAt = {};
      if (startDate) where.startedAt.gte = new Date(startDate);
      if (endDate) where.startedAt.lte = new Date(endDate);
    }

    const [total, rows] = await Promise.all([
      prisma.maintenanceExecution.count({ where }),
      prisma.maintenanceExecution.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取执行记录失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /executions/:id — 单次执行详情 + 关联 steps
 */
router.get('/executions/:id', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse(req.params);

    const execution = await prisma.maintenanceExecution.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!execution) {
      return res.status(404).json({ success: false, error: `执行记录不存在: ${id}` });
    }

    res.json({ success: true, data: execution });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取执行详情失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /executions/:id/steps — 子步骤详情 + selectorRecords + urlRecords + snapshots
 */
router.get('/executions/:id/steps', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = paramsSchema.parse(req.params);

    const execution = await prisma.maintenanceExecution.findUnique({ where: { id } });
    if (!execution) {
      return res.status(404).json({ success: false, error: `执行记录不存在: ${id}` });
    }

    const steps = await prisma.maintenanceStep.findMany({
      where: { executionId: id },
      orderBy: { createdAt: 'asc' },
      include: {
        selectorRecords: true,
        urlRecords: true,
        snapshots: true,
      },
    });

    res.json({ success: true, data: steps });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取步骤详情失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /selectors/health — 按 selectorKey 聚合选择器健康度
 */
router.get('/selectors/health', async (_req: Request, res: Response) => {
  try {
    const records = await prisma.maintenanceSelectorRecord.groupBy({
      by: ['selectorKey'],
      _count: { id: true },
      _min: { durationMs: true },
      _max: { durationMs: true },
      _avg: { durationMs: true },
    });

    // 获取每个 selectorKey 的成功/降级统计
    const result = await Promise.all(
      records.map(async (r: { selectorKey: string; _count: { id: number }; _min: { durationMs: number | null }; _max: { durationMs: number | null }; _avg: { durationMs: number | null } }) => {
        const totalCount = r._count.id;
        const [successCount, degradedCount] = await Promise.all([
          prisma.maintenanceSelectorRecord.count({
            where: { selectorKey: r.selectorKey, result: 'found' },
          }),
          prisma.maintenanceSelectorRecord.count({
            where: {
              selectorKey: r.selectorKey,
              result: { in: ['not_found', 'timeout', 'error', 'honeypot_blocked', 'scope_not_found'] },
            },
          }),
        ]);

        return {
          selectorKey: r.selectorKey,
          totalCount,
          successCount,
          degradedCount,
          successRate: totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0,
          degradedRate: totalCount > 0 ? Math.round((degradedCount / totalCount) * 100) : 0,
          primaryRate: totalCount > 0
            ? Math.round(
                (await prisma.maintenanceSelectorRecord.count({
                  where: { selectorKey: r.selectorKey, selectorSource: { in: ['primary', 'fallback_1'] } },
                })) / totalCount * 100
              )
            : 0,
          avgDurationMs: r._avg.durationMs ? Math.round(r._avg.durationMs) : null,
          minDurationMs: r._min.durationMs ?? null,
          maxDurationMs: r._max.durationMs ?? null,
        };
      }),
    );

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取选择器健康度失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /selectors/:key/history — 单选择器历史趋势
 */
router.get('/selectors/:key/history', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ key: z.string().min(1) });
    const querySchema = z.object({
      days: z.coerce.number().int().positive().default(7),
      limit: z.coerce.number().int().positive().max(500).default(100),
    });
    const { key } = paramsSchema.parse(req.params);
    const { days, limit } = querySchema.parse(req.query);

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const records = await prisma.maintenanceSelectorRecord.findMany({
      where: {
        selectorKey: key,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // 按天聚合
    const dailyMap = new Map<string, { total: number; success: number; degraded: number }>();
    for (const r of records) {
      const day = r.createdAt.toISOString().slice(0, 10);
      if (!dailyMap.has(day)) dailyMap.set(day, { total: 0, success: 0, degraded: 0 });
      const d = dailyMap.get(day)!;
      d.total++;
      if (r.result === 'found') d.success++;
      else if (['not_found', 'timeout', 'error', 'honeypot_blocked', 'scope_not_found'].includes(r.result)) d.degraded++;
    }

    const daily = Array.from(dailyMap.entries())
      .map(([date, stats]) => ({
        date,
        ...stats,
        successRate: stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0,
        degradedRate: stats.total > 0 ? Math.round((stats.degraded / stats.total) * 100) : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      data: {
        selectorKey: key,
        totalRecords: records.length,
        since: since.toISOString(),
        daily,
        recent: records.slice(0, 20),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取选择器历史失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /snapshots/:stepId — 获取指定步骤的 debug 快照
 */
router.get('/snapshots/:stepId', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ stepId: z.string().min(1) });
    const { stepId } = paramsSchema.parse(req.params);

    const step = await prisma.maintenanceStep.findUnique({ where: { id: stepId } });
    if (!step) {
      return res.status(404).json({ success: false, error: `步骤不存在: ${stepId}` });
    }

    const snapshots = await prisma.debugSnapshot.findMany({
      where: { stepId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: snapshots });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取 debug 快照失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// Task 13: 配置管理（快照 + 导出/导入）
// ============================================================

/**
 * POST /config/snapshots — 创建配置快照
 */
router.post('/config/snapshots', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      snapshotName: z.string().min(1).max(128),
      platform: z.string().min(1),
      configType: z.enum(['selectors', 'url_monitors', 'flow_rules']),
      configData: z.string().min(1),
      description: z.string().max(255).default(''),
      createdBy: z.string().max(32).default('system'),
    });
    const data = bodySchema.parse(req.body);

    const snapshot = await prisma.configSnapshot.create({
      data: {
        snapshotName: data.snapshotName,
        platform: data.platform,
        configType: data.configType,
        configData: data.configData,
        description: data.description,
        createdBy: data.createdBy,
      },
    });

    logger.info({ snapshotId: snapshot.id, platform: data.platform, configType: data.configType }, '配置快照已创建');
    res.status(201).json({ success: true, data: snapshot });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '创建配置快照失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /config/snapshots — 配置快照列表
 */
router.get('/config/snapshots', async (req: Request, res: Response) => {
  try {
    const querySchema = z.object({
      platform: z.string().optional(),
      configType: z.string().optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    });
    const { platform, configType, page, limit } = querySchema.parse(req.query);

    const where: any = {};
    if (platform) where.platform = platform;
    if (configType) where.configType = configType;

    const [total, rows] = await Promise.all([
      prisma.configSnapshot.count({ where }),
      prisma.configSnapshot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '获取配置快照列表失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /config/snapshots/:id/rollback — CAS 乐观锁回滚
 * 要求 body 中传入 expectedVersion，若数据库 version 不匹配则 409
 */
router.post('/config/snapshots/:id/rollback', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const bodySchema = z.object({
      expectedVersion: z.number().int().positive(),
    });
    const { id } = paramsSchema.parse(req.params);
    const { expectedVersion } = bodySchema.parse(req.body);

    const snapshot = await prisma.configSnapshot.findUnique({ where: { id } });
    if (!snapshot) {
      return res.status(404).json({ success: false, error: `配置快照不存在: ${id}` });
    }
    if (snapshot.version !== expectedVersion) {
      return res.status(409).json({
        success: false,
        error: `版本冲突: 当前版本 ${snapshot.version}, 期望版本 ${expectedVersion}`,
        currentVersion: snapshot.version,
      });
    }

    // 执行回滚：将活跃配置替换为快照内容
    // 对于 selectors 类型，更新/创建 custom_selectors 记录
    if (snapshot.configType === 'selectors') {
      const selectors = JSON.parse(snapshot.configData);
      if (Array.isArray(selectors)) {
        for (const sel of selectors) {
          const existing = await prisma.customSelector.findUnique({
            where: { platform_selectorKey: { platform: snapshot.platform, selectorKey: sel.selectorKey } },
          });
          if (existing) {
            await prisma.customSelector.update({
              where: { id: existing.id },
              data: {
                selectorValue: JSON.stringify(sel.selectorValue),
                version: { increment: 1 },
                updatedAt: new Date(),
              },
            });
          } else {
            await prisma.customSelector.create({
              data: {
                platform: snapshot.platform,
                selectorKey: sel.selectorKey,
                selectorValue: JSON.stringify(sel.selectorValue),
                description: sel.description || '',
              },
            });
          }
        }
      }
    }

    // 更新快照版本号
    const updated = await prisma.configSnapshot.update({
      where: { id },
      data: {
        version: { increment: 1 },
        isActive: true,
      },
    });

    logger.info({ snapshotId: id, platform: snapshot.platform, configType: snapshot.configType }, '配置已回滚');
    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ success: false, error: 'configData 不是有效的 JSON' });
    }
    logger.error({ err: (err as Error).message }, '回滚配置快照失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /config/export — 导出活跃配置
 */
router.post('/config/export', async (_req: Request, res: Response) => {
  try {
    const [customSelectors, platformConfigs, flowRules] = await Promise.all([
      prisma.customSelector.findMany({ orderBy: [{ platform: 'asc' }, { selectorKey: 'asc' }] }),
      prisma.platformConfig.findMany({ orderBy: [{ platform: 'asc' }, { configKey: 'asc' }] }),
      prisma.configSnapshot.findMany({
        where: { configType: 'flow_rules', isActive: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // 获取最新快照版本的 selectors 和 url_monitors
    const latestSelectorsSnapshot = await prisma.configSnapshot.findFirst({
      where: { configType: 'selectors', isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    const latestUrlSnapshot = await prisma.configSnapshot.findFirst({
      where: { configType: 'url_monitors', isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    const exportData = {
      exportedAt: new Date().toISOString(),
      customSelectors: customSelectors.map((s: { platform: string; selectorKey: string; selectorValue: string; description: string; enabled: boolean }) => ({
        platform: s.platform,
        selectorKey: s.selectorKey,
        selectorValue: JSON.parse(s.selectorValue),
        description: s.description,
        enabled: s.enabled,
      })),
      platformConfigs: platformConfigs.map((c: { platform: string; configKey: string; configValue: string; description: string; enabled: boolean }) => ({
        platform: c.platform,
        configKey: c.configKey,
        configValue: c.configValue,
        description: c.description,
        enabled: c.enabled,
      })),
      activeSnapshots: {
        selectors: latestSelectorsSnapshot ? { id: latestSelectorsSnapshot.id, snapshotName: latestSelectorsSnapshot.snapshotName, version: latestSelectorsSnapshot.version } : null,
        url_monitors: latestUrlSnapshot ? { id: latestUrlSnapshot.id, snapshotName: latestUrlSnapshot.snapshotName, version: latestUrlSnapshot.version } : null,
        flowRules: flowRules.map((r: { id: string; snapshotName: string; platform: string; version: number }) => ({ id: r.id, snapshotName: r.snapshotName, platform: r.platform, version: r.version })),
      },
    };

    res.json({ success: true, data: exportData });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '导出配置失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /config/import — 导入配置
 */
router.post('/config/import', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      customSelectors: z.array(z.object({
        platform: z.string(),
        selectorKey: z.string(),
        selectorValue: z.any(),
        description: z.string().optional(),
        enabled: z.boolean().optional().default(true),
      })).optional().default([]),
      platformConfigs: z.array(z.object({
        platform: z.string(),
        configKey: z.string(),
        configValue: z.string(),
        description: z.string().optional(),
        enabled: z.boolean().optional().default(true),
      })).optional().default([]),
    });
    const { customSelectors, platformConfigs } = bodySchema.parse(req.body);

    const results = { customSelectors: 0, platformConfigs: 0, errors: [] as string[] };

    // 导入选择器
    for (const sel of customSelectors) {
      try {
        const existing = await prisma.customSelector.findUnique({
          where: { platform_selectorKey: { platform: sel.platform, selectorKey: sel.selectorKey } },
        });
        if (existing) {
          await prisma.customSelector.update({
            where: { id: existing.id },
            data: {
              selectorValue: JSON.stringify(sel.selectorValue),
              description: sel.description ?? existing.description,
              enabled: sel.enabled,
              version: { increment: 1 },
            },
          });
        } else {
          await prisma.customSelector.create({
            data: {
              platform: sel.platform,
              selectorKey: sel.selectorKey,
              selectorValue: JSON.stringify(sel.selectorValue),
              description: sel.description || '',
              enabled: sel.enabled,
            },
          });
        }
        results.customSelectors++;
      } catch (e: any) {
        results.errors.push(`选择器 ${sel.platform}.${sel.selectorKey}: ${e.message}`);
      }
    }

    // 导入平台配置
    for (const cfg of platformConfigs) {
      try {
        const existing = await prisma.platformConfig.findUnique({
          where: { platform_configKey: { platform: cfg.platform, configKey: cfg.configKey } },
        });
        if (existing) {
          await prisma.platformConfig.update({
            where: { id: existing.id },
            data: {
              configValue: cfg.configValue,
              description: cfg.description ?? existing.description,
              enabled: cfg.enabled,
              version: { increment: 1 },
            },
          });
        } else {
          await prisma.platformConfig.create({
            data: {
              platform: cfg.platform,
              configKey: cfg.configKey,
              configValue: cfg.configValue,
              description: cfg.description || '',
              enabled: cfg.enabled,
            },
          });
        }
        results.platformConfigs++;
      } catch (e: any) {
        results.errors.push(`配置 ${cfg.platform}.${cfg.configKey}: ${e.message}`);
      }
    }

    logger.info({ imported: results }, '配置已导入');
    res.json({ success: true, data: results });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '导入配置失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// Task 14: 验证 & 重试
// ============================================================

/**
 * POST /verify/selector — 选择器验证（参数校验 + 注册表检查）
 * 实际浏览器验证需 BrowserManager.connect，此处做参数完整性校验
 */
router.post('/verify/selector', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      windowId: z.string().min(1),
      selectorKey: z.string().min(1),
      platform: z.string().min(1),
    });
    const { windowId, selectorKey, platform } = bodySchema.parse(req.body);

    // 动态载入 BrowserManager 和 SelectorRegistry 做实际验证
    let registryCheck: any = null;
    let browserCheck: any = null;

    try {
      const { BrowserManager } = await import('@social-media/browser-core');
      const { SelectorRegistry } = await import('@social-media/browser-core');

      registryCheck = SelectorRegistry.get(`${platform}.${selectorKey}`);
    } catch (importErr) {
      logger.warn({ err: (importErr as Error).message }, '浏览器核心模块加载失败，跳过实际验证');
    }

    res.json({
      success: true,
      data: {
        windowId,
        selectorKey,
        platform,
        registryCheck: registryCheck
          ? { found: true, primary: registryCheck.primary }
          : { found: false },
        browserCheck,
        message: '参数校验通过（实际浏览器验证需浏览器环境）',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '验证选择器失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /verify/url — URL 匹配验证
 */
router.post('/verify/url', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      urlPattern: z.string().min(1),
      actualUrl: z.string().min(1),
    });
    const { urlPattern, actualUrl } = bodySchema.parse(req.body);

    // 将 urlPattern 中的通配符 * 转为正则
    const regexStr = '^' + urlPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$';
    const regex = new RegExp(regexStr, 'i');
    const isMatch = regex.test(actualUrl);

    res.json({
      success: true,
      data: {
        urlPattern,
        actualUrl,
        regexPattern: regexStr,
        isMatch,
        message: isMatch ? 'URL 匹配成功' : 'URL 不匹配',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    if (err instanceof SyntaxError) {
      return res.status(400).json({ success: false, error: `正则表达式无效: ${(err as Error).message}` });
    }
    logger.error({ err: (err as Error).message }, 'URL 匹配验证失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /retry/step — 子步骤重试（参数校验）
 * 实际重试逻辑由队列调度，此处仅做参数有效性校验
 */
router.post('/retry/step', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      stepId: z.string().min(1),
      executionId: z.string().min(1),
    });
    const { stepId, executionId } = bodySchema.parse(req.body);

    // 校验 step 和 execution 是否存在
    const [execution, step] = await Promise.all([
      prisma.maintenanceExecution.findUnique({ where: { id: executionId } }),
      prisma.maintenanceStep.findUnique({ where: { id: stepId } }),
    ]);

    if (!execution) {
      return res.status(404).json({ success: false, error: `执行记录不存在: ${executionId}` });
    }
    if (!step) {
      return res.status(404).json({ success: false, error: `步骤不存在: ${stepId}` });
    }
    if (step.executionId !== executionId) {
      return res.status(400).json({
        success: false,
        error: '步骤不属于该执行记录',
      });
    }

    res.json({
      success: true,
      data: {
        stepId,
        executionId,
        stepName: step.stepName,
        healthStatus: step.healthStatus,
        message: '参数校验通过（实际重试需通过队列调度）',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '步骤重试参数校验失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
