'use client';

import { useState, useEffect, useCallback } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { SelectorEditor } from './SelectorEditor';
import { useFrameworks, useApiPatterns, useUpsertNavigationFlow } from '@/hooks/useApi';
import type { FlowNode, FlowBranch, SelectorConfig, ScopedSelector, FrameworkEntry, StepAction } from '@/hooks/useApi';

const NODE_TYPES: { value: StepAction; label: string }[] = [
  { value: 'check_url', label: 'URL检查' },
  { value: 'check_menu_state', label: '菜单状态' },
  { value: 'click_menu', label: '点击菜单' },
  { value: 'click_tab', label: '点击Tab' },
  { value: 'click_button', label: '点击按钮' },
  { value: 'enable_interceptor', label: '开启监控' },
  { value: 'disable_interceptor', label: '关闭监控' },
  { value: 'refresh_page', label: '刷新页面' },
  { value: 'wait_for_response', label: '等待响应' },
  { value: 'check_quantity', label: '数量检查' },
  { value: 'scroll_load', label: '滚动加载' },
  { value: 'page_turn', label: '换页' },
  { value: 'close_menu', label: '关闭菜单' },
  { value: 'done', label: '完成' },
];

export function NodeDrawer({
  node,
  platform,
  flowName,
  onClose,
}: {
  node: FlowNode;
  platform: string;
  flowName: string;
  onClose: () => void;
}) {
  const { data: fwData } = useFrameworks(platform);
  const { data: apData } = useApiPatterns(platform);
  const upsertFlow = useUpsertNavigationFlow();

  const frameworks: Record<string, FrameworkEntry> = fwData?.frameworks || {};
  const apiPatterns = apData?.apiPatterns || {};

  const [form, setForm] = useState<FlowNode>(node);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setForm(node); setSaved(false); }, [node.id]);

  const updateSelector = (field: 'primary' | 'fallbacks', value: ScopedSelector | ScopedSelector[]) => {
    const sel = form.selector || { primary: { type: 'css' as const, value: '' }, fallbacks: [] };
    if (field === 'primary') {
      setForm({ ...form, selector: { ...sel, primary: value as ScopedSelector } });
    } else {
      setForm({ ...form, selector: { ...sel, fallbacks: value as ScopedSelector[] } });
    }
  };

  const addFallback = () => {
    const sel = form.selector || { primary: { type: 'css' as const, value: '' }, fallbacks: [] };
    setForm({ ...form, selector: { ...sel, fallbacks: [...sel.fallbacks, { type: 'css', value: '' }] } });
  };

  const removeFallback = (index: number) => {
    const sel = form.selector!;
    const fbs = [...sel.fallbacks];
    fbs.splice(index, 1);
    setForm({ ...form, selector: { ...sel, fallbacks: fbs } });
  };

  const save = useCallback(() => {
    // 保存到 navigationFlows 中的对应步骤
    upsertFlow.mutate({ platform, flowName, entry: { label: flowName, steps: [form] } }, {
      onSuccess: () => setSaved(true),
    });
  }, [form, platform, flowName]);

  return (
    <div className="w-[480px] border-l bg-white flex flex-col h-full shadow-lg">
      {/* 顶部 */}
      <div className="flex items-center gap-2 p-4 border-b">
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <MaterialIcon icon="arrow_back" />
        </button>
        <span className="text-xs font-mono text-gray-400">{form.id}</span>
        <span className="ml-auto text-xs text-gray-400">{form.action}</span>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 节点类型 */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">节点类型</label>
          <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as StepAction })} className="w-full px-2 py-1 border rounded text-sm">
            {NODE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label} ({t.value})</option>)}
          </select>
        </div>

        {/* 描述 */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">描述</label>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full px-2 py-1 border rounded text-sm" />
        </div>

        {/* DOM 选择器 */}
        {['check_menu_state', 'click_menu', 'click_tab', 'click_button', 'close_menu', 'page_turn'].includes(form.action) && (
          <div>
            <label className="text-xs text-gray-500 mb-2 block">DOM 选择器</label>
            <SelectorEditor label="主选择器" selector={form.selector?.primary || { type: 'css', value: '' }} frameworks={frameworks} onChange={(s) => updateSelector('primary', s)} />
            {(form.selector?.fallbacks || []).map((fb, i) => (
              <div key={i} className="relative">
                <SelectorEditor label={`备用 ${i + 1}`} selector={fb} frameworks={frameworks} onChange={(s) => { const fbs = [...(form.selector?.fallbacks || [])]; fbs[i] = s; updateSelector('fallbacks', fbs); }} />
                <button onClick={() => removeFallback(i)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-xs">删除</button>
              </div>
            ))}
            <button onClick={addFallback} className="text-xs text-blue-600 hover:text-blue-800 mt-1">+ 添加备用选择器</button>
          </div>
        )}

        {/* API Pattern（enable_interceptor 节点） */}
        {form.action === 'enable_interceptor' && (
          <div>
            <label className="text-xs text-gray-500 mb-1 block">API Pattern</label>
            <select value={form.apiPatternKey || ''} onChange={(e) => setForm({ ...form, apiPatternKey: e.target.value || undefined })} className="w-full px-2 py-1 border rounded text-sm">
              <option value="">选择...</option>
              {Object.keys(apiPatterns).map((k) => <option key={k} value={k}>{k} — {(apiPatterns[k] as any)?.pattern}</option>)}
            </select>
          </div>
        )}

        {/* 等待条件 */}
        {form.waitFor && (
          <div>
            <label className="text-xs text-gray-500 mb-1 block">等待条件</label>
            <div className="grid grid-cols-2 gap-2">
              {form.waitFor.urlContains !== undefined && (
                <input value={form.waitFor.urlContains} onChange={(e) => setForm({ ...form, waitFor: { ...form.waitFor!, urlContains: e.target.value } })} placeholder="URL 包含" className="px-2 py-1 border rounded text-xs" />
              )}
              {form.waitFor.apiResponse !== undefined && (
                <input value={form.waitFor.apiResponse} onChange={(e) => setForm({ ...form, waitFor: { ...form.waitFor!, apiResponse: e.target.value } })} placeholder="API 响应" className="px-2 py-1 border rounded text-xs" />
              )}
              <input type="number" value={form.waitFor.timeout} onChange={(e) => setForm({ ...form, waitFor: { ...form.waitFor!, timeout: Number(e.target.value) } })} placeholder="超时(ms)" className="px-2 py-1 border rounded text-xs" />
            </div>
          </div>
        )}

        {/* check_quantity 特有 */}
        {form.action === 'check_quantity' && (
          <div>
            <label className="text-xs text-gray-500 mb-1 block">最大视频数</label>
            <input type="number" value={form.maxVideos || 20} onChange={(e) => setForm({ ...form, maxVideos: Number(e.target.value) })} className="w-full px-2 py-1 border rounded text-sm" />
          </div>
        )}

        {/* scroll_load 特有 */}
        {form.action === 'scroll_load' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">最大滚动次数</label>
              <input type="number" value={form.scrollConfig?.maxScrolls || 50} onChange={(e) => setForm({ ...form, scrollConfig: { ...form.scrollConfig || { maxScrolls: 50, scrollDelta: 500 }, maxScrolls: Number(e.target.value) } })} className="w-full px-2 py-1 border rounded text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">滚动距离</label>
              <input type="number" value={form.scrollConfig?.scrollDelta || 500} onChange={(e) => setForm({ ...form, scrollConfig: { ...form.scrollConfig || { maxScrolls: 50, scrollDelta: 500 }, scrollDelta: Number(e.target.value) } })} className="w-full px-2 py-1 border rounded text-sm" />
            </div>
          </div>
        )}

        {/* 分支/后续 */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">后续步骤</label>
          {form.branches && form.branches.length > 0 ? (
            form.branches.map((branch, i) => (
              <div key={i} className="flex gap-2 mb-1 items-center">
                <input value={branch.condition} onChange={(e) => {
                  const updated = [...(form.branches || [])];
                  updated[i] = { ...updated[i], condition: e.target.value };
                  setForm({ ...form, branches: updated });
                }} placeholder="条件" className="w-24 px-2 py-1 border rounded text-xs font-mono" />
                <span className="text-xs text-gray-400">→</span>
                <input value={branch.target} onChange={(e) => {
                  const updated = [...(form.branches || [])];
                  updated[i] = { ...updated[i], target: e.target.value };
                  setForm({ ...form, branches: updated });
                }} placeholder="目标 ID" className="flex-1 px-2 py-1 border rounded text-xs font-mono" />
                <input value={branch.description} onChange={(e) => {
                  const updated = [...(form.branches || [])];
                  updated[i] = { ...updated[i], description: e.target.value };
                  setForm({ ...form, branches: updated });
                }} placeholder="描述" className="w-28 px-2 py-1 border rounded text-xs font-mono" />
                <button onClick={() => {
                  const updated = (form.branches || []).filter((_, j) => j !== i);
                  setForm({ ...form, branches: updated.length > 0 ? updated : undefined });
                }} className="text-red-400 hover:text-red-600 text-xs">×</button>
              </div>
            ))
          ) : (
            <div className="space-y-1">
              <input value={form.next || ''} onChange={(e) => setForm({ ...form, next: e.target.value || undefined })} placeholder="下一步 ID (如 s05_enable_interceptor)" className="w-full px-2 py-1 border rounded text-xs font-mono" />
              <button onClick={() => setForm({ ...form, branches: [{ condition: '', target: '', description: '' }] })} className="text-xs text-blue-600 hover:text-blue-800">+ 添加分支</button>
            </div>
          )}
        </div>
      </div>

      {/* 底部 */}
      <div className="border-t p-3 flex items-center gap-2">
        <button onClick={save} className="px-4 py-1.5 bg-blue-500 text-white rounded text-sm hover:bg-blue-600">保存</button>
        {saved && <span className="text-xs text-green-600">已保存</span>}
        <button onClick={onClose} className="ml-auto px-4 py-1.5 border rounded text-sm">关闭</button>
      </div>
    </div>
  );
}
