// @ts-api-gateway/routes/llm.ts - LLM Provider 管理 API

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '../lib/logger';

const router = Router();
const logger = createLogger('routes:llm');

// ============================================================
// 硬编码 Provider 配置（对应 design 图 LLM Key 卡片）
// ============================================================

const PROVIDERS = [
  {
    name: 'groq' as const,
    displayName: 'GroqCloud',
    role: 'primary' as const,
    apiKeyMasked: 'gsk_xxxxxx_mock_key_xxxxxx',
    failoverEnabled: true,
    monthlyUsage: { used: 450000, total: 1000000 },
    status: 'healthy' as const,
  },
  {
    name: 'google' as const,
    displayName: 'Google Gemini',
    role: 'fallback_1' as const,
    apiKeyMasked: 'AIza_xxxxxx_mock_key_xxxxxx',
    failoverEnabled: true,
    monthlyUsage: { used: 120000, total: 1000000 },
    status: 'healthy' as const,
  },
  {
    name: 'zhipu' as const,
    displayName: '智谱AI',
    role: 'fallback_2' as const,
    apiKeyMasked: 'zp_xxxxxx_mock_key_xxxxxx',
    failoverEnabled: false,
    monthlyUsage: { used: 980000, total: 1000000 },
    status: 'quota_exceeded' as const,
  },
];

/** GET /api/v1/llm/providers - LLM Provider 列表 */
router.get('/providers', async (_req: Request, res: Response) => {
  res.json({ success: true, data: PROVIDERS });
});

/** POST /api/v1/llm/providers/:name/test - 测试连接 */
router.post('/providers/:name/test', async (req: Request, res: Response) => {
  try {
    const paramsSchema = z.object({
      name: z.enum(['groq', 'google', 'zhipu']),
    });
    const { name } = paramsSchema.parse(req.params);

    // 模拟 150-450ms 随机延迟
    const latencyMs = Math.floor(Math.random() * 300) + 150;
    await new Promise((resolve) => setTimeout(resolve, latencyMs));

    if (name === 'zhipu') {
      // zhipu 始终返回 false 模拟超额
      return res.json({
        success: true,
        data: {
          success: false,
          latencyMs,
          message: '配额已用完，请续费或切换到其他 Provider',
        },
      });
    }

    res.json({
      success: true,
      data: {
        success: true,
        latencyMs,
        message: '连接成功',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: err.errors });
    }
    logger.error({ err: (err as Error).message }, '测试 LLM 连接失败');
    res.status(500).json({ success: false, error: (err as Error).message });
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
