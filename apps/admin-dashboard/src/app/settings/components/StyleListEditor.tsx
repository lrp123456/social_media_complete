'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

export interface StyleDef {
  name: string;
  dir: string;
  keywords: string[];
  platformOverrides?: Record<string, string[]>;
}

export function StyleListEditor({
  styles,
  platforms,
  onChange,
}: {
  styles: StyleDef[];
  platforms: { id: string; name: string }[];
  onChange: (styles: StyleDef[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const addStyle = () => {
    onChange([...styles, { name: '', dir: '', keywords: [] }]);
  };

  const updateStyle = (idx: number, field: keyof StyleDef, value: string | string[] | Record<string, string[]>) => {
    const next = [...styles];
    if (field === 'keywords') {
      next[idx] = { ...next[idx], keywords: (value as string).split(/[,，]/).map((s) => s.trim()).filter(Boolean) };
    } else {
      next[idx] = { ...next[idx], [field]: value };
    }
    onChange(next);
  };

  const updatePlatformOverride = (idx: number, platformId: string, raw: string) => {
    const keywords = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const nextOverrides = { ...(styles[idx].platformOverrides || {}) };
    if (keywords.length === 0) {
      delete nextOverrides[platformId];
    } else {
      nextOverrides[platformId] = keywords;
    }
    updateStyle(idx, 'platformOverrides', nextOverrides);
  };

  const removeStyle = (idx: number) => {
    onChange(styles.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      {styles.map((style, i) => (
        <div key={i} className="p-3 rounded-lg border border-outline-variant bg-surface-container-lowest">
          <div className="flex gap-2 items-start">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 flex-1">
              <input
                className="form-input text-sm"
                value={style.name}
                onChange={(e) => updateStyle(i, 'name', e.target.value)}
                placeholder="风格名称"
              />
              <input
                className="form-input text-sm font-mono"
                value={style.dir}
                onChange={(e) => updateStyle(i, 'dir', e.target.value)}
                placeholder="落盘目录名"
              />
              <input
                className="form-input text-sm"
                value={style.keywords.join(', ')}
                onChange={(e) => updateStyle(i, 'keywords', e.target.value)}
                placeholder="关键词(逗号分隔)"
              />
            </div>
            <button
              type="button"
              onClick={() => removeStyle(i)}
              className="btn-ghost text-error shrink-0 mt-1"
            >
              <MaterialIcon icon="delete" size="sm" />
            </button>
          </div>

          {platforms.length > 0 && (
            <div className="mt-2 pt-2 border-t border-outline-variant/50">
              <button
                type="button"
                onClick={() => toggleExpand(i)}
                className="btn-ghost text-xs text-on-surface-variant"
              >
                <MaterialIcon icon={expanded[i] ? 'expand_less' : 'expand_more'} size="sm" />
                按平台覆盖关键词
              </button>
              {expanded[i] && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                  {platforms.map((p) => {
                    const override = style.platformOverrides?.[p.id];
                    return (
                      <div key={p.id} className="flex items-center gap-2">
                        <label className="text-xs text-on-surface-variant w-20 shrink-0 truncate" title={p.name}>
                          {p.name}
                        </label>
                        <input
                          className="form-input text-sm flex-1"
                          value={override?.join(', ') || ''}
                          onChange={(e) => updatePlatformOverride(i, p.id, e.target.value)}
                          placeholder={style.keywords.join(', ') || '空则回退统一关键词'}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <button type="button" onClick={addStyle} className="btn-secondary text-sm">
        <MaterialIcon icon="add" size="sm" />
        新增风格
      </button>
    </div>
  );
}
