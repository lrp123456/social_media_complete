'use client';

import { useState, useEffect, useCallback } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { SelectorEditor } from './SelectorEditor';
import { useFrameworks, useApiPatterns, useUpsertNavigationFlow } from '@/hooks/useApi';
import type { FlowNode, FlowBranch, FlowSubStep, ScopedSelector, FrameworkEntry, StepAction, SubStepAction } from '@/hooks/useApi';

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

const SUB_STEP_ACTIONS: { value: SubStepAction; label: string }[] = [
  { value: 'resolve_selector', label: '解析选择器' },
  { value: 'resolve_fallback_selector', label: '解析备用选择器' },
  { value: 'mouse_move', label: '鼠标移动' },
  { value: 'mouse_click', label: '鼠标点击' },
  { value: 'cdp_click', label: 'CDP点击' },
  { value: 'cdp_click_node', label: 'CDP节点点击' },
  { value: 'wait_for_element', label: '等待元素' },
  { value: 'check_element_exists', label: '检查元素存在' },
  { value: 'navigate', label: '导航' },
  { value: 'refresh_page', label: '刷新页面' },
  { value: 'scroll', label: '滚动' },
  { value: 'wait_for_response', label: '等待响应' },
  { value: 'check_navigation', label: '检查导航' },
  { value: 'check_url', label: '检查URL' },
  { value: 'check_login', label: '检查登录' },
  { value: 'check_risk', label: '检查风控' },
];

