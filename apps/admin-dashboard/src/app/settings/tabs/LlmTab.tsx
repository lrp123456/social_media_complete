'use client';

import { useState, useEffect, useRef } from 'react';
import {
  useLLMProviders,
  useLLMGroups,
  useUpdateLLMGroup,
  usePrompts,
  useUpdatePrompt,
  type LLMGroupConfig,
  type LLMPromptTemplate,
} from '@/hooks/useApi';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { HeaderStrip, AccentBar, BentoCard } from '@/components/ui/Bento';
import { ProviderCard } from '../shared/ProviderCard';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { StrategyBadge } from '../shared/StrategyBadge';
import { GROUP_ORDER } from '../shared/constants';

const FALLBACK_PROVIDERS = [
  { name: 'groq', displayName: 'Groq Cloud', role: 'primary', apiKeyMasked: 'gsk_xxxxxx_mock_key_xxxxxx', failoverEnabled: true, monthlyUsage: '4.2M', status: 'ok' },
  { name: 'google', displayName: 'Google Gemini', role: 'fallback_1', apiKeyMasked: 'AIzaSy_xxxxxx_mock_key_xxxxxx', failoverEnabled: true, monthlyUsage: '850K', status: 'ok' },
  { name: 'zhipu', displayName: '智谱 GLM', role: 'fallback_2', apiKeyMasked: 'zhipu_xxxxxx_mock_key_xxxxxx', failoverEnabled: false, monthlyUsage: '5.0M', status: 'error' },
];

