// @ts-api-gateway/routes/notifications.ts - 通知渠道与规则管理 API (in-memory mock)
// 生产环境对接 LiteLLM 通知服务 / 企业微信 webhook

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:notifications');

// ============================================================
// 类型定义
// ============================================================

type ChannelType = 'wechat_work' | 'webhook' | 'email' | 'sms';
type RuleEvent = 'publish_success' | 'publish_failed' | 'risk_detected' | 'monitor_anomaly' | 'quota_exceeded';

interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  config: Record<string, string>;
  testStatus?: 'ok' | 'failed' | 'untested';
}

interface NotificationRule {
  id: string;
  name: string;
  event: RuleEvent;
  channelIds: string[];
  threshold?: { count?: number; windowMinutes?: number };
  enabled: boolean;
}

// ============================================================
// Mock 数据
// ============================================================

let channels: NotificationChannel[] = [
  {
    id: 'ch-wechat',
    name: '企业微信通知',
    type: 'wechat_work',
    enabled: true,
    config: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' },
    testStatus: 'ok',
  },
  {
    id: 'ch-webhook',
    name: '通用 Webhook',
    type: 'webhook',
    enabled: true,
    config: { url: 'https://hooks.example.com/alert', method: 'POST' },
    testStatus: 'untested',
  },
  {
    id: 'ch-email',
    name: '邮件通知',
    type: 'email',
    enabled: false,
    config: { recipients: 'admin@naite.com' },
    testStatus: 'untested',
  },
];

let rules: NotificationRule[] = [
  {
    id: 'rule-publish-fail',
    name: '发布失败告警',
    event: 'publish_failed',
    channelIds: ['ch-wechat', 'ch-webhook'],
    threshold: { count: 3, windowMinutes: 10 },
    enabled: true,
  },
  {
    id: 'rule-risk',
    name: '风控检测告警',
    event: 'risk_detected',
    channelIds: ['ch-wechat'],
    enabled: true,
  },
  {
    id: 'rule-llm-quota',
    name: 'LLM 超额告警',
    event: 'quota_exceeded',
    channelIds: ['ch-email'],
    threshold: { count: 1, windowMinutes: 60 },
    enabled: false,
  },
];

// ============================================================
// Zod Schemas
// ============================================================

const updateChannelSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  type: z.enum(['wechat_work', 'webhook', 'email', 'sms']).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string()).optional(),
  testStatus: z.enum(['ok', 'failed', 'untested']).optional(),
});

const updateRuleSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  event: z.enum(['publish_success', 'publish_failed', 'risk_detected', 'monitor_anomaly', 'quota_exceeded']).optional(),
  channelIds: z.array(z.string()).min(1).optional(),
  threshold: z.object({ count: z.number().int().positive().optional(), windowMinutes: z.number().int().positive().optional() }).optional(),
  enabled: z.boolean().optional(),
});

const idParamSchema = z.object({
  id: z.string().min(1),
});

// ============================================================
// 辅助：写 OperationLog
// ============================================================

async function writeOpLog(action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await prisma.operationLog.create({
      data: {
        action,
        details: JSON.stringify(details),
        userId: 'system',
        userName: 'Notifications API',
        result: 'success',
        level: 'info',
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '写入 OperationLog 失败');
  }
}

// ============================================================
// GET /api/v1/notifications/channels — 通知渠道列表
// ============================================================

router.get('/channels', (_req: Request, res: Response) => {
  res.json({ success: true, data: channels });
});

// ============================================================
// PUT /api/v1/notifications/channels/:id — 更新渠道
// ============================================================

router.put('/channels/:id', async (req: Request, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = updateChannelSchema.parse(req.body);

    const idx = channels.findIndex((c) => c.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: `通知渠道不存在: ${id}` });
    }

    channels[idx] = { ...channels[idx], ...body };

    await writeOpLog('notifications_update_channel', { channelId: id, changes: body });

    res.json({ success: true, data: channels[idx] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '更新通知渠道失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ============================================================
// GET /api/v1/notifications/rules — 通知规则列表
// ============================================================

router.get('/rules', (_req: Request, res: Response) => {
  res.json({ success: true, data: rules });
});

// ============================================================
// PUT /api/v1/notifications/rules/:id — 更新规则
// ============================================================

router.put('/rules/:id', async (req: Request, res: Response) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const body = updateRuleSchema.parse(req.body);

    const idx = rules.findIndex((r) => r.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: `通知规则不存在: ${id}` });
    }

    rules[idx] = { ...rules[idx], ...body };

    await writeOpLog('notifications_update_rule', { ruleId: id, changes: body });

    res.json({ success: true, data: rules[idx] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '更新通知规则失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;

// ============================================================
// 板块七: 企业微信通知路由专属配置 (wecom config)
// ============================================================

interface WecomConfig {
  bot_id: string;
  bot_secret: string;
  global_chat_id: string;
  account_chat_mapping: Record<string, string>;
}

const wecomState: WecomConfig = {
  bot_id: 'ww123456789',
  bot_secret: 'secret_xxxxxx',
  global_chat_id: 'chat_ops_central',
  account_chat_mapping: {
    WIN_A892: 'chat_sales_team',
    WIN_B104: 'chat_design_group',
  },
};

const wecomRouter = (() => {
  const r = Router();

  /** GET /api/v1/notifications/wecom */
  r.get('/', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        bot_id: wecomState.bot_id,
        bot_secret: wecomState.bot_secret.slice(0, 6) + '...',
        global_chat_id: wecomState.global_chat_id,
        account_chat_mapping: wecomState.account_chat_mapping,
      },
      meta: { carrier: 'PostgreSQL config_entries', strategy: 'hot' },
    });
  });

  /** PUT /api/v1/notifications/wecom */
  r.put('/', (req: Request, res: Response) => {
    const { bot_id, bot_secret, global_chat_id, account_chat_mapping } = req.body;
    if (bot_id !== undefined) wecomState.bot_id = String(bot_id);
    if (bot_secret !== undefined) wecomState.bot_secret = String(bot_secret);
    if (global_chat_id !== undefined) wecomState.global_chat_id = String(global_chat_id);
    if (account_chat_mapping && typeof account_chat_mapping === 'object') {
      wecomState.account_chat_mapping = account_chat_mapping;
    }
    res.json({
      success: true,
      data: { ...wecomState, bot_secret: wecomState.bot_secret.slice(0, 6) + '...' },
      message: '企业微信通知路由已热重载',
    });
  });

  return r;
})();

export { wecomRouter };
