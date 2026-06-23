import { LLM_DEFAULTS, SIMPLE_CS_SYSTEM_PROMPT } from '../config/prompts';
import { getSection, saveSection } from './settingsStore';

export interface AiReplyConfig {
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

const aiReplyDefaults: AiReplyConfig = {
  model: LLM_DEFAULTS.model,
  systemPrompt: SIMPLE_CS_SYSTEM_PROMPT,
  temperature: LLM_DEFAULTS.temperature,
  maxTokens: LLM_DEFAULTS.maxTokens,
};

let aiReplyConfig: AiReplyConfig = getSection('aiReply', aiReplyDefaults);

export function getAiReplyConfig(): AiReplyConfig {
  return { ...aiReplyConfig };
}

export function setAiReplyConfig(cfg: Partial<AiReplyConfig>): AiReplyConfig {
  if (cfg.model !== undefined) aiReplyConfig.model = cfg.model;
  if (cfg.systemPrompt !== undefined) aiReplyConfig.systemPrompt = cfg.systemPrompt;
  if (cfg.temperature !== undefined) aiReplyConfig.temperature = cfg.temperature;
  if (cfg.maxTokens !== undefined) aiReplyConfig.maxTokens = cfg.maxTokens;
  saveSection('aiReply', aiReplyConfig);
  return getAiReplyConfig();
}