export default function LlmTab() {
  // Panel: LLM Credentials
  const providersQuery = useLLMProviders();
  const providers = (providersQuery.data?.length ? providersQuery.data : FALLBACK_PROVIDERS) as typeof FALLBACK_PROVIDERS;
  const errorProviderCount = providers.filter((p) => p.status === 'error').length;

  // Panel: LLM Workspace — Groups
  const groupsQuery = useLLMGroups();
  const updateGroup = useUpdateLLMGroup();
  const [groupForms, setGroupForms] = useState<Record<string, LLMGroupConfig>>({});
  const groupsInitRef = useRef(false);

  // Panel: LLM Workspace — Prompts
  const promptsQuery = usePrompts();
  const updatePrompt = useUpdatePrompt();
  const [promptEdits, setPromptEdits] = useState<Record<string, string>>({});
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const promptsInitRef = useRef(false);

  // Init effects
  useEffect(() => {
    if (groupsQuery.data && !groupsInitRef.current) {
      const data = groupsQuery.data;
      const normalized: Record<string, LLMGroupConfig> = {};
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        Object.entries(data).forEach(([k, v]) => { normalized[k] = v as LLMGroupConfig; });
      }
      setGroupForms(normalized);
      groupsInitRef.current = true;
    }
  }, [groupsQuery.data]);

  useEffect(() => {
    if (promptsQuery.data && !promptsInitRef.current) {
      const edits: Record<string, string> = {};
      (promptsQuery.data as LLMPromptTemplate[]).forEach((p) => { edits[p.name] = p.content; });
      setPromptEdits(edits);
      promptsInitRef.current = true;
    }
  }, [promptsQuery.data]);

  return (
    <div className="space-y-6 p-6">
      {/* Panel: LLM Credentials */}
      <section id="panel-llm-creds" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
        <AccentBar color="tertiary" />
        <HeaderStrip>
          <div>
            <h3 className="text-headline-md text-headline-md text-on-surface">大模型路由与凭证</h3>
            <p className="font-body text-body-sm text-on-surface-variant mt-0.5">管理LLM服务供应商的API密钥、故障转移策略与用量监控。</p>
          </div>
          <StrategyBadge strategy="instant" carrier="PostgreSQL (LiteLLM 官方表)" />
        </HeaderStrip>
        <div className="p-inner-component-padding space-y-4">
          {providersQuery.isLoading ? <PanelSkeleton rows={3} /> : providersQuery.isError ? <QueryError /> : (
            providers.map((provider) => <ProviderCard key={provider.name} provider={provider} />)
          )}
        </div>
      </section>

      {/* Panel: LLM Workspace */}
      <section id="panel-llm-workspace" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
        <AccentBar color="primary" />
        <HeaderStrip>
          <div>
            <h3 className="text-headline-md text-headline-md text-on-surface">大模型参数与工作组</h3>
            <p className="font-body text-body-sm text-on-surface-variant mt-0.5">工作组路由参数与提示词模板管理。</p>
          </div>
          <StrategyBadge strategy="hot" carrier="PostgreSQL + Redis Cache" />
        </HeaderStrip>
        <div className="p-inner-component-padding space-y-6">
          {/* Sub-section a: Groups */}
          <div>
            <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">工作组路由参数</h4>
            {groupsQuery.isLoading ? <PanelSkeleton rows={3} /> : groupsQuery.isError ? <QueryError /> : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-bento-gap">
                {GROUP_ORDER.map((name) => {
                  const group = groupForms[name] || { default_model: '', temperature: 0.7, max_tokens: 2048 };
                  return (
                    <BentoCard key={name} className="space-y-3">
                      <h5 className="text-label-md text-label-md text-on-surface capitalize">{name}</h5>
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">默认模型</label>
                        <input className="form-input font-mono text-sm" value={group.default_model} onChange={(e) => setGroupForms((prev) => ({ ...prev, [name]: { ...group, default_model: e.target.value } }))} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Temperature ({group.temperature})</label>
                        <input type="range" min="0" max="2" step="0.1" value={group.temperature} onChange={(e) => setGroupForms((prev) => ({ ...prev, [name]: { ...group, temperature: parseFloat(e.target.value) } }))} className="w-full" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Max Tokens</label>
                        <input type="number" className="form-input font-mono text-sm" value={group.max_tokens} onChange={(e) => setGroupForms((prev) => ({ ...prev, [name]: { ...group, max_tokens: parseInt(e.target.value) || 0 } }))} />
                      </div>
                      <div className="flex justify-end">
                        <button onClick={() => updateGroup.mutate({ name, ...group })} disabled={updateGroup.isPending} className="btn-secondary text-sm">
                          <MaterialIcon icon="save" size="sm" />
                          {updateGroup.isPending ? '保存中…' : '保存'}
                        </button>
                      </div>
                    </BentoCard>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-outline-variant" />

          {/* Sub-section b: Prompts */}
          <div>
            <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">提示词模板</h4>
            {promptsQuery.isLoading ? <PanelSkeleton rows={4} /> : promptsQuery.isError ? <QueryError /> : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-bento-gap">
                {(promptsQuery.data || []).map((prompt: LLMPromptTemplate) => (
                  <div
                    key={prompt.name}
                    className="bento-card cursor-pointer"
                    onClick={() => setExpandedPrompt(expandedPrompt === prompt.name ? null : prompt.name)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-mono text-sm text-on-surface">{prompt.name}</span>
                      <span className="text-[11px] text-on-surface-variant shrink-0">{prompt.updatedAt}</span>
                    </div>
                    <p className="text-body-sm text-on-surface-variant line-clamp-2 mt-1">{prompt.content}</p>
                    {expandedPrompt === prompt.name && (
                      <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                        <textarea
                          className="form-input font-mono text-sm h-32"
                          value={promptEdits[prompt.name] ?? prompt.content}
                          onChange={(e) => setPromptEdits((prev) => ({ ...prev, [prompt.name]: e.target.value }))}
                        />
                        <div className="flex justify-end">
                          <button
                            onClick={() => { updatePrompt.mutate({ name: prompt.name, content: promptEdits[prompt.name] || prompt.content }); setExpandedPrompt(null); }}
                            disabled={updatePrompt.isPending}
                            className="btn-primary text-sm"
                          >
                            <MaterialIcon icon="save" size="sm" />
                            {updatePrompt.isPending ? '保存中…' : '保存'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
