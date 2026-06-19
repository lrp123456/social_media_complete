'use client';

import { useState, useRef, KeyboardEvent } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

type FieldMappingEditorProps = {
  mappings: Record<string, string[]>;
  onChange: (mappings: Record<string, string[]>) => void;
};

export default function FieldMappingEditor({ mappings, onChange }: FieldMappingEditorProps) {
  const [newFieldKey, setNewFieldKey] = useState('');
  const [addingField, setAddingField] = useState(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // ── 删除候选路径 ──
  const handleRemovePath = (field: string, pathIndex: number) => {
    const updated = { ...mappings };
    updated[field] = updated[field].filter((_, i) => i !== pathIndex);
    if (updated[field].length === 0) {
      delete updated[field];
    }
    onChange(updated);
  };

  // ── 添加候选路径 ──
  const handleAddPath = (field: string, path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    const updated = { ...mappings };
    updated[field] = [...(updated[field] || []), trimmed];
    onChange(updated);
  };

  // ── 删除字段 ──
  const handleRemoveField = (field: string) => {
    const updated = { ...mappings };
    delete updated[field];
    onChange(updated);
  };

  // ── 添加字段 ──
  const handleAddField = () => {
    const key = newFieldKey.trim();
    if (!key) return;
    if (key in mappings) return; // 避免重复 key
    const updated = { ...mappings, [key]: [] };
    onChange(updated);
    setNewFieldKey('');
    setAddingField(false);
  };

  // ── 路径输入框 Enter 处理 ──
  const handlePathInputKeyDown = (e: KeyboardEvent<HTMLInputElement>, field: string) => {
    if (e.key === 'Enter') {
      const input = e.currentTarget;
      handleAddPath(field, input.value);
      input.value = '';
    }
  };

  // ── 新增字段输入框 Enter 处理 ──
  const handleNewFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleAddField();
    }
  };

  const entries = Object.entries(mappings);

  return (
    <div className="space-y-3">
      {entries.length === 0 && !addingField && (
        <div className="text-center py-8 text-on-surface-variant">
          <MaterialIcon icon="data_array" size="xl" className="text-outline mb-2 opacity-40" />
          <p className="text-body-sm">暂无字段映射</p>
        </div>
      )}

      {entries.map(([field, paths]) => (
        <div
          key={field}
          className="flex items-start gap-3 bg-surface border border-outline-variant rounded-xl px-4 py-3"
        >
          {/* 字段名 (固定宽度 label) */}
          <div className="flex items-center gap-2 min-w-0 flex-shrink-0" style={{ width: 160 }}>
            <span className="text-label-sm font-mono font-bold text-on-surface truncate" title={field}>
              {field}
            </span>
            <span className="text-on-surface-variant/40 flex-shrink-0">&larr;</span>
          </div>

          {/* 候选路径 chips + 输入框 */}
          <div className="flex-1 flex flex-wrap items-center gap-1.5 min-w-0">
            {paths.map((path, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded text-xs text-on-surface font-mono"
              >
                <span className="truncate max-w-[200px]" title={path}>
                  {path}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemovePath(field, idx)}
                  className="text-on-surface-variant/50 hover:text-red-500 transition-colors flex-shrink-0 leading-none"
                >
                  <MaterialIcon icon="close" size="xs" />
                </button>
              </span>
            ))}

            {/* 添加路径输入框 */}
            <input
              ref={(el) => { inputRefs.current[field] = el; }}
              type="text"
              placeholder="添加路径..."
              onKeyDown={(e) => handlePathInputKeyDown(e, field)}
              className="min-w-[100px] flex-1 bg-transparent border-none outline-none text-body-xs font-mono text-on-surface placeholder:text-on-surface-variant/40 py-0.5"
            />
          </div>

          {/* 删除字段按钮 */}
          <button
            type="button"
            onClick={() => handleRemoveField(field)}
            className="flex-shrink-0 p-1 text-on-surface-variant/40 hover:text-red-500 transition-colors rounded"
            title="删除字段"
          >
            <MaterialIcon icon="delete" size="xs" />
          </button>
        </div>
      ))}

      {/* 添加字段区域 */}
      {addingField ? (
        <div className="flex items-center gap-2 bg-surface border border-dashed border-outline-variant rounded-xl px-4 py-3">
          <input
            value={newFieldKey}
            onChange={(e) => setNewFieldKey(e.target.value)}
            onKeyDown={handleNewFieldKeyDown}
            placeholder="字段名 (key)"
            className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm font-mono outline-none focus:border-primary placeholder:text-on-surface-variant/40"
            autoFocus
          />
          <button
            type="button"
            onClick={handleAddField}
            disabled={!newFieldKey.trim()}
            className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-sm font-medium hover:shadow-sm transition-all disabled:opacity-40"
          >
            添加
          </button>
          <button
            type="button"
            onClick={() => { setAddingField(false); setNewFieldKey(''); }}
            className="px-3 py-1.5 rounded-lg text-label-sm text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            取消
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAddingField(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-label-sm text-primary hover:bg-primary/5 transition-colors"
        >
          <MaterialIcon icon="add" size="xs" />
          添加字段
        </button>
      )}
    </div>
  );
}
