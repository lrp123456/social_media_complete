// @ts-api-gateway/routes/wecom-bot.ts - 企业微信机器人管理 API

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { botManager } from '../services/wechatBotService';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:wecom-bot');

// In-memory store for link results
const linkResults = new Map<string, { status: 'pending' | 'completed' | 'timeout'; userid: string }>();

/** POST /start — 启动机器人连接 */
router.post('/start', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      botId: z.string().min(1),
      secret: z.string().min(1),
    });
    const { botId, secret } = schema.parse(req.body);
    const status = await botManager.start({ botId, secret });
    res.json({ success: true, data: status });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ success: false, errors: err.errors });
    logger.error({ err: (err as Error).message }, '启动机器人失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /stop — 停止机器人连接 */
router.post('/stop', async (_req: Request, res: Response) => {
  try {
    await botManager.stop();
    res.json({ success: true, message: '机器人已断开' });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '停止机器人失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /status — 获取机器人状态 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = botManager.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取状态失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /link-request — 创建用户绑定请求 */
router.post('/link-request', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      timeoutMs: z.number().int().positive().default(120_000),
      sendTo: z.string().optional(),
    });
    const { timeoutMs, sendTo } = schema.parse(req.body);

    const { code, promise } = botManager.createLinkRequest(timeoutMs);
    const resultKey = `link_${code}`;
    linkResults.set(resultKey, { status: 'pending', userid: '' });

    promise.then((userid) => {
      if (userid) {
        linkResults.set(resultKey, { status: 'completed', userid });
      } else {
        linkResults.set(resultKey, { status: 'timeout', userid: '' });
      }
    });

    // If sendTo specified, send code via bot
    if (sendTo) {
      try {
        await botManager.sendTextMessage([sendTo], `您的绑定验证码是: ${code}，请回复此验证码完成绑定。`);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '发送验证码失败（机器人可能未连接）');
      }
    }

    res.json({
      success: true,
      data: {
        code,
        message: sendTo
          ? `验证码已发送给 ${sendTo}，请等待用户回复。`
          : `验证码: ${code}，请让用户向机器人发送此验证码。`,
        expiresIn: `${Math.round(timeoutMs / 1000)}秒`,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ success: false, errors: err.errors });
    logger.error({ err: (err as Error).message }, '创建链接请求失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** GET /link-result/:code — 轮询链接请求结果 */
router.get('/link-result/:code', async (req: Request, res: Response) => {
  try {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.params);
    const resultKey = `link_${code}`;
    const result = linkResults.get(resultKey);

    if (!result) return res.status(404).json({ success: false, error: '验证码不存在或已过期' });

    if (result.status === 'completed') {
      linkResults.delete(resultKey);
      return res.json({ success: true, data: { status: 'completed', userid: result.userid } });
    }
    if (result.status === 'timeout') {
      linkResults.delete(resultKey);
      return res.json({ success: true, data: { status: 'timeout', userid: '' } });
    }

    res.json({ success: true, data: { status: 'pending', userid: '' } });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ success: false, errors: err.errors });
    logger.error({ err: (err as Error).message }, '查询链接结果失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** POST /send — 发送消息给指定用户 */
router.post('/send', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      userids: z.array(z.string()).min(1),
      content: z.string().min(1).max(2000),
    });
    const { userids, content } = schema.parse(req.body);
    await botManager.sendTextMessage(userids, content);
    res.json({ success: true, message: '消息已发送' });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ success: false, errors: err.errors });
    logger.error({ err: (err as Error).message }, '发送消息失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
