import { LLM_DEFAULTS, SIMPLE_CS_SYSTEM_PROMPT } from '../config/prompts';

export interface AiReplyConfig {
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

let aiReplyConfig: AiReplyConfig = {
  model: LLM_DEFAULTS.model,
  systemPrompt: SIMPLE_CS_SYSTEM_PROMPT,
  temperature: LLM_DEFAULTS.temperature,
  maxTokens: LLM_DEFAULTS.maxTokens,
};

export function getAiReplyConfig(): AiReplyConfig {
  return { ...aiReplyConfig };
}

export function setAiReplyConfig(cfg: Partial<AiReplyConfig>): AiReplyConfig {
  if (cfg.model !== undefined) aiReplyConfig.model = cfg.model;
  if (cfg.systemPrompt !== undefined) aiReplyConfig.systemPrompt = cfg.systemPrompt;
  if (cfg.temperature !== undefined) aiReplyConfig.temperature = cfg.temperature;
  if (cfg.maxTokens !== undefined) aiReplyConfig.maxTokens = cfg.maxTokens;
  return getAiReplyConfig();
}
