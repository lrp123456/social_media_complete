'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import {
  useFrameworks,
  useUpsertFramework,
  useDeleteFramework,
} from '@/hooks/useApi';
import type { FrameworkEntry } from '@/hooks/useApi';

// ─── 常量 ───

const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  tencent: '视频号',
};

const PLATFORM_ICONS: Record<string, string> = {
  douyin: 'play_arrow',
  kuaishou: 'movie_filter',
  xiaohongshu: 'book',
  tencent: 'videocam',
};

const PLATFORM_COLORS: Record<string, string> = {
  douyin: 'text-black',
  kuaishou: 'text-yellow-500',
  xiaohongshu: 'text-red-500',
  tencent: 'text-green-500',
};

// ─── Props ───

type FrameworkManagerProps = {
  platform: string;
  onClose: () => void;
};

// ─── 组件 ───

export default function FrameworkManager({ platform, onClose }: FrameworkManagerProps) {
  const { data: frameworks, isLoading } = useFrameworks(platform);
  const upsertFramework = useUpsertFramework();
  const deleteFramework = useDeleteFramework();

  const [editing, setEditing] = useState<{
    key: string;
    entry: FrameworkEntry;
    isNew?: boolean;
  } | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // frameworks is expected to be a Record<string, FrameworkEntry>
  const entries: Array<[string, FrameworkEntry]> = frameworks
    ? Object.entries(frameworks)
    : [];

  const handleSave = async () => {
    if (!editing) return;
    try {
      await upsertFramework.mutateAsync({
        platform,
        key: editing.key,
        entry: editing.entry,
      });
      showToast(editing.isNew ? '大框架已创建' : '大框架已保存', 'success');
      setEditing(null);
    } catch (e: any) {
      showToast(e?.response?.data?.error || '保存失败', 'error');
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`确认删除大框架 "${key}"？`)) return;
    try {
      await deleteFramework.mutateAsync({ platform, key });
      showToast('大框架已删除', 'success');
    } catch (e: any) {
      showToast(e?.response?.data?.error || '删除失败', 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* 弹窗 */}
      <div className="relative bg-white rounded-xl shadow-2xl w-[680px] max-h-[84vh] flex flex-col border border-gray-200 overflow-hidden">
        {/* Toast */}
        {toast && (
          <div className={cn(
            'absolute top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-in slide-in-from-top-2',
            toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white',
          )}>
            {toast.msg}
          </div>
        )}

        {/* ── 标题栏 ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-3">
            <div className={cn(
              'w-9 h-9 rounded-lg flex items-center justify-center',
              'bg-gray-100',
            )}>
              <MaterialIcon
                icon={(PLATFORM_ICONS[platform] || 'language') as any}
                size="sm"
                className={PLATFORM_COLORS[platform] || 'text-gray-600'}
              />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {PLATFORM_LABELS[platform] || platform} — 大框架容器管理
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">
                管理页面大框架容器的 CSS 选择器配置
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-gray-100 transition-colors"
          >
            <MaterialIcon icon="close" size="sm" />
          </button>
        </div>

        {/* ── 内容区 ── */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : entries.length === 0 && !editing ? (
            <div className="text-center py-16 text-gray-400">
              <MaterialIcon icon="inventory_2" size="2xl" className="text-gray-300 mb-3" />
              <p className="text-base font-medium text-gray-500">暂无大框架容器</p>
              <p className="text-sm mt-1">点击下方按钮添加第一个大框架</p>
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map(([key, entry]) => (
                <div
                  key={key}
                  className="bg-gray-50 border border-gray-200 rounded-xl overflow-hidden hover:shadow-sm transition-all"
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/* 图标 */}
                    <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
                      <MaterialIcon icon="style" size="sm" className="text-indigo-600" />
                    </div>

                    {/* 信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-gray-900">{entry.label}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-mono">
                          {key}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-mono truncate max-w-[300px]">
                          {entry.selector}
                        </span>
                        {entry.description && (
                          <span className="text-xs text-gray-400 truncate">{entry.description}</span>
                        )}
                      </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setEditing({ key, entry: { ...entry } })}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-gray-200 transition-colors"
                      >
                        <MaterialIcon icon="edit" size="xs" />编辑
                      </button>
                      <button
                        onClick={() => handleDelete(key)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                      >
                        <MaterialIcon icon="delete" size="xs" />删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── 底部操作栏 ── */}
        <div className="border-t border-gray-200 px-6 py-4 flex items-center justify-between shrink-0 bg-white">
          {editing ? (
            <>
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition-colors"
              >
                取消
              </button>
              <div className="flex items-center gap-2">
                {!editing.isNew && (
                  <button
                    onClick={() => handleDelete(editing.key)}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <MaterialIcon icon="delete" size="xs" />删除
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={upsertFramework.isPending}
                  className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-all disabled:opacity-50"
                >
                  {upsertFramework.isPending ? '保存中…' : (editing.isNew ? '创建' : '保存')}
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-400">
                共 {entries.length} 个大框架容器
              </span>
              <button
                onClick={() => setEditing({
                  key: '',
                  entry: { label: '', key: '', selector: '', description: '' },
                  isNew: true,
                })}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-all"
              >
                <MaterialIcon icon="add" size="sm" />新增大框架
              </button>
            </>
          )}
        </div>

        {/* ── 编辑/新增表单 (内联) ── */}
        {editing && (
          <div className="border-t border-gray-200 px-6 py-5 space-y-4 bg-gray-50 shrink-0">
            <h3 className="text-sm font-bold text-gray-800">
              {editing.isNew ? '新增大框架容器' : `编辑: ${editing.key}`}
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">
                  标签 (label)
                </label>
                <input
                  value={editing.entry.label}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      entry: { ...editing.entry, label: e.target.value },
                    })
                  }
                  placeholder="视频列表容器"
                  className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">
                  标识键 (key)
                </label>
                <input
                  value={editing.isNew ? editing.key : editing.key}
                  onChange={(e) => {
                    if (editing.isNew) {
                      setEditing({ ...editing, key: e.target.value });
                    }
                  }}
                  readOnly={!editing.isNew}
                  placeholder="video_list_container"
                  className={cn(
                    'w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500',
                    !editing.isNew && 'bg-gray-100 text-gray-400 cursor-not-allowed',
                  )}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                选择器 (selector)
              </label>
              <input
                value={editing.entry.selector}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    entry: { ...editing.entry, selector: e.target.value },
                  })
                }
                placeholder="div.video-list > .container"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                描述 (description)
              </label>
              <input
                value={editing.entry.description || ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    entry: { ...editing.entry, description: e.target.value },
                  })
                }
                placeholder="大框架容器的用途说明"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
