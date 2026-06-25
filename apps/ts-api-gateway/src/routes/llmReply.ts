// @ts-api-gateway/routes/llmReply.ts
// AI 客服回复建议路由

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { replyGenerator } from '../services/llmService';
import { intelligentCS } from '../services/intelligentCsService';
import type { CommentContext } from '../services/llmService';
import * as db from '../services/monitorDatabaseService';

const logger = createLogger('llm-reply');
const router = Router();

// ============================================================
// POST /generate — 单条评论生成 AI 回复建议
// ============================================================

router.post('/generate', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      commentId: z.number().int().positive(),
      serviceType: z.enum(['simple', 'intelligent']).default('simple'),
    });
    const { commentId, serviceType } = bodySchema.parse(req.body);

    // 查询评论 + 视频信息
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        video: { select: { description: true, userId: true } },
      },
    });

    if (!comment) {
      return res.status(404).json({ success: false, error: `评论不存在: ${commentId}` });
    }

    // 获取父评论文本（如果是 level 2）
    let parentCommentText: string | undefined;
    let rootCommentText: string | undefined;
    if (comment.level === 2 && comment.parentId) {
      const parent = await prisma.comment.findFirst({
        where: { cid: comment.parentId },
        select: { text: true },
      });
      parentCommentText = parent?.text;
    }
    if (comment.level === 2 && comment.rootId) {
      const root = await prisma.comment.findFirst({
        where: { cid: comment.rootId },
        select: { text: true },
      });
      rootCommentText = root?.text;
    }

    // 获取平台信息
    const user = await prisma.platformAccount.findUnique({
      where: { id: comment.video.userId },
      select: { platform: true },
    });

    const ctx: CommentContext = {
      text: comment.text,
      commenterName: comment.userNickname,
      platform: user?.platform || 'unknown',
      videoDescription: comment.video.description,
      parentCommentText,
      rootCommentText,
    };

    // 标记为 pending
    await db.updateCommentSuggestion(commentId, {
      suggestedReply: '',
      suggestionStatus: 'pending',
    });

    // 选择服务模式
    let result;
    if (serviceType === 'intelligent') {
      result = await intelligentCS.generateReply(ctx);
    } else {
      result = await replyGenerator.generateReply(ctx);
    }

    if (result.success && result.reply) {
      await db.updateCommentSuggestion(commentId, {
        suggestedReply: result.reply,
        suggestionStatus: 'ready',
        suggestionModel: result.model,
        suggestionLatencyMs: result.latencyMs,
      });

      logger.info({ commentId, model: result.model, latencyMs: result.latencyMs }, 'AI 回复建议已生成');
      return res.json({
        success: true,
        data: {
          commentId,
          suggestedReply: result.reply,
          model: result.model,
          latencyMs: result.latencyMs,
        },
      });
    } else {
      await db.markSuggestionError(commentId, result.error || '未知错误');
      logger.warn({ commentId, error: result.error }, 'AI 回复生成失败');
      return res.status(502).json({ success: false, error: result.error || 'LLM 生成失败' });
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '生成 AI 回复失败');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /regenerate — 重新生成回复建议
// ============================================================

router.post('/regenerate', async (req: Request, res: Response) => {
  try {
    const bodySchema = z.object({
      commentId: z.number().int().positive(),
      previousReply: z.string().default(''),
      feedback: z.string().optional(),
      serviceType: z.enum(['simple', 'intelligent']).default('simple'),
    });
    const { commentId, previousReply, feedback, serviceType } = bodySchema.parse(req.body);

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        video: { select: { description: true, userId: true } },
      },
    });

    if (!comment) {
      return res.status(404).json({ success: false, error: `评论不存在: ${commentId}` });
    }

    let parentCommentText: string | undefined;
    let rootCommentText: string | undefined;
    if (comment.level === 2 && comment.parentId) {
      const parent = await prisma.comment.findFirst({ where: { cid: comment.parentId }, select: { text: true } });
      parentCommentText = parent?.text;
    }
    if (comment.level === 2 && comment.rootId) {
      const root = await prisma.comment.findFirst({ where: { cid: comment.rootId }, select: { text: true } });
      rootCommentText = root?.text;
    }

    const user = await prisma.platformAccount.findUnique({
      where: { id: comment.video.userId },
      select: { platform: true },
    });

    const ctx: CommentContext = {
      text: comment.text,
      commenterName: comment.userNickname,
      platform: user?.platform || 'unknown',
      videoDescription: comment.video.description,
      parentCommentText,
      rootCommentText,
    };

    // 标记 pending
    await db.updateCommentSuggestion(commentId, {
      suggestedReply: '',
      suggestionStatus: 'pending',
    });

    let result;
    if (serviceType === 'intelligent') {
      result = await intelligentCS.generateReply(ctx);
    } else {
      result = await replyGenerator.regenerateReply(ctx, previousReply || comment.suggestedReply || '', feedback);
    }

    if (result.success && result.reply) {
      await db.updateCommentSuggestion(commentId, {
        suggestedReply: result.reply,
        suggestionStatus: 'ready',
        suggestionModel: result.model,
        suggestionLatencyMs: result.latencyMs,
      });

      logger.info({ commentId, model: result.model, latencyMs: result.latencyMs }, 'AI 回复已重新生成');
      return res.json({
        success: true,
        data: {
          commentId,
          suggestedReply: result.reply,
          model: result.model,
          latencyMs: result.latencyMs,
        },
      });
    } else {
      await db.markSuggestionError(commentId, result.error || '未知错误');
      return res.status(502).json({ success: false, error: result.error || 'LLM 生成失败' });
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '重新生成 AI 回复失败');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /status/:commentId — 获取评论建议状态
// ============================================================

router.get('/status/:commentId', async (req: Request, res: Response) => {
  try {
    const commentId = parseInt(req.params.commentId as string, 10);
    if (isNaN(commentId)) {
      return res.status(400).json({ success: false, error: '无效的 commentId' });
    }

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        suggestedReply: true,
        suggestionStatus: true,
        suggestionModel: true,
        suggestionLatencyMs: true,
        suggestionAt: true,
        replyStatus: true,
        repliedAt: true,
      },
    });

    if (!comment) {
      return res.status(404).json({ success: false, error: '评论不存在' });
    }

    res.json({ success: true, data: comment });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