export function NodeDrawer({
  node,
  steps,
  platform,
  flowName,
  onClose,
}: {
  node: FlowNode;
  steps: FlowNode[];
  platform: string;
  flowName: string;
  onClose: () => void;
}) {
  const { data: fwData } = useFrameworks(platform);
  const { data: apData } = useApiPatterns(platform);
  const upsertMutation = useUpsertNavigationFlow();

  const frameworks: Record<string, FrameworkEntry> = fwData?.frameworks || {};
  const apiPatterns = apData?.apiPatterns || {};

  const [editedNode, setEditedNode] = useState<FlowNode>(node);
  const [saved, setSaved] = useState(false);
  const [subStepsExpanded, setSubStepsExpanded] = useState(false);
  const [selectedSubStep, setSelectedSubStep] = useState<FlowSubStep | null>(null);

  useEffect(() => { setEditedNode(node); setSaved(false); setSelectedSubStep(null); }, [node.id]);

  // ---------- Selector helpers (node level) ----------
  const updateSelector = (field: 'primary' | 'fallbacks', value: ScopedSelector | ScopedSelector[]) => {
    const sel = editedNode.selector || { primary: { type: 'css' as const, value: '' }, fallbacks: [] };
    if (field === 'primary') {
      setEditedNode({ ...editedNode, selector: { ...sel, primary: value as ScopedSelector } });
    } else {
      setEditedNode({ ...editedNode, selector: { ...sel, fallbacks: value as ScopedSelector[] } });
    }
  };

  const addFallback = () => {
    const sel = editedNode.selector || { primary: { type: 'css' as const, value: '' }, fallbacks: [] };
    setEditedNode({ ...editedNode, selector: { ...sel, fallbacks: [...sel.fallbacks, { type: 'css', value: '' }] } });
  };

  const removeFallback = (index: number) => {
    const sel = editedNode.selector!;
    const fbs = [...sel.fallbacks];
    fbs.splice(index, 1);
    setEditedNode({ ...editedNode, selector: { ...sel, fallbacks: fbs } });
  };

  // ---------- Sub-step helpers ----------
  const updateSubStep = (subId: string, patch: Partial<FlowSubStep>) => {
    const subs = editedNode.steps || [];
    setEditedNode({
      ...editedNode,
      steps: subs.map((s) => (s.id === subId ? { ...s, ...patch } : s)),
    });
  };

  const updateSubStepSelector = (subId: string, field: 'primary' | 'fallbacks', value: ScopedSelector | ScopedSelector[]) => {
    const subs = editedNode.steps || [];
    const sub = subs.find((s) => s.id === subId);
    if (!sub) return;
    const sel = sub.selector || { primary: { type: 'css' as const, value: '' }, fallbacks: [] };
    if (field === 'primary') {
      updateSubStep(subId, { selector: { ...sel, primary: value as ScopedSelector } });
    } else {
      updateSubStep(subId, { selector: { ...sel, fallbacks: value as ScopedSelector[] } });
    }
  };

  const addSubStepFallback = (subId: string) => {
    const subs = editedNode.steps || [];
    const sub = subs.find((s) => s.id === subId);
    if (!sub) return;
    const sel = sub.selector || { primary: { type: 'css' as const, value: '' }, fallbacks: [] };
    updateSubStep(subId, { selector: { ...sel, fallbacks: [...sel.fallbacks, { type: 'css', value: '' }] } });
  };

  const removeSubStepFallback = (subId: string, index: number) => {
    const subs = editedNode.steps || [];
    const sub = subs.find((s) => s.id === subId);
    if (!sub || !sub.selector) return;
    const fbs = [...sub.selector.fallbacks];
    fbs.splice(index, 1);
    updateSubStep(subId, { selector: { ...sub.selector, fallbacks: fbs } });
  };

  // ---------- Branch helpers ----------
  const updateBranch = (index: number, patch: Partial<FlowBranch>) => {
    const branches = editedNode.branches || [];
    const updated = branches.map((b, i) => (i === index ? { ...b, ...patch } : b));
    setEditedNode({ ...editedNode, branches: updated });
  };

  const addBranch = () => {
    const branches = editedNode.branches || [];
    setEditedNode({ ...editedNode, branches: [...branches, { condition: '', target: '', description: '' }] });
  };

  const removeBranch = (index: number) => {
    const branches = editedNode.branches || [];
    const updated = branches.filter((_, i) => i !== index);
    setEditedNode({ ...editedNode, branches: updated.length > 0 ? updated : undefined });
  };

  // ---------- Save (fixed: sends full steps array) ----------
  const handleSave = useCallback(() => {
    const updatedSteps = steps.map((s) => (s.id === editedNode.id ? editedNode : s));
    upsertMutation.mutate({
      platform,
      flowName,
      entry: { label: flowName, steps: updatedSteps },
    }, {
      onSuccess: () => setSaved(true),
    });
  }, [editedNode, steps, platform, flowName, upsertMutation]);

  return (
    <div className="w-[480px] border-l bg-white flex flex-col shadow-lg" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 50 }}>
      {/* 顶部 */}
      <div className="flex items-center gap-2 p-4 border-b">
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <MaterialIcon icon="arrow_back" />
        </button>
        <span className="text-xs font-mono text-gray-400">{editedNode.id}</span>
        <span className="ml-auto text-xs text-gray-400">{editedNode.action}</span>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 节点类型 */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">节点类型</label>
          <select value={editedNode.action} onChange={(e) => setEditedNode({ ...editedNode, action: e.target.value as StepAction })} className="w-full px-2 py-1 border rounded text-sm">
            {NODE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label} ({t.value})</option>)}
          </select>
        </div>

        {/* 描述 */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">描述</label>
          <input value={editedNode.description} onChange={(e) => setEditedNode({ ...editedNode, description: e.target.value })} className="w-full px-2 py-1 border rounded text-sm" />
        </div>

        {/* 选择器 Key（所有节点） */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">选择器 Key</label>
          <input
            value={(editedNode.selector as any)?.key || ''}
            onChange={(e) => setEditedNode({ ...editedNode, selector: { ...(editedNode.selector || {}), key: e.target.value } as any })}
            placeholder="如 menus.menu_work_manage"
            className="w-full px-2 py-1 border rounded text-sm font-mono"
          />
        </div>

        {/* API Pattern Key（所有节点） */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">API Pattern Key</label>
          <input
            value={editedNode.apiPatternKey || ''}
            onChange={(e) => setEditedNode({ ...editedNode, apiPatternKey: e.target.value || undefined })}
            placeholder="如 video_list.work_list"
            className="w-full px-2 py-1 border rounded text-sm font-mono"
          />
        </div>

        {/* DOM 选择器（详细编辑） */}
        {['check_menu_state', 'click_menu', 'click_tab', 'click_button', 'close_menu', 'page_turn'].includes(editedNode.action) && (
          <div>
            <label className="text-xs text-gray-500 mb-2 block">DOM 选择器</label>
            <SelectorEditor label="主选择器" selector={editedNode.selector?.primary || { type: 'css', value: '' }} frameworks={frameworks} onChange={(s) => updateSelector('primary', s)} />
            {(editedNode.selector?.fallbacks || []).map((fb, i) => (
              <div key={i} className="relative">
                <SelectorEditor label={`备用 ${i + 1}`} selector={fb} frameworks={frameworks} onChange={(s) => { const fbs = [...(editedNode.selector?.fallbacks || [])]; fbs[i] = s; updateSelector('fallbacks', fbs); }} />
                <button onClick={() => removeFallback(i)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-xs">删除</button>
              </div>
            ))}
            <button onClick={addFallback} className="text-xs text-blue-600 hover:text-blue-800 mt-1">+ 添加备用选择器</button>
          </div>
        )}

        {/* 等待条件 */}
        {editedNode.waitFor && (
          <div>
            <label className="text-xs text-gray-500 mb-1 block">等待条件</label>
            <div className="grid grid-cols-2 gap-2">
              {editedNode.waitFor.urlContains !== undefined && (
                <input value={editedNode.waitFor.urlContains} onChange={(e) => setEditedNode({ ...editedNode, waitFor: { ...editedNode.waitFor!, urlContains: e.target.value } })} placeholder="URL 包含" className="px-2 py-1 border rounded text-xs" />
              )}
              {editedNode.waitFor.apiResponse !== undefined && (
                <input value={editedNode.waitFor.apiResponse} onChange={(e) => setEditedNode({ ...editedNode, waitFor: { ...editedNode.waitFor!, apiResponse: e.target.value } })} placeholder="API 响应" className="px-2 py-1 border rounded text-xs" />
              )}
              <input type="number" value={editedNode.waitFor.timeout} onChange={(e) => setEditedNode({ ...editedNode, waitFor: { ...editedNode.waitFor!, timeout: Number(e.target.value) } })} placeholder="超时(ms)" className="px-2 py-1 border rounded text-xs" />
            </div>
          </div>
        )}

        {/* check_quantity 特有 */}
        {editedNode.action === 'check_quantity' && (
          <div>
            <label className="text-xs text-gray-500 mb-1 block">最大视频数</label>
            <input type="number" value={editedNode.maxVideos || 20} onChange={(e) => setEditedNode({ ...editedNode, maxVideos: Number(e.target.value) })} className="w-full px-2 py-1 border rounded text-sm" />
          </div>
        )}

        {/* scroll_load 特有 */}
        {editedNode.action === 'scroll_load' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">最大滚动次数</label>
              <input type="number" value={editedNode.scrollConfig?.maxScrolls || 50} onChange={(e) => setEditedNode({ ...editedNode, scrollConfig: { ...editedNode.scrollConfig || { maxScrolls: 50, scrollDelta: 500 }, maxScrolls: Number(e.target.value) } })} className="w-full px-2 py-1 border rounded text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">滚动距离</label>
              <input type="number" value={editedNode.scrollConfig?.scrollDelta || 500} onChange={(e) => setEditedNode({ ...editedNode, scrollConfig: { ...editedNode.scrollConfig || { maxScrolls: 50, scrollDelta: 500 }, scrollDelta: Number(e.target.value) } })} className="w-full px-2 py-1 border rounded text-sm" />
            </div>
          </div>
        )}

        {/* 子步骤 — 可展开列表 + 内联编辑 */}
        {editedNode.steps && editedNode.steps.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <label className="text-xs text-gray-500">子步骤 ({editedNode.steps.length})</label>
              <button onClick={() => setSubStepsExpanded(!subStepsExpanded)} className="text-xs text-blue-600 hover:text-blue-800">
                {subStepsExpanded ? '收起' : '展开'}
              </button>
            </div>
            {subStepsExpanded && (
              <div className="space-y-2 border rounded p-2 bg-gray-50">
                {editedNode.steps.map((sub) => (
                  <div key={sub.id}>
                    <div
                      className="flex items-center gap-2 p-1.5 rounded cursor-pointer hover:bg-gray-100 text-sm"
                      onClick={() => setSelectedSubStep(selectedSubStep?.id === sub.id ? null : sub)}
                    >
                      <span className="text-xs font-mono text-gray-400">{sub.id}</span>
                      <span className="text-xs text-gray-600">{sub.action}</span>
                      <span className="text-xs text-gray-500 flex-1 truncate">{sub.description}</span>
                      <span className="text-xs text-gray-400">{selectedSubStep?.id === sub.id ? '▲' : '▼'}</span>
                    </div>
                    {/* 展开的子步骤编辑器 */}
                    {selectedSubStep?.id === sub.id && (
                      <div className="ml-4 mt-1 p-2 border rounded bg-white space-y-2">
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">子步骤类型</label>
                          <select
                            value={sub.action}
                            onChange={(e) => updateSubStep(sub.id, { action: e.target.value as SubStepAction })}
                            className="w-full px-2 py-1 border rounded text-xs"
                          >
                            {SUB_STEP_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">描述</label>
                          <input
                            value={sub.description}
                            onChange={(e) => updateSubStep(sub.id, { description: e.target.value })}
                            className="w-full px-2 py-1 border rounded text-xs"
                          />
                        </div>
                        {/* 子步骤选择器 */}
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">选择器</label>
                          <SelectorEditor
                            label="主选择器"
                            selector={sub.selector?.primary || { type: 'css', value: '' }}
                            frameworks={frameworks}
                            onChange={(s) => updateSubStepSelector(sub.id, 'primary', s)}
                          />
                          {(sub.selector?.fallbacks || []).map((fb, fi) => (
                            <div key={fi} className="relative mt-1">
                              <SelectorEditor label={`备用 ${fi + 1}`} selector={fb} frameworks={frameworks} onChange={(s) => {
                                const subs = editedNode.steps || [];
                                const target = subs.find((x) => x.id === sub.id);
                                if (!target) return;
                                const sel = target.selector || { primary: { type: 'css', value: '' }, fallbacks: [] };
                                const fbs = [...sel.fallbacks];
                                fbs[fi] = s;
                                updateSubStep(sub.id, { selector: { ...sel, fallbacks: fbs } });
                              }} />
                              <button onClick={() => removeSubStepFallback(sub.id, fi)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 text-xs">删除</button>
                            </div>
                          ))}
                          <button onClick={() => addSubStepFallback(sub.id)} className="text-xs text-blue-600 hover:text-blue-800 mt-1">+ 添加备用选择器</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 分支/后续 */}
        <div>
          <label className="text-xs text-gray-500 mb-1 block">后续步骤</label>
          {editedNode.branches && editedNode.branches.length > 0 ? (
            editedNode.branches.map((branch, i) => (
              <div key={i} className="flex gap-2 mb-1 items-center">
                <input value={branch.condition} onChange={(e) => updateBranch(i, { condition: e.target.value })} placeholder="条件" className="w-24 px-2 py-1 border rounded text-xs font-mono" />
                <span className="text-xs text-gray-400">→</span>
                <input value={branch.target} onChange={(e) => updateBranch(i, { target: e.target.value })} placeholder="目标 ID" className="flex-1 px-2 py-1 border rounded text-xs font-mono" />
                <input value={branch.description} onChange={(e) => updateBranch(i, { description: e.target.value })} placeholder="描述" className="w-28 px-2 py-1 border rounded text-xs font-mono" />
                <button onClick={() => removeBranch(i)} className="text-red-400 hover:text-red-600 text-xs">×</button>
              </div>
            ))
          ) : (
            <div className="space-y-1">
              <input value={editedNode.next || ''} onChange={(e) => setEditedNode({ ...editedNode, next: e.target.value || undefined })} placeholder="下一步 ID (如 s05_enable_interceptor)" className="w-full px-2 py-1 border rounded text-xs font-mono" />
              <button onClick={addBranch} className="text-xs text-blue-600 hover:text-blue-800">+ 添加分支</button>
            </div>
          )}
        </div>
      </div>

      {/* 底部 */}
      <div className="border-t p-3 flex items-center gap-2">
        <button onClick={handleSave} className="px-4 py-1.5 bg-blue-500 text-white rounded text-sm hover:bg-blue-600">保存</button>
        {saved && <span className="text-xs text-green-600">已保存</span>}
        <button onClick={onClose} className="ml-auto px-4 py-1.5 border rounded text-sm">关闭</button>
      </div>
    </div>
  );
}
