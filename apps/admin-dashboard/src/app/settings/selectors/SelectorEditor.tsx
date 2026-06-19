'use client';

import type { ScopedSelector, FrameworkEntry, SelectorType, ScopeMode } from '@/hooks/useApi';

// ── Constants ──

const SELECTOR_TYPES: { value: SelectorType; label: string }[] = [
  { value: 'css', label: 'CSS' },
  { value: 'role', label: 'Role' },
  { value: 'text', label: 'Text' },
  { value: 'xpath', label: 'XPath' },
];

const SCOPE_MODES: { value: ScopeMode; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'framework', label: '大框架' },
  { value: 'custom', label: '自定义' },
];

// ── Props ──

type SelectorEditorProps = {
  label: string;
  selector: ScopedSelector;
  frameworks: Record<string, FrameworkEntry>;
  onChange: (s: ScopedSelector) => void;
};

// ── Component ──

export default function SelectorEditor({ label, selector, frameworks, onChange }: SelectorEditorProps) {
  const frameworkKeys = Object.keys(frameworks);

  const handleChange = (patch: Partial<ScopedSelector>) => {
    onChange({ ...selector, ...patch });
  };

  return (
    <div className="border rounded-md p-3 mb-2 bg-white/50">
      {/* Title */}
      <div className="text-label-sm font-medium text-on-surface mb-2">{label}</div>

      {/* Type + Value */}
      <div className="flex gap-2 mb-2">
        <select
          value={selector.type}
          onChange={(e) => handleChange({ type: e.target.value as SelectorType })}
          className="w-28 bg-surface border border-outline-variant rounded-lg px-2 py-1.5 text-body-sm outline-none focus:border-primary flex-shrink-0"
        >
          {SELECTOR_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <input
          value={selector.value}
          onChange={(e) => handleChange({ value: e.target.value })}
          placeholder="选择器值"
          className="flex-1 bg-surface border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm font-mono outline-none focus:border-primary"
        />
      </div>

      {/* Scope mode radio group */}
      <div className="flex items-center gap-3 mb-2">
        <span className="text-body-xs text-on-surface-variant flex-shrink-0">作用域：</span>
        <div className="flex gap-2">
          {SCOPE_MODES.map((m) => (
            <label key={m.value} className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name={`scope-${label}`}
                checked={(selector.scopeMode ?? 'none') === m.value}
                onChange={() => handleChange({ scopeMode: m.value })}
                className="accent-primary"
              />
              <span className="text-body-xs text-on-surface">{m.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Framework mode: framework dropdown + subContainer */}
      {(selector.scopeMode ?? 'none') === 'framework' && (
        <div className="flex gap-2 mb-2">
          <select
            value={selector.frameworkKey || ''}
            onChange={(e) => handleChange({ frameworkKey: e.target.value || undefined })}
            className="flex-1 bg-surface border border-outline-variant rounded-lg px-2 py-1.5 text-body-sm outline-none focus:border-primary"
          >
            <option value="">选择框架</option>
            {frameworkKeys.map((key) => (
              <option key={key} value={key}>
                {frameworks[key].label} ({key})
              </option>
            ))}
          </select>
          <input
            value={selector.subContainer || ''}
            onChange={(e) => handleChange({ subContainer: e.target.value || undefined })}
            placeholder="subContainer CSS"
            className="flex-1 bg-surface border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm font-mono outline-none focus:border-primary"
          />
        </div>
      )}

      {/* Custom mode: customContainer */}
      {(selector.scopeMode ?? 'none') === 'custom' && (
        <div className="mb-2">
          <input
            value={selector.customContainer || ''}
            onChange={(e) => handleChange({ customContainer: e.target.value || undefined })}
            placeholder="customContainer CSS"
            className="w-full bg-surface border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm font-mono outline-none focus:border-primary"
          />
        </div>
      )}

      {/* Filter row */}
      <div className="flex gap-2">
        <input
          value={selector.filterTag || ''}
          onChange={(e) => handleChange({ filterTag: e.target.value || undefined })}
          placeholder="BUTTON"
          className="flex-1 bg-surface border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm font-mono outline-none focus:border-primary"
        />
        <input
          value={selector.filterText || ''}
          onChange={(e) => handleChange({ filterText: e.target.value || undefined })}
          placeholder="发布"
          className="flex-1 bg-surface border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm font-mono outline-none focus:border-primary"
        />
      </div>
    </div>
  );
}
