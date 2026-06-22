import { Router, Request, Response } from 'express';
import { getAiReplyConfig, setAiReplyConfig } from '../lib/aiReplyConfig';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: getAiReplyConfig() });
});

router.put('/', (req: Request, res: Response) => {
  const { model, systemPrompt, temperature, maxTokens } = req.body;
  const updated = setAiReplyConfig({ model, systemPrompt, temperature, maxTokens });
  res.json({ success: true, data: updated, message: 'AI 回复配置已更新' });
});

export default router;
