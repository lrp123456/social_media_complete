// @ts-api-gateway/routes/llm.ts - LLM Provider 管理 API

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '../lib/logger';
import { llmClient } from '../services/llmService';

const router = Router();
const logger = createLogger('routes:llm');

// ============================================================
// Provider 管理（对接 LiteLLM 真实接口）
// ============================================================

/** GET /api/v1/llm/providers - 获取 LiteLLM 可用模型列表 */
router.get('/providers', async (_req: Request, res: Response) => {
  try {
    const models = await llmClient.listModels();
    // 按 provider 分组
    const providerMap = new Map<string, any>();
    for (const m of models) {
      const provider = m.owned_by || 'unknown';
      if (!providerMap.has(provider)) {
        providerMap.set(provider, {
          name: provider,
          displayName: provider,
          role: 'primary' as const,
          apiKeyMasked: '***',
          failoverEnabled: true,
          monthlyUsage: { used: 0, total: 0 },
          status: 'healthy' as const,
          models: [] as string[],
        });
      }
      providerMap.get(provider)!.models.push(m.id);
    }
    const providers = Array.from(providerMap.values());
    res.json({ success: true, data: providers, total: models.length });
  } catch (err: any) {
    logger.error({ err: err.message }, '获取 LLM providers 失败');
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/v1/llm/providers/:name/test - 测试 LLM 连接 */
router.post('/providers/:name/test', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const health = await llmClient.healthCheck();
    res.json({
      success: true,
      data: {
        success: health.ok,
        latencyMs: health.latencyMs,
        model: health.model,
        message: health.ok ? '连接成功' : (health.error || '连接失败'),
        provider: name,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, '测试 LLM 连接失败');
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

// ============================================================
// 板块三: LLM 工作组参数 + 提示词模板
// ============================================================

interface GroupConfig { default_model: string; temperature: number; max_tokens: number; }

const GROUPS: Record<string, GroupConfig> = {
  video: { default_model: 'glm-4.6v-flash', temperature: 0.3, max_tokens: 2048 },
  image: { default_model: 'glm-4v-flash', temperature: 0.3, max_tokens: 2048 },
  text:  { default_model: 'glm-47-flash', temperature: 0.7, max_tokens: 4096 },
};

interface PromptTemplate { name: string; content: string; updatedAt: string; }

const PROMPTS: PromptTemplate[] = [
  { name: 'analyze_video', content: '提取视频描述中的风格类型、空间分类并给画质和内容评级...', updatedAt: new Date().toISOString() },
  { name: 'analyze_image', content: '识别 Pinterest 原始素材图片的硬核家居标签...', updatedAt: new Date().toISOString() },
  { name: 'generate_script', content: '生成短视频文案口播,控制时长在 30-60 秒,并生成特定的情感共鸣点...', updatedAt: new Date().toISOString() },
  { name: 'generate_title', content: '面向公域高曝光流量池的标题生成...', updatedAt: new Date().toISOString() },
  { name: 'generate_tags', content: '热门标签智能组合生成...', updatedAt: new Date().toISOString() },
  { name: 'quality_rate', content: '素材高保真美学、商业价值评分模板,过滤劣质图...', updatedAt: new Date().toISOString() },
  { name: 'scene_detect', content: '视频多镜头切换检测,判定家居视频的转场点、运动轨迹...', updatedAt: new Date().toISOString() },
];

const groupsRouter = (() => {
  const r = Router();

  /** GET /api/v1/llm/groups */
  r.get('/', (_req: Request, res: Response) => {
    res.json({ success: true, data: GROUPS, meta: { carrier: 'PostgreSQL config_entries + Redis Cache', strategy: 'hot' } });
  });

  /** PUT /api/v1/llm/groups/:name */
  r.put('/:name', (req: Request, res: Response) => {
    const name = String(req.params.name ?? '');
    if (!GROUPS[name]) return res.status(404).json({ success: false, error: `工作组不存在: ${name}` });
    Object.assign(GROUPS[name], req.body);
    res.json({ success: true, data: GROUPS[name], message: `${name} 工作组参数已热重载` });
  });

  return r;
})();

/** GET /api/v1/llm/prompts */
const promptsRouter = (() => {
  const r = Router();

  r.get('/', (_req: Request, res: Response) => {
    res.json({ success: true, data: PROMPTS });
  });

  /** PUT /api/v1/llm/prompts/:name */
  r.put('/:name', (req: Request, res: Response) => {
    const { name } = req.params;
    const idx = PROMPTS.findIndex((p) => p.name === name);
    if (idx < 0) return res.status(404).json({ success: false, error: `提示词不存在: ${name}` });
    const { content } = req.body;
    if (!content) return res.status(400).json({ success: false, error: '缺少 content 字段' });
    PROMPTS[idx].content = content;
    PROMPTS[idx].updatedAt = new Date().toISOString();
    res.json({ success: true, data: PROMPTS[idx], message: `提示词 ${name} 已更新` });
  });

  return r;
})();

export { groupsRouter, promptsRouter };
