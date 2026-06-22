// @ts-api-gateway/services/llmService.ts
// LLM 客服核心服务 — 封装 LiteLLM (OpenAI-compatible) 调用

import axios, { type AxiosInstance } from 'axios';
import { loadConfig } from '@social-media/shared-config';
import { createLogger } from '../lib/logger';
import { SIMPLE_CS_SYSTEM_PROMPT, LLM_DEFAULTS } from '../config/prompts';
import { getAiReplyConfig } from '../lib/aiReplyConfig';

const logger = createLogger('llm-service');

// ============================================================
// 类型定义
// ============================================================

export interface CommentContext {
  /** 评论文本 */
  text: string;
  /** 评论者昵称 */
  commenterName: string;
  /** 平台名 */
  platform: string;
  /** 视频描述 */
  videoDescription?: string;
  /** 父评论文本（level 2 回复时） */
  parentCommentText?: string;
  /** 根评论文本 */
  rootCommentText?: string;
}

export interface GenerateReplyResult {
  success: boolean;
  reply?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================================
// LLMClient — 轻量 OpenAI-compatible 客户端
// ============================================================

class LLMClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    const config = loadConfig();
    this.baseUrl = config.LITELLM_URL || 'http://localhost:4000';
    this.apiKey = config.LITELLM_API_KEY || '';

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      timeout: LLM_DEFAULTS.timeoutMs,
    });
  }

  /**
   * 调用 /v1/chat/completions
   */
  async chatCompletion(
    messages: ChatMessage[],
    options?: { model?: string; temperature?: number; maxTokens?: number },
  ): Promise<{ content: string; model: string; latencyMs: number }> {
    const aiConfig = getAiReplyConfig();
    const model = options?.model || aiConfig.model;
    const startTime = Date.now();

    const response = await this.client.post('/v1/chat/completions', {
      model,
      messages,
      temperature: options?.temperature ?? aiConfig.temperature,
      max_tokens: options?.maxTokens ?? aiConfig.maxTokens,
      stream: false,
    });

    const latencyMs = Date.now() - startTime;
    const choice = response.data?.choices?.[0];
    const content = choice?.message?.content || '';
    const actualModel = response.data?.model || model;

    return { content: content.trim(), model: actualModel, latencyMs };
  }

  /**
   * 健康检查 — 尝试 1-token completion
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; model: string; error?: string }> {
    const startTime = Date.now();
    try {
      const result = await this.chatCompletion(
        [{ role: 'user', content: 'Hi' }],
        { maxTokens: 5 },
      );
      return { ok: true, latencyMs: Date.now() - startTime, model: result.model };
    } catch (err: any) {
      return {
        ok: false,
        latencyMs: Date.now() - startTime,
        model: LLM_DEFAULTS.model,
        error: err?.response?.data?.error?.message || err.message,
      };
    }
  }

  /**
   * 获取可用模型列表
   */
  async listModels(): Promise<Array<{ id: string; owned_by: string }>> {
    try {
      const response = await this.client.get('/v1/models');
      return (response.data?.data || []).map((m: any) => ({
        id: m.id,
        owned_by: m.owned_by || 'unknown',
      }));
    } catch (err: any) {
      logger.error({ err: err.message }, '获取模型列表失败');
      return [];
    }
  }
}

// ============================================================
// 并发信号量
// ============================================================

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

// ============================================================
// CommentReplyGenerator — 评论回复生成器
// ============================================================

class CommentReplyGenerator {
  private semaphore: Semaphore;

  constructor(private client: LLMClient) {
    this.semaphore = new Semaphore(LLM_DEFAULTS.maxConcurrency);
  }

  /**
   * 获取当前 AI 回复配置（供前端展示）
   */
  getConfig() {
    const cfg = getAiReplyConfig();
    return {
      model: cfg.model || LLM_DEFAULTS.model,
      systemPrompt: cfg.systemPrompt || SIMPLE_CS_SYSTEM_PROMPT,
      temperature: cfg.temperature ?? LLM_DEFAULTS.temperature,
      maxTokens: cfg.maxTokens ?? LLM_DEFAULTS.maxTokens,
    };
  }

