'use client';

import { useState, useMemo, Fragment } from 'react';
import { MaterialIcon, type MaterialIconName } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import {
  useCustomSelectors,
  useUpsertCustomSelector,
  useDeleteCustomSelector,
  type CustomSelector,
} from '@/hooks/useApi';

export default function DynamicSelectorPanel() {
  const selectorsQuery = useCustomSelectors();
  const upsertSelector = useUpsertCustomSelector();
  const deleteSelector = useDeleteCustomSelector();

  const [showSelectorForm, setShowSelectorForm] = useState(false);
  const [expandedSelector, setExpandedSelector] = useState<string | null>(null);
  const [newSelector, setNewSelector] = useState({
    platform: '',
    category: 'buttons' as string,
    name: '',
    primary: '',
    fallbacks: [] as string[],
    selectorType: 'css' as string,
    description: '',
    enabled: true,
  });
  const [selectorFilter, setSelectorFilter] = useState({
    platform: '',
    category: '',
    purpose: '',
  });
  const [editingSelector, setEditingSelector] = useState<string | null>(null);
  const [originalSelectorKey, setOriginalSelectorKey] = useState<{ platform: string; categoryKey: string } | null>(null);

  const filteredSelectors = useMemo(() => {
    const data = selectorsQuery.data || [];
    return data.filter((s: CustomSelector) => {
      if (selectorFilter.platform && s.platform !== selectorFilter.platform) return false;
      if (selectorFilter.category && s.category !== selectorFilter.category) return false;
      if (selectorFilter.purpose && !(s.purposes || []).includes(selectorFilter.purpose)) return false;
      return true;
    });
  }, [selectorsQuery.data, selectorFilter]);

  const handleSaveSelector = () => {
    if (!newSelector.platform || !newSelector.category || !newSelector.name || !newSelector.primary) return;
    const categoryKey = `${newSelector.category}:${newSelector.name}`;
    const selectorValue = JSON.stringify({
      purposes: ['publish', 'monitor'],
      primary: newSelector.primary,
      fallbacks: newSelector.fallbacks.filter(Boolean),
      selectorType: newSelector.selectorType,
      description: newSelector.description || '',
      enabled: newSelector.enabled !== false,
    });
    upsertSelector.mutate({
      platform: newSelector.platform,
      categoryKey,
      selector_value: selectorValue,
      ...(originalSelectorKey ? {
        originalPlatform: originalSelectorKey.platform,
        originalCategoryKey: originalSelectorKey.categoryKey,
      } : {}),
    });
    setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true });
    setShowSelectorForm(false);
    setEditingSelector(null);
    setOriginalSelectorKey(null);
  };

  const resetSelectorForm = () => {
    setShowSelectorForm(false);
    setEditingSelector(null);
    setOriginalSelectorKey(null);
    setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true });
  };

  return (
                  <div className="border-t border-outline-variant pt-6">
                    <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md flex items-center justify-between">
                      <span>动态选择器管理</span>
                      <button onClick={() => { setShowSelectorForm(true); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }} className="btn-secondary text-sm">
                        <MaterialIcon icon="add" size="sm" /> 新增选择器
                      </button>
                    </h4>
                    {/* 筛选栏 */}
                    <div className="flex flex-wrap gap-3 mb-4">
                      <select
                        className="form-input text-sm w-auto min-w-[140px]"
                        value={selectorFilter.platform}
                        onChange={(e) => setSelectorFilter((prev) => ({ ...prev, platform: e.target.value }))}
                      >
                        <option value="">全部平台</option>
                        <option value="douyin">抖音 (douyin)</option>
                        <option value="kuaishou">快手 (kuaishou)</option>
                        <option value="xiaohongshu">小红书 (xiaohongshu)</option>
                        <option value="bilibili">B站 (bilibili)</option>
                      </select>
                      <select
                        className="form-input text-sm w-auto min-w-[140px]"
                        value={selectorFilter.category}
                        onChange={(e) => setSelectorFilter((prev) => ({ ...prev, category: e.target.value }))}
                      >
                        <option value="">全部类别</option>
                        <option value="menus">菜单 (menus)</option>
                        <option value="buttons">按钮 (buttons)</option>
                        <option value="regions">区域 (regions)</option>
                        <option value="textboxes">文本框 (textboxes)</option>
                      </select>
                      <select
                        className="form-input text-sm w-auto min-w-[140px]"
                        value={selectorFilter.purpose}
                        onChange={(e) => setSelectorFilter((prev) => ({ ...prev, purpose: e.target.value }))}
                      >
                        <option value="">全部场景</option>
                        <option value="publish">发布 (publish)</option>
                        <option value="monitor">监控 (monitor)</option>
                      </select>
                      {(selectorFilter.platform || selectorFilter.category || selectorFilter.purpose) && (
                        <button
                          className="btn-ghost text-sm text-on-surface-variant"
                          onClick={() => setSelectorFilter({ platform: '', category: '', purpose: '' })}
                        >
                          <MaterialIcon icon="filter_list" size="sm" /> 清除筛选
                        </button>
                      )}
                    </div>
                    {selectorsQuery.isLoading ? <PanelSkeleton rows={3} /> : selectorsQuery.isError ? <QueryError /> : (
                      <div className="overflow-x-auto">
                        <table className="table-flat w-full">
                          <thead>
                            <tr>
                              <th className="text-left">平台</th>
                              <th className="text-left">类别</th>
                              <th className="text-left">名称</th>
                              <th className="text-left">主选择器</th>
                              <th className="text-left">使用场景</th>
                              <th className="text-left">更新时间</th>
                              <th className="text-right">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredSelectors.map((selector: CustomSelector) => {
                              const cat = selector.category;
                              const name = selector.name;
                              const primary = selector.primary || '—';
                              const fallbacks = selector.fallbacks || [];
                              const purposes = selector.purposes || [];
                              // 写入侧走 URL `:platform/:categoryKey` 仍需合并串
                              const selectorKey = `${cat}:${name}`;
                              const isExpanded = expandedSelector === `${selector.platform}-${selectorKey}`;
                              return (
                                <Fragment key={`${selector.platform}-${selectorKey}`}>
                                  <tr
                                    className="cursor-pointer hover:bg-surface-container/50 transition-colors"
                                    onClick={() => setExpandedSelector(isExpanded ? null : `${selector.platform}-${selectorKey}`)}
                                  >
                                    <td className="font-mono text-sm">
                                      <div className="flex items-center gap-1.5">
                                        <MaterialIcon icon={isExpanded ? 'expand_less' : 'expand_more'} size="sm" className="text-on-surface-variant" />
                                        {selector.platform}
                                      </div>
                                    </td>
                                    <td className="text-sm">
                                      <StatusPill tone="primary" dot>{cat}</StatusPill>
                                    </td>
                                    <td className="font-mono text-sm">{name}</td>
                                    <td className="font-mono text-[12px] text-on-surface-variant max-w-xs truncate">{primary}</td>
                                    <td className="text-sm">
                                      <div className="flex flex-wrap gap-1">
                                        {purposes.length > 0 ? purposes.map((p: string) => (
                                          <span key={p} className={cn(
                                            'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium',
                                            p === 'publish' ? 'bg-primary-container text-on-primary-container' : 'bg-secondary-container text-on-secondary-container',
                                          )}>
                                            {p === 'publish' ? '发布' : p === 'monitor' ? '监控' : p}
                                          </span>
                                        )) : <span className="text-on-surface-variant">—</span>}
                                      </div>
                                    </td>
                                    <td className="text-[12px] text-on-surface-variant">
                                      {selector.updatedAt ? new Date(selector.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                                    </td>
                                    <td className="text-right">
                                      <div className="flex items-center justify-end gap-1">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setEditingSelector(`${selector.platform}-${selectorKey}`);
                                            setOriginalSelectorKey({ platform: selector.platform, categoryKey: selectorKey });
                                            setNewSelector({
                                              platform: selector.platform,
                                              category: cat,
                                              name: name,
                                              primary: selector.primary || '',
                                              fallbacks: [...(selector.fallbacks || [])],
                                              selectorType: selector.selectorType || 'css',
                                              description: selector.description || '',
                                              enabled: selector.enabled !== false,
                                            });
                                            setShowSelectorForm(true);
                                          }}
                                          className="btn-ghost text-primary"
                                          title="编辑选择器"
                                        >
                                          <MaterialIcon icon="edit" size="sm" />
                                        </button>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); if (confirm(`确定删除 ${selector.platform}/${selectorKey}?`)) deleteSelector.mutate({ platform: selector.platform, categoryKey: selectorKey }); }}
                                          disabled={deleteSelector.isPending}
                                          className="btn-ghost text-error"
                                          title="删除选择器"
                                        >
                                          <MaterialIcon icon="delete" size="sm" />
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                  {isExpanded && (
                                    <tr>
                                      <td colSpan={7} className="bg-surface-container/30 p-4">
                                        <div className="space-y-3">
                                          {/* 启用状态切换 */}
                                          <div className="flex items-center gap-3">
                                            <span className="text-label-md text-on-surface-variant">启用状态</span>
                                            <span className={cn(
                                              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                                              selector.enabled !== false
                                                ? 'bg-success-container text-on-success-container'
                                                : 'bg-error-container text-on-error-container',
                                            )}>
                                              <span className={cn('w-1.5 h-1.5 rounded-full', selector.enabled !== false ? 'bg-success' : 'bg-error')} />
                                              {selector.enabled !== false ? '已启用' : '已禁用'}
                                            </span>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                const categoryKey = `${cat}:${name}`;
                                                const selectorValue = JSON.stringify({
                                                  purposes: purposes,
                                                  primary: selector.primary,
                                                  fallbacks: fallbacks,
                                                  selectorType: selector.selectorType || 'css',
                                                  description: selector.description || '',
                                                  enabled: selector.enabled === false ? true : false,
                                                });
                                                upsertSelector.mutate({ platform: selector.platform, categoryKey, selector_value: selectorValue });
                                              }}
                                              className="btn-ghost text-sm text-primary"
                                            >
                                              <MaterialIcon icon={(selector.enabled !== false ? 'toggle_off' : 'toggle_on') as MaterialIconName} size="sm" />
                                              {selector.enabled !== false ? '禁用' : '启用'}
                                            </button>
                                          </div>
                                          {/* 选择器列表：主选择器 + 回退选择器 */}
                                          <div>
                                            <span className="text-label-md text-on-surface-variant block mb-1">选择器列表</span>
                                            <div className="space-y-1">
                                              <div className="font-mono text-[12px] text-on-surface bg-primary-container/30 px-2 py-1 rounded flex items-center gap-2">
                                                <span className="bg-primary text-on-primary text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0">主</span>
                                                {primary}
                                              </div>
                                              {fallbacks.map((fb: string, i: number) => (
                                                <div key={i} className="font-mono text-[12px] text-on-surface-variant bg-surface-container px-2 py-1 rounded flex items-center gap-2">
                                                  <span className="text-on-surface-variant text-[10px] px-1.5 py-0.5 shrink-0">{i + 1}</span>
                                                  {fb}
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                          {/* 描述 */}
                                          {selector.description && (
                                            <div className="text-[11px] text-on-surface-variant">
                                              描述: {selector.description}
                                            </div>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
    
                    {showSelectorForm && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => { setShowSelectorForm(false); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }}>
                        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4" onClick={(e) => e.stopPropagation()}>
                          {/* Modal Header */}
                          <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant">
                            <h5 className="text-headline-sm text-on-surface font-medium">
                              {editingSelector ? '编辑选择器' : '新增选择器'}
                            </h5>
                            <button onClick={() => { setShowSelectorForm(false); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }} className="btn-ghost rounded-full p-1">
                              <MaterialIcon icon="close" size="md" />
                            </button>
                          </div>
                          {/* Modal Body */}
                          <div className="px-6 py-5 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <label className="text-label-sm text-on-surface-variant">平台</label>
                                <select className="form-input" value={newSelector.platform}
                                  onChange={(e) => setNewSelector({ ...newSelector, platform: e.target.value })}
                                  disabled={!!editingSelector}>
                                  <option value="">选择平台</option>
                                  <option value="douyin">抖音 (douyin)</option>
                                  <option value="kuaishou">快手 (kuaishou)</option>
                                  <option value="xiaohongshu">小红书 (xiaohongshu)</option>
                                  <option value="bilibili">B站 (bilibili)</option>
                                </select>
                              </div>
                              <div className="space-y-1">
                                <label className="text-label-sm text-on-surface-variant">类别</label>
                                <select className="form-input" value={newSelector.category}
                                  onChange={(e) => setNewSelector({ ...newSelector, category: e.target.value })}>
                                  <option value="">选择类别</option>
                                  <option value="menus">菜单 (menus)</option>
                                  <option value="buttons">按钮 (buttons)</option>
                                  <option value="regions">区域 (regions)</option>
                                  <option value="textboxes">文本框 (textboxes)</option>
                                </select>
                              </div>
                              <div className="space-y-1">
                                <label className="text-label-sm text-on-surface-variant">选择器名称</label>
                                <input className="form-input font-mono text-sm" placeholder="如 btn_publish_submit"
                                  value={newSelector.name}
                                  onChange={(e) => setNewSelector({ ...newSelector, name: e.target.value })} />
                              </div>
                              <div className="space-y-1">
                                <label className="text-label-sm text-on-surface-variant">选择器类型</label>
                                <select className="form-input" value={newSelector.selectorType}
                                  onChange={(e) => setNewSelector({ ...newSelector, selectorType: e.target.value })}>
                                  <option value="css">css</option>
                                  <option value="role">role</option>
                                  <option value="text">text</option>
                                  <option value="placeholder">placeholder</option>
                                  <option value="label">label</option>
                                </select>
                              </div>
                            </div>
    
                            <div className="space-y-1">
                              <label className="text-label-md text-on-surface-variant">主选择器 (primary)</label>
                              <input className="form-input font-mono text-sm w-full" placeholder="如 button:has-text(&quot;发布&quot;)"
                                value={newSelector.primary}
                                onChange={(e) => setNewSelector({ ...newSelector, primary: e.target.value })} />
                            </div>
    
                            <div className="space-y-1">
                              <label className="text-label-md text-on-surface-variant">回退选择器列表 (fallbacks)</label>
                              <div className="space-y-2">
                                {(newSelector.fallbacks || []).map((fb: string, i: number) => (
                                  <div key={i} className="flex gap-2">
                                    <input className="form-input font-mono text-sm flex-1"
                                      value={fb} placeholder={`回退选择器 ${i + 1}`}
                                      onChange={(e) => {
                                        const updated = [...newSelector.fallbacks];
                                        updated[i] = e.target.value;
                                        setNewSelector({ ...newSelector, fallbacks: updated });
                                      }} />
                                    <button onClick={() => {
                                      const updated = newSelector.fallbacks.filter((_: string, j: number) => j !== i);
                                      setNewSelector({ ...newSelector, fallbacks: updated });
                                    }} className="btn-ghost text-error">
                                      <MaterialIcon icon="delete" size="sm" />
                                    </button>
                                  </div>
                                ))}
                                <button onClick={() => setNewSelector({ ...newSelector, fallbacks: [...(newSelector.fallbacks || []), ''] })}
                                  className="btn-ghost text-sm">
                                  <MaterialIcon icon="add" size="sm" /> 添加回退选择器
                                </button>
                              </div>
                            </div>
    
                            <div className="space-y-1">
                              <label className="text-label-md text-on-surface-variant">描述</label>
                              <input className="form-input font-mono text-sm w-full" placeholder="选择器描述/用途说明"
                                value={newSelector.description || ''}
                                onChange={(e) => setNewSelector({ ...newSelector, description: e.target.value })} />
                            </div>
                          </div>
                          {/* Modal Footer */}
                          <div className="flex justify-end gap-2 px-6 py-4 border-t border-outline-variant">
                            <button onClick={() => { setShowSelectorForm(false); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }} className="btn-ghost">取消</button>
                            <button onClick={handleSaveSelector} disabled={upsertSelector.isPending} className="btn-primary">
                              {upsertSelector.isPending ? '保存中…' : '保存'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
  );
}