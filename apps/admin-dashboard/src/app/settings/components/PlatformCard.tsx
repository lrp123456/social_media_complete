'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { AccentBar } from '@/components/ui/Bento';
import { KeyValueEditor } from '../shared/KeyValueEditor';
import { FieldMapEditor } from './FieldMapEditor';
import { KeyPoolEditor, type KeyChip } from './KeyPoolEditor';
import type { Platform } from '@/types/material';

const PLATFORM_COLORS: Record<string, string> = {
  douyin: 'error',
  xiaohongshu: 'error',
  kuaishou: 'warning',
  bilibili: 'primary',
  tiktok: 'success',
};
const DEFAULT_COLOR = 'primary';

export function PlatformCard({
  platform,
  onChange,
  onRemove,
  onTest,
  testing,
  testResult,
  keyChips,
}: {
  platform: Platform;
  onChange: (p: Platform) => void;
  onRemove: () => void;
  onTest: () => void;
  testing: boolean;
  testResult: { videoCount: number; videos: any[] } | null;
  keyChips?: KeyChip[];
}) {
  const [expanded, setExpanded] = useState(true);
  const colorName = PLATFORM_COLORS[platform.id.split('_')[0]] || DEFAULT_COLOR;

  const update = (patch: Partial<Platform>) => {
    onChange({ ...platform, ...patch });
  };

  const updateRequest = (patch: Partial<Platform['request']>) => {
    update({ request: { ...platform.request, ...patch } });
  };

  const updateParse = (patch: Partial<Platform['parse']>) => {
    update({ parse: { ...platform.parse, ...patch } });
  };

  return (
    <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
      <AccentBar color={colorName as any} />
      <div className="flex items-center gap-3 p-4 border-b border-outline-variant">
        <button type="button" onClick={() => setExpanded(!expanded)} className="btn-ghost shrink-0">
          <MaterialIcon icon={expanded ? 'expand_more' : 'chevron_right'} size="sm" />
        </button>
        <input
          className="form-input flex-1 text-sm font-medium"
          value={platform.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="平台名称"
        />
        <code className="text-xs text-on-surface-variant font-mono">{platform.id}</code>
        <button
          type="button"
          onClick={() => update({ enabled: !platform.enabled })}
          className={`toggle-track ${platform.enabled ? 'bg-primary' : 'bg-surface-container-high'}`}
        >
          <span className={`toggle-thumb ${platform.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
        <button type="button" onClick={onRemove} className="btn-ghost text-error shrink-0">
          <MaterialIcon icon="delete" size="sm" />
        </button>
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          <div>
            <h4 className="text-sm font-semibold mb-2 text-on-surface">请求配置</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
              <select
                className="form-input text-sm"
                value={platform.request.method}
                onChange={(e) => updateRequest({ method: e.target.value as 'GET' | 'POST' })}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
              <input
                className="form-input text-sm font-mono"
                value={platform.request.url}
                onChange={(e) => updateRequest({ url: e.target.value })}
                placeholder="https://api.example.com/...?term={{PAGE}}"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Headers</label>
                <KeyValueEditor value={platform.request.headers} onChange={(v) => updateRequest({ headers: v })} />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Params</label>
                <KeyValueEditor value={platform.request.params} onChange={(v) => updateRequest({ params: v })} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">分页数</label>
                <input type="number" className="form-input text-sm" value={platform.request.maxPages} onChange={(e) => updateRequest({ maxPages: parseInt(e.target.value) || 1 })} min={1} max={10} />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">超时(ms)</label>
                <input type="number" className="form-input text-sm" value={platform.request.timeoutMs} onChange={(e) => updateRequest({ timeoutMs: parseInt(e.target.value) || 30000 })} step={1000} />
              </div>
              <div>
                <label className="text-xs text-on-surface-variant mb-1 block">Body (JSON)</label>
                <input className="form-input text-sm font-mono" value={platform.request.body || ''} onChange={(e) => updateRequest({ body: e.target.value || null })} placeholder="null" />
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-2 text-on-surface">Key 池</h4>
            <KeyPoolEditor keys={platform.keyPool.keys} placeholder={platform.keyPool.placeholder} onChange={(keys) => update({ keyPool: { ...platform.keyPool, keys } })} keyChips={keyChips} />
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-2 text-on-surface">解析配置</h4>
            <div className="mb-2">
              <label className="text-xs text-on-surface-variant mb-1 block">列表路径 (点路径)</label>
              <input className="form-input text-sm font-mono" value={platform.parse.listPath} onChange={(e) => updateParse({ listPath: e.target.value })} placeholder="data.videos" />
            </div>
            <div>
              <label className="text-xs text-on-surface-variant mb-1 block">字段映射</label>
              <FieldMapEditor
                value={platform.parse.fieldMap || {
                  videoId: '', title: '', likeCount: '', commentCount: '',
                  videoUrl: '', cover: '', author: '', publishTime: '',
                }}
                onChange={(v) => updateParse({ fieldMap: v })}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-outline-variant">
            <button type="button" onClick={onTest} disabled={testing} className="btn-primary text-sm">
              <MaterialIcon icon={testing ? 'sync' : 'api'} size="sm" spin={testing} />
              {testing ? '测试中...' : '测试请求'}
            </button>
            {testResult && (
              <div className="text-sm">
                <span className="text-on-surface-variant">解析到 </span>
                <span className="font-semibold text-primary">{testResult.videoCount}</span>
                <span className="text-on-surface-variant"> 条视频</span>
              </div>
            )}
          </div>
          {testResult && testResult.videos.length > 0 && (
            <div className="bg-surface-container rounded-lg p-3 max-h-48 overflow-y-auto">
              <pre className="text-xs font-mono text-on-surface-variant whitespace-pre-wrap">
                {JSON.stringify(testResult.videos, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