  /**
   * 构建用户消息（给 LLM 的输入）
   */
  private buildUserMessage(ctx: CommentContext): string {
    const parts: string[] = [];

    if (ctx.videoDescription) {
      parts.push(`视频标题：${ctx.videoDescription.slice(0, 100)}`);
    }
    if (ctx.rootCommentText && ctx.parentCommentText) {
      parts.push(`原始评论：${ctx.rootCommentText}`);
      parts.push(`${ctx.commenterName} 回复了上面的评论说：${ctx.text}`);
    } else if (ctx.parentCommentText) {
      parts.push(`原始评论：${ctx.parentCommentText}`);
      parts.push(`${ctx.commenterName} 回复说：${ctx.text}`);
    } else {
      parts.push(`${ctx.commenterName} 评论说：${ctx.text}`);
    }

    return parts.join('\n');
  }

  /**
   * 单条评论生成回复
   */
  async generateReply(
    ctx: CommentContext,
    options?: { systemPrompt?: string; model?: string },
  ): Promise<GenerateReplyResult> {
    await this.semaphore.acquire();
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: options?.systemPrompt || SIMPLE_CS_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(ctx) },
      ];

      const result = await this.client.chatCompletion(messages, {
        model: options?.model,
      });

      // 验证回复质量
      if (!result.content || result.content.length < 2) {
        return { success: false, error: 'LLM 返回内容过短', model: result.model, latencyMs: result.latencyMs };
      }

      // 截断过长回复（超过 200 字符）
      let reply = result.content;
      if (reply.length > 200) {
        reply = reply.slice(0, 197) + '...';
      }

      return {
        success: true,
        reply,
        model: result.model,
        latencyMs: result.latencyMs,
      };
    } catch (err: any) {
      const errMsg = err?.response?.data?.error?.message || err.message || '未知错误';
      logger.warn({ err: errMsg, text: ctx.text.slice(0, 50) }, 'LLM 生成回复失败');
      return { success: false, error: errMsg };
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * 重新生成回复（携带前一次回复作为历史）
   */
  async regenerateReply(
    ctx: CommentContext,
    previousReply: string,
    feedback?: string,
    options?: { systemPrompt?: string; model?: string },
  ): Promise<GenerateReplyResult> {
    await this.semaphore.acquire();
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: options?.systemPrompt || SIMPLE_CS_SYSTEM_PROMPT },
        { role: 'user', content: this.buildUserMessage(ctx) },
        { role: 'assistant', content: previousReply },
        {
          role: 'user',
          content: feedback
            ? `上次的回复不太合适，原因是：${feedback}。请重新生成一个回复。`
            : '请换一个风格重新生成回复。',
        },
      ];

      const result = await this.client.chatCompletion(messages, {
        model: options?.model,
      });

      if (!result.content || result.content.length < 2) {
        return { success: false, error: 'LLM 返回内容过短', model: result.model, latencyMs: result.latencyMs };
      }

      let reply = result.content;
      if (reply.length > 200) {
        reply = reply.slice(0, 197) + '...';
      }

      return {
        success: true,
        reply,
        model: result.model,
        latencyMs: result.latencyMs,
      };
    } catch (err: any) {
      const errMsg = err?.response?.data?.error?.message || err.message || '未知错误';
      logger.warn({ err: errMsg }, 'LLM 重新生成回复失败');
      return { success: false, error: errMsg };
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * 批量生成回复（并行，受信号量控制）
   */
  async batchGenerate(
    comments: Array<{ id: number; ctx: CommentContext }>,
    options?: { systemPrompt?: string; model?: string },
  ): Promise<Array<{ id: number; result: GenerateReplyResult }>> {
    const results = await Promise.allSettled(
      comments.map(async ({ id, ctx }) => {
        const result = await this.generateReply(ctx, options);
        return { id, result };
      }),
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        id: comments[i].id,
        result: { success: false, error: r.reason?.message || '批量生成异常' },
      };
    });
  }
}

// ============================================================
// 单例导出
// ============================================================

const llmClient = new LLMClient();
const replyGenerator = new CommentReplyGenerator(llmClient);

export { llmClient, replyGenerator, LLMClient, CommentReplyGenerator };
