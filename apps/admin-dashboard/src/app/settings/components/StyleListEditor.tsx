'use client';

import { MaterialIcon } from '@/components/ui/MaterialIcon';

export interface StyleDef {
  name: string;
  dir: string;
  keywords: string[];
}

export function StyleListEditor({
  styles,
  onChange,
}: {
  styles: StyleDef[];
  onChange: (styles: StyleDef[]) => void;
}) {
  const addStyle = () => {
    onChange([...styles, { name: '', dir: '', keywords: [] }]);
  };

  const updateStyle = (idx: number, field: keyof StyleDef, value: string | string[]) => {
    const next = [...styles];
    if (field === 'keywords') {
      next[idx] = { ...next[idx], keywords: (value as string).split(/[,，]/).map((s) => s.trim()).filter(Boolean) };
    } else {
      next[idx] = { ...next[idx], [field]: value };
    }
    onChange(next);
  };

  const removeStyle = (idx: number) => {
    onChange(styles.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      {styles.map((style, i) => (
        <div key={i} className="flex gap-2 items-start p-3 rounded-lg border border-outline-variant bg-surface-container-lowest">
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
      ))}
      <button type="button" onClick={addStyle} className="btn-secondary text-sm">
        <MaterialIcon icon="add" size="sm" />
        新增风格
      </button>
    </div>
  );
}
