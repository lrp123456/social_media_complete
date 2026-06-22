'use client';

import { useState, useEffect, useRef } from 'react';
import { BentoCard } from '@/components/ui/Bento';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { useAiReplyConfig, useUpdateAiReplyConfig } from '@/hooks/useApi';

interface AiReplyForm {
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

const DEFAULT_VALUES: AiReplyForm = {
  model: 'group-stable-text',
  systemPrompt: `你是一个专业的社交媒体客服助手，负责回复用户评论。

回复要求：
1. 保持友好、专业的语气
2. 针对评论内容给出具体回应
3. 适当引导用户关注或互动
4. 回复简洁明了，不超过 200 字
5. 避免过于机械或模板化的回复`,
  temperature: 0.7,
  maxTokens: 300,
};

export default function AiReplyConfigPanel() {
  const { data, isLoading, isError } = useAiReplyConfig();
  const updateMutation = useUpdateAiReplyConfig();

  const [form, setForm] = useState<AiReplyForm>(DEFAULT_VALUES);
  const initRef = useRef(false);

  useEffect(() => {
    if (data && !initRef.current) {
      setForm({
        model: data.model ?? DEFAULT_VALUES.model,
        systemPrompt: data.systemPrompt ?? DEFAULT_VALUES.systemPrompt,
        temperature: data.temperature ?? DEFAULT_VALUES.temperature,
        maxTokens: data.maxTokens ?? DEFAULT_VALUES.maxTokens,
      });
      initRef.current = true;
    }
  }, [data]);

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync(form);
    } catch (e) {
      console.error('保存 AI 回复配置失败', e);
    }
  };

  const handleReset = async () => {
    setForm(DEFAULT_VALUES);
    try {
      await updateMutation.mutateAsync(DEFAULT_VALUES);
    } catch (e) {
      console.error('重置 AI 回复配置失败', e);
    }
  };

  if (isLoading) {
    return (
      <BentoCard>
        <h3 className="text-headline-md text-on-surface mb-4">AI 回复评论配置</h3>
        <PanelSkeleton rows={4} />
      </BentoCard>
    );
  }

  if (isError) {
    return (
      <BentoCard>
        <h3 className="text-headline-md text-on-surface mb-4">AI 回复评论配置</h3>
        <QueryError />
      </BentoCard>
    );
  }

  return (
    <BentoCard>
      <div className="flex items-center gap-2 mb-4">
        <MaterialIcon icon="psychology" size="md" className="text-primary" />
        <h3 className="text-headline-md text-on-surface">AI 回复评论配置</h3>
      </div>

      <div className="space-y-4">
        {/* 模型名 */}
        <div className="space-y-1">
          <label className="text-label-md text-on-surface-variant">模型名</label>
          <input
            type="text"
            className="form-input font-mono text-sm w-full"
            value={form.model}
            onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
            placeholder="group-stable-text"
          />
        </div>

        {/* Temperature + Max Tokens 并排 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-label-md text-on-surface-variant">Temperature (0–2)</label>
            <input
              type="number"
              className="form-input font-mono text-sm w-full"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setForm((prev) => ({ ...prev, temperature: isNaN(v) ? 0 : Math.max(0, Math.min(2, v)) }));
              }}
            />
          </div>
          <div className="space-y-1">
            <label className="text-label-md text-on-surface-variant">Max Tokens (1–4096)</label>
            <input
              type="number"
              className="form-input font-mono text-sm w-full"
              min={1}
              max={4096}
              value={form.maxTokens}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                setForm((prev) => ({ ...prev, maxTokens: isNaN(v) ? 1 : Math.max(1, Math.min(4096, v)) }));
              }}
            />
          </div>
        </div>

        {/* 系统提示词 */}
        <div className="space-y-1">
          <label className="text-label-md text-on-surface-variant">系统提示词</label>
          <textarea
            className="form-input font-mono text-sm w-full"
            style={{ minHeight: '200px' }}
            value={form.systemPrompt}
            onChange={(e) => setForm((prev) => ({ ...prev, systemPrompt: e.target.value }))}
          />
        </div>
      </div>

      {/* 按钮 */}
      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={handleReset}
          disabled={updateMutation.isPending}
          className="btn-secondary px-6 py-2 text-sm disabled:opacity-40"
        >
          重置为默认
        </button>
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="btn-primary px-6 py-2 text-sm disabled:opacity-40"
        >
          {updateMutation.isPending ? '保存中…' : '保存配置'}
        </button>
      </div>
    </BentoCard>
  );
}
