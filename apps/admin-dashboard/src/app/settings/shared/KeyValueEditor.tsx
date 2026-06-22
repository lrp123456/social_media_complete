'use client';

import { useMemo } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

export function KeyValueEditor({
  value,
  onChange,
  preseedKeys,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  preseedKeys?: string[];
}) {
  const entries = useMemo(() => {
    const map = new Map<string, string>();
    preseedKeys?.forEach((k) => map.set(k, value[k] || ''));
    Object.entries(value).forEach(([k, v]) => {
      if (!map.has(k)) map.set(k, v);
    });
    return Array.from(map.entries()).map(([key, val]) => ({ key, value: val }));
  }, [value, preseedKeys]);

  const updateEntry = (index: number, field: 'key' | 'value', newVal: string) => {
    const next = entries.map((e, i) => (i === index ? { ...e, [field]: newVal } : e));
    const record: Record<string, string> = {};
    next.forEach((e) => { if (e.key) record[e.key] = e.value; });
    onChange(record);
  };

  const addEntry = () => {
    onChange({ ...value, '': '' });
  };

  const removeEntry = (index: number) => {
    const next = entries.filter((_, i) => i !== index);
    const record: Record<string, string> = {};
    next.forEach((e) => { if (e.key) record[e.key] = e.value; });
    onChange(record);
  };

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <div key={`${entry.key}-${i}`} className="flex gap-2 items-center">
          <input
            className="form-input flex-1 font-mono text-sm"
            value={entry.key}
            onChange={(e) => updateEntry(i, 'key', e.target.value)}
            placeholder="键"
          />
          <input
            className="form-input flex-[2] font-mono text-sm"
            value={entry.value}
            onChange={(e) => updateEntry(i, 'value', e.target.value)}
            placeholder="值"
          />
          <button
            type="button"
            onClick={() => removeEntry(i)}
            className="btn-ghost text-error shrink-0"
          >
            <MaterialIcon icon="delete" size="sm" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addEntry} className="btn-secondary text-sm">
        <MaterialIcon icon="add" size="sm" />
        新增
      </button>
    </div>
  );
}
