'use client';

import { cn } from '@/lib/utils';
import type { ScopedSelector, FrameworkEntry, SelectorType, ScopeMode } from '@/hooks/useApi';

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

export function SelectorEditor({
  label,
  selector,
  frameworks,
  onChange,
}: {
  label: string;
  selector: ScopedSelector;
  frameworks: Record<string, FrameworkEntry>;
  onChange: (s: ScopedSelector) => void;
}) {
  const fwEntries = Object.entries(frameworks);

  return (
    <div className="border rounded-md p-3 mb-2 bg-white/50">
      <div className="text-xs text-gray-500 mb-2">{label}</div>

      {/* 类型 + 值 */}
      <div className="flex gap-2 mb-2">
        <select
          value={selector.type}
          onChange={(e) => onChange({ ...selector, type: e.target.value as SelectorType })}
          className="w-24 px-2 py-1 border rounded text-sm"
        >
          {SELECTOR_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <input
          value={selector.value}
          onChange={(e) => onChange({ ...selector, value: e.target.value })}
          placeholder="选择器表达式"
          className="flex-1 px-2 py-1 border rounded text-sm font-mono"
        />
      </div>

      {/* 作用域配置 */}
      <div className="ml-2 border-l-2 border-gray-200 pl-3 mt-2">
        <div className="flex gap-4 text-xs mb-2">
          {SCOPE_MODES.map((m) => (
            <label key={m.value} className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name={`scope-${label}`}
                checked={(selector.scopeMode || 'none') === m.value}
                onChange={() => onChange({ ...selector, scopeMode: m.value })}
              />
              {m.label}
            </label>
          ))}
        </div>

        {/* 大框架模式 */}
        {selector.scopeMode === 'framework' && (
          <div className="flex gap-2 mb-2">
            <select
              value={selector.frameworkKey || ''}
              onChange={(e) => onChange({ ...selector, frameworkKey: e.target.value })}
              className="px-2 py-1 border rounded text-sm"
            >
              <option value="">选择框架...</option>
              {fwEntries.map(([key, fw]) => (
                <option key={key} value={key}>{fw.label} ({key})</option>
              ))}
            </select>
            <input
              value={selector.subContainer || ''}
              onChange={(e) => onChange({ ...selector, subContainer: e.target.value || undefined })}
              placeholder="小框架 CSS（可选）"
              className="flex-1 px-2 py-1 border rounded text-sm font-mono"
            />
          </div>
        )}

        {/* 自定义模式 */}
        {selector.scopeMode === 'custom' && (
          <input
            value={selector.customContainer || ''}
            onChange={(e) => onChange({ ...selector, customContainer: e.target.value || undefined })}
            placeholder="自定义容器 CSS 选择器"
            className="w-full px-2 py-1 border rounded text-sm font-mono mb-2"
          />
        )}

        {/* 过滤条件 */}
        <div className="flex gap-2 mt-1">
          <input
            value={selector.filterTag || ''}
            onChange={(e) => onChange({ ...selector, filterTag: e.target.value || undefined })}
            placeholder="标签 (BUTTON)"
            className="w-32 px-2 py-1 border rounded text-xs"
          />
          <input
            value={selector.filterText || ''}
            onChange={(e) => onChange({ ...selector, filterText: e.target.value || undefined })}
            placeholder="文本 (发布)"
            className="w-40 px-2 py-1 border rounded text-xs"
          />
        </div>
      </div>
    </div>
  );
}
