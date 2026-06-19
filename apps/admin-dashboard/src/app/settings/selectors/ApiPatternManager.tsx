'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { useApiPatterns, useUpsertApiPattern, useDeleteApiPattern } from '@/hooks/useApi';
import { FieldMappingEditor } from './FieldMappingEditor';
import type { ApiPatternEntry } from '@/hooks/useApi';

export function ApiPatternManager({
  platform,
  onClose,
}: {
  platform: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useApiPatterns(platform);
  const upsert = useUpsertApiPattern();
  const remove = useDeleteApiPattern();

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<{ key: string } & ApiPatternEntry>({
    key: '', pattern: '', description: '', responseArrayPath: [], hasMoreField: '', hasMoreCondition: '', cursorField: '', fieldMappings: {},
  });

  const patterns = data?.apiPatterns || {};

  const startEdit = (key: string, entry: any) => {
    setEditingKey(key);
    setForm({
      key,
      pattern: entry.pattern || '',
      description: entry.description || '',
      responseArrayPath: entry.responseArrayPath || [],
      hasMoreField: entry.hasMoreField || '',
      hasMoreCondition: entry.hasMoreCondition || '',
      cursorField: entry.cursorField || '',
      fieldMappings: entry.fieldMappings || {},
    });
  };

  const startNew = () => {
    setEditingKey(null);
    setForm({ key: '', pattern: '', description: '', responseArrayPath: [], hasMoreField: '', hasMoreCondition: '', cursorField: '', fieldMappings: {} });
  };

  const save = () => {
    if (!form.key || !form.pattern) return;
    upsert.mutate({
      platform,
      key: form.key,
      entry: {
        pattern: form.pattern,
        description: form.description,
        responseArrayPath: form.responseArrayPath?.length ? form.responseArrayPath : undefined,
        hasMoreField: form.hasMoreField || undefined,
        hasMoreCondition: form.hasMoreCondition || undefined,
        cursorField: form.cursorField || undefined,
        fieldMappings: form.fieldMappings && Object.keys(form.fieldMappings).length ? form.fieldMappings : undefined,
      },
    }, { onSuccess: () => startNew() });
  };

  const deleteEntry = (key: string) => {
    if (confirm(`删除 API Pattern "${key}"？`)) {
      remove.mutate({ platform, key });
    }
  };

  const addArrayPath = () => {
    setForm({ ...form, responseArrayPath: [...(form.responseArrayPath || []), ''] });
  };

  const updateArrayPath = (index: number, value: string) => {
    const paths = [...(form.responseArrayPath || [])];
    paths[index] = value;
    setForm({ ...form, responseArrayPath: paths });
  };

  const removeArrayPath = (index: number) => {
    const paths = [...(form.responseArrayPath || [])];
    paths.splice(index, 1);
    setForm({ ...form, responseArrayPath: paths });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[700px] max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">API Pattern 管理 — {platform}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <div className="text-center text-gray-400 py-8">加载中...</div>
          ) : (
            <div className="space-y-2">
              {Object.entries(patterns).map(([key, entry]: [string, any]) => (
                <div key={key} className="border rounded p-3 flex items-center gap-3">
                  <MaterialIcon icon="api" className="text-orange-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{key}</div>
                    <div className="text-xs text-gray-400 font-mono">{entry.pattern}</div>
                    {entry.description && <div className="text-xs text-gray-500 mt-0.5">{entry.description}</div>}
                  </div>
                  <button onClick={() => startEdit(key, entry)} className="text-blue-500 hover:text-blue-700 text-sm">编辑</button>
                  <button onClick={() => deleteEntry(key)} className="text-red-500 hover:text-red-700 text-sm">删除</button>
                </div>
              ))}
              {Object.keys(patterns).length === 0 && (
                <div className="text-center text-gray-400 py-4">暂无 API Pattern 配置</div>
              )}
            </div>
          )}
        </div>

        {/* 编辑/新增表单 */}
        <div className="border-t p-4 bg-gray-50 overflow-auto max-h-[50vh]">
          <div className="text-sm font-medium mb-2">{editingKey ? `编辑: ${editingKey}` : '新增 API Pattern'}</div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="Key (如 video_list.work_list)" disabled={!!editingKey} className="px-2 py-1 border rounded text-sm disabled:bg-gray-100" />
            <input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder="URL Pattern (如 /work_list)" className="px-2 py-1 border rounded text-sm font-mono" />
          </div>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="描述" className="w-full px-2 py-1 border rounded text-sm mb-2" />

          {/* 响应数组路径 */}
          <div className="mb-2">
            <div className="text-xs text-gray-500 mb-1">响应数组路径（按顺序探测）</div>
            {(form.responseArrayPath || []).map((p, i) => (
              <div key={i} className="flex gap-1 mb-1">
                <input value={p} onChange={(e) => updateArrayPath(i, e.target.value)} className="flex-1 px-2 py-1 border rounded text-xs font-mono" placeholder="items / data.list" />
                <button onClick={() => removeArrayPath(i)} className="text-red-400 hover:text-red-600 px-1">×</button>
              </div>
            ))}
            <button onClick={addArrayPath} className="text-xs text-blue-600 hover:text-blue-800">+ 添加路径</button>
          </div>

          {/* 分页字段 */}
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input value={form.hasMoreField} onChange={(e) => setForm({ ...form, hasMoreField: e.target.value })} placeholder="hasMore 字段 (has_more)" className="px-2 py-1 border rounded text-xs font-mono" />
            <input value={form.hasMoreCondition} onChange={(e) => setForm({ ...form, hasMoreCondition: e.target.value })} placeholder="hasMore 条件 (=== true)" className="px-2 py-1 border rounded text-xs font-mono" />
            <input value={form.cursorField} onChange={(e) => setForm({ ...form, cursorField: e.target.value })} placeholder="cursor 字段 (cursor)" className="px-2 py-1 border rounded text-xs font-mono" />
          </div>

          {/* 字段映射 */}
          <FieldMappingEditor
            mappings={form.fieldMappings || {}}
            onChange={(m) => setForm({ ...form, fieldMappings: m })}
          />

          <div className="flex gap-2 mt-3">
            <button onClick={save} disabled={!form.key || !form.pattern} className="px-4 py-1 bg-blue-500 text-white rounded text-sm disabled:opacity-50">保存</button>
            <button onClick={startNew} className="px-4 py-1 border rounded text-sm">取消</button>
          </div>
        </div>
      </div>
    </div>
  );
}
