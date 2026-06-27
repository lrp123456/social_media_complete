'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

export interface KeyChip {
  key: string;
  masked: string;
  cooledDown: boolean;
  cooldownRemaining: number;
}

export function KeyPoolEditor({
  keys,
  placeholder,
  onChange,
  keyChips,
}: {
  keys: string[];
  placeholder: string;
  onChange: (keys: string[]) => void;
  keyChips?: KeyChip[];
}) {
  const [newKey, setNewKey] = useState('');

  const addKey = () => {
    if (!newKey.trim()) return;
    if (keys.includes(newKey.trim())) return;
    onChange([...keys, newKey.trim()]);
    setNewKey('');
  };

  const removeKey = (idx: number) => {
    onChange(keys.filter((_, i) => i !== idx));
  };

  const maskKey = (k: string) =>
    k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k;

  const chipInfo = (k: string): KeyChip | undefined =>
    keyChips?.find((c) => c.key === k);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-on-surface-variant shrink-0">占位符</span>
        <code className="form-input flex-1 font-mono text-sm bg-surface-container">
          {'{{' + placeholder + '}}'}
        </code>
      </div>

      <div className="flex flex-wrap gap-2">
        {keys.map((k, i) => {
          const info = chipInfo(k);
          const cooled = info?.cooledDown;
          const remaining = info?.cooldownRemaining || 0;
          const remainingMin = Math.ceil(remaining / 60000);
          return (
            <div
              key={i}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-mono border transition-all ${
                cooled
                  ? 'bg-surface-container text-on-surface-variant border-outline-variant opacity-60'
                  : 'bg-primary/10 text-primary border-primary/30'
              }`}
            >
              <span>{maskKey(k)}</span>
              {cooled && (
                <span className="text-xs bg-error/10 text-error px-1.5 py-0.5 rounded">
                  冷却 {remainingMin}m
                </span>
              )}
              <button
                type="button"
                onClick={() => removeKey(i)}
                className="btn-ghost text-error shrink-0 -mr-1"
              >
                <MaterialIcon icon="close" size="xs" />
              </button>
            </div>
          );
        })}
        {keys.length === 0 && (
          <p className="text-sm text-on-surface-variant italic">尚未配置 API Key</p>
        )}
      </div>

      <div className="flex gap-2">
        <input
          className="form-input flex-1 font-mono text-sm"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKey())}
          placeholder="输入 API Key 后回车"
          type="password"
        />
        <button type="button" onClick={addKey} className="btn-secondary text-sm shrink-0">
          <MaterialIcon icon="add" size="sm" />
          添加
        </button>
      </div>
    </div>
  );
}
