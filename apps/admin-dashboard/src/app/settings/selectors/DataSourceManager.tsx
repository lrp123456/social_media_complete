'use client';

import { useState } from "react";
import { cn } from "@/lib/utils";
import { MaterialIcon } from "@/components/ui/MaterialIcon";
import {
  useDataSources,
  useUpsertDataSource,
  useDeleteDataSource,
  useApiPatterns,
} from "@/hooks/useApi";
import type { DataSourceEntry } from "@/hooks/useApi";

const PLATFORM_LABELS: Record<string, string> = {
  douyin: "抖音", kuaishou: "快手", xiaohongshu: "小红书", tencent: "视频号",
};

const PAGINATION_TYPE_LABELS: Record<string, string> = {
  scroll: "滚动加载", page: "翻页",
};

type DataSourceManagerProps = {
  platform: string;
  onClose: () => void;
};

function emptyEntry(): DataSourceEntry {
  return { label: "", pageUrl: "", apiPatternKey: "", pagination: { type: "scroll", maxScrolls: 5 } };
}

export default function DataSourceManager({ platform, onClose }: DataSourceManagerProps) {
  const { data: dataSourcesData, isLoading } = useDataSources(platform);
  const { data: apiPatternsData } = useApiPatterns(platform);
  const upsertDataSource = useUpsertDataSource();
  const deleteDataSource = useDeleteDataSource();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<DataSourceEntry>(emptyEntry());
  const [isNew, setIsNew] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const dataSources: Record<string, DataSourceEntry> = dataSourcesData?.dataSources || {};
  const apiPatterns: Record<string, any> = apiPatternsData?.apiPatterns || {};
  const apiPatternKeys = Object.keys(apiPatterns);

  const startEdit = (key: string, entry: DataSourceEntry) => {
    setEditingKey(key); setEditingEntry({ ...entry }); setIsNew(false);
  };
  const startNew = () => {
    setEditingKey(""); setEditingEntry(emptyEntry()); setIsNew(true);
  };

  const handleSave = async () => {
    if (!editingKey) return;
    try {
      await upsertDataSource.mutateAsync({ platform, key: editingKey, entry: editingEntry });
      showToast(isNew ? "数据源已创建" : "数据源已保存", "success");
      setEditingKey(null); setIsNew(false);
    } catch (e: any) { showToast(e?.response?.data?.error || "保存失败", "error"); }
  };

  const handleDelete = async () => {
    if (!editingKey || !confirm("确认删除数据源 " + editingKey + "？")) return;
    try {
      await deleteDataSource.mutateAsync({ platform, key: editingKey });
      showToast("数据源已删除", "success");
      setEditingKey(null); setIsNew(false);
    } catch (e: any) { showToast(e?.response?.data?.error || "删除失败", "error"); }
  };

  const setPagination = (patch: Partial<NonNullable<DataSourceEntry["pagination"]>>) => {
    setEditingEntry((prev) => ({
      ...prev,
      pagination: { ...(prev.pagination || { type: "scroll" }), ...patch } as DataSourceEntry["pagination"],
    }));
  };

  const setPrivateFilter = (patch: Partial<NonNullable<DataSourceEntry["privateFilter"]>>) => {
    setEditingEntry((prev) => ({
      ...prev,
      privateFilter: { ...(prev.privateFilter || { enabled: false, field: "", condition: "", dynamicRemove: false }), ...patch },
    }));
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {toast && (
        <div className={cn(
          'fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-in slide-in-from-top-2',
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white',
        )}>{toast.msg}</div>
      )}
      <div className="relative bg-surface rounded-2xl shadow-2xl w-[720px] max-h-[80vh] overflow-y-auto border border-outline-variant">
        <div className="sticky top-0 bg-surface border-b border-outline-variant px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-title-md font-bold text-on-surface">DataSource 配置</h3>
            <p className="text-body-xs text-on-surface-variant mt-0.5">{PLATFORM_LABELS[platform] || platform} · 管理数据源配置</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-container transition-colors">
            <MaterialIcon icon="close" size="sm" />
          </button>
        </div>
        <div className="p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : editingKey !== null ? (
            <div className="space-y-5">
              {isNew && (
                <div>
                  <label className="text-label-sm text-on-surface font-medium mb-1 block">Key</label>
                  <input value={editingKey} onChange={(e) => setEditingKey(e.target.value)} placeholder="video_list" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:border-primary" />
                </div>
              )}
              <div>
                <label className="text-label-sm text-on-surface font-medium mb-1 block">标签 (label)</label>
                <input value={editingEntry.label} onChange={(e) => setEditingEntry((prev) => ({ ...prev, label: e.target.value }))} placeholder="视频列表" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary" />
              </div>
              <div>
                <label className="text-label-sm text-on-surface font-medium mb-1 block">页面 URL (pageUrl)</label>
                <input value={editingEntry.pageUrl} onChange={(e) => setEditingEntry((prev) => ({ ...prev, pageUrl: e.target.value }))} placeholder="https://creator.douyin.com/content/post" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:border-primary" />
              </div>
              <div>
                <label className="text-label-sm text-on-surface font-medium mb-1 block">API Pattern</label>
                <select value={editingEntry.apiPatternKey} onChange={(e) => setEditingEntry((prev) => ({ ...prev, apiPatternKey: e.target.value }))} className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary">
                  <option value="">-- 选择 API Pattern --</option>
                  {apiPatternKeys.map((k) => (
                    <option key={k} value={k}>{k} {apiPatterns[k]?.pattern ? `(${apiPatterns[k].pattern})` : ''}</option>
                  ))}
                </select>
              </div>
              <div className="border border-outline-variant rounded-xl p-4 space-y-3">
                <h4 className="text-label-sm font-bold text-on-surface">分页配置</h4>
                <div>
                  <label className="text-label-xs text-on-surface-variant mb-1 block">类型</label>
                  <select value={editingEntry.pagination?.type || 'scroll'} onChange={(e) => setPagination({ type: e.target.value as 'scroll' | 'page' })} className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary">
                    <option value="scroll">{PAGINATION_TYPE_LABELS.scroll}</option>
                    <option value="page">{PAGINATION_TYPE_LABELS.page}</option>
                  </select>
                </div>
                {editingEntry.pagination?.type === 'scroll' ? (
                  <div>
                    <label className="text-label-xs text-on-surface-variant mb-1 block">最大滚动次数 (maxScrolls)</label>
                    <input type="number" min={1} value={editingEntry.pagination?.maxScrolls ?? 5} onChange={(e) => setPagination({ maxScrolls: parseInt(e.target.value) || 1 })} className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary" />
                  </div>
                ) : (
                  <div>
                    <label className="text-label-xs text-on-surface-variant mb-1 block">最大翻页数 (maxPages)</label>
                    <input type="number" min={1} value={editingEntry.pagination?.maxPages ?? 10} onChange={(e) => setPagination({ maxPages: parseInt(e.target.value) || 1 })} className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary" />
                  </div>
                )}
                {editingEntry.pagination?.type === 'page' && (
                  <div className="border-t border-outline-variant/40 pt-3 space-y-2">
                    <label className="text-label-xs text-on-surface-variant mb-1 block">换页按钮选择器</label>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-label-xs text-on-surface-variant/70 mb-0.5 block">CSS</label>
                        <input value={editingEntry.pagination?.nextPageBtn?.css || ''} onChange={(e) => setPagination({ nextPageBtn: { ...(editingEntry.pagination?.nextPageBtn || {}), css: e.target.value || undefined } })} placeholder=".next-btn" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1.5 text-body-xs font-mono outline-none focus:border-primary" />
                      </div>
                      <div>
                        <label className="text-label-xs text-on-surface-variant/70 mb-0.5 block">XPath</label>
                        <input value={editingEntry.pagination?.nextPageBtn?.xpath || ''} onChange={(e) => setPagination({ nextPageBtn: { ...(editingEntry.pagination?.nextPageBtn || {}), xpath: e.target.value || undefined } })} placeholder="//button[@class='next']" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1.5 text-body-xs font-mono outline-none focus:border-primary" />
                      </div>
                      <div>
                        <label className="text-label-xs text-on-surface-variant/70 mb-0.5 block">文本</label>
                        <input value={editingEntry.pagination?.nextPageBtn?.text || ''} onChange={(e) => setPagination({ nextPageBtn: { ...(editingEntry.pagination?.nextPageBtn || {}), text: e.target.value || undefined } })} placeholder="下一页" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1.5 text-body-xs font-mono outline-none focus:border-primary" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="border border-outline-variant rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-label-sm font-bold text-on-surface">非公开过滤 (privateFilter)</h4>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={editingEntry.privateFilter?.enabled || false} onChange={(e) => { if (e.target.checked) { setPrivateFilter({ enabled: true, field: "", condition: "", dynamicRemove: false }); } else { setEditingEntry((prev) => ({ ...prev, privateFilter: undefined })); } }} className="rounded" />
                    <span className="text-body-xs text-on-surface">启用</span>
                  </label>
                </div>
                {editingEntry.privateFilter?.enabled && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-label-xs text-on-surface-variant mb-1 block">过滤字段 (field)</label>
                      <input value={editingEntry.privateFilter.field} onChange={(e) => setPrivateFilter({ field: e.target.value })} placeholder="data.items[].isPrivate" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:border-primary" />
                    </div>
                    <div>
                      <label className="text-label-xs text-on-surface-variant mb-1 block">过滤条件 (condition)</label>
                      <input value={editingEntry.privateFilter.condition} onChange={(e) => setPrivateFilter({ condition: e.target.value })} placeholder="true" className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:border-primary" />
                    </div>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={editingEntry.privateFilter.dynamicRemove} onChange={(e) => setPrivateFilter({ dynamicRemove: e.target.checked })} className="rounded" />
                      <span className="text-body-xs text-on-surface">动态剔除 (dynamicRemove)</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex justify-end mb-4">
                <button onClick={startNew} className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-primary text-on-primary text-label-md font-medium hover:shadow-md transition-all">
                  <MaterialIcon icon="add" size="sm" />新建 DataSource
                </button>
              </div>
              {Object.keys(dataSources).length === 0 && (
                <div className="text-center py-16 text-on-surface-variant">
                  <MaterialIcon icon="storage" size="2xl" className="text-outline mb-3 opacity-40" />
                  <p className="text-title-md">暂无 DataSource 配置</p>
                  <p className="text-body-sm mt-1">点击上方按钮创建第一个数据源</p>
                </div>
              )}
              <div className="space-y-2">
                {Object.entries(dataSources).map(([key, entry]) => (
                  <div key={key} className="flex items-center gap-3 px-4 py-3 bg-surface border border-outline-variant rounded-xl hover:shadow-sm transition-all cursor-pointer" onClick={() => startEdit(key, entry)}>
                    <span className="text-label-sm font-bold font-mono text-on-surface min-w-[100px] truncate">{key}</span>
                    <span className="text-body-sm text-on-surface-variant flex-1 truncate">{entry.label}</span>
                    {entry.pageUrl && <span className="text-body-xs text-on-surface-variant/60 flex-1 truncate hidden md:inline">{entry.pageUrl}</span>}
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-mono flex-shrink-0">{entry.apiPatternKey}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0">{entry.pagination?.type === 'page' ? '翻页' : '滚动'}</span>
                    <button onClick={(e) => { e.stopPropagation(); startEdit(key, entry); }} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-label-sm text-on-surface-variant hover:bg-surface-container-high transition-colors flex-shrink-0">
                      <MaterialIcon icon="edit" size="xs" />编辑
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
