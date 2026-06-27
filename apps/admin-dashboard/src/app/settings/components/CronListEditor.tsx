'use client';

import { useMemo } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';

export function CronListEditor({
  crons,
  onChange,
}: {
  crons: string[];
  onChange: (crons: string[]) => void;
}) {
  const addCron = () => {
    onChange([...crons, '0 3 * * *']);
  };

  const updateCron = (idx: number, value: string) => {
    const next = [...crons];
    next[idx] = value;
    onChange(next);
  };

  const removeCron = (idx: number) => {
    onChange(crons.filter((_, i) => i !== idx));
  };

  const nextRunPreview = useMemo(() => {
    if (crons.length === 0) return null;
    const valid = crons.filter((c) => c.trim().split(/\s+/).length >= 5);
    return valid.length > 0 ? `${valid.length} 个有效表达式` : '无有效表达式';
  }, [crons]);

  return (
    <div className="space-y-3">
      {crons.map((cron, i) => (
        <div key={i} className="flex gap-2 items-center">
          <code className="form-input flex-1 font-mono text-sm" contentEditable={false}>
            <input
              className="w-full bg-transparent font-mono text-sm outline-none"
              value={cron}
              onChange={(e) => updateCron(i, e.target.value)}
              placeholder="分 时 日 月 周 (如: 7 3 * * 1)"
            />
          </code>
          <button
            type="button"
            onClick={() => removeCron(i)}
            className="btn-ghost text-error shrink-0"
          >
            <MaterialIcon icon="delete" size="sm" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button type="button" onClick={addCron} className="btn-secondary text-sm">
          <MaterialIcon icon="add" size="sm" />
          新增 cron
        </button>
        {nextRunPreview && (
          <span className="text-sm text-on-surface-variant">{nextRunPreview}</span>
        )}
      </div>
      <p className="text-xs text-on-surface-variant">
        格式: 分 时 日 月 周 · 示例 <code className="font-mono">7 3 * * 1</code> = 每周一 03:07
      </p>
    </div>
  );
}
