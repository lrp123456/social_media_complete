'use client';

import { useState } from 'react';
import { usePlatformConfigs, useUpdateConfig } from '@/hooks/useApi';

const PLATFORM_TABS = ['douyin', 'kuaishou', 'xiaohongshu'];

export default function SettingsPage() {
  const [platform, setPlatform] = useState('douyin');
  const { data, isLoading } = usePlatformConfigs(platform);
  const updateConfig = useUpdateConfig();
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);

  return (
    <div>
      <h2 className="text-headline-lg mb-1">系统设置</h2>
      <p className="text-sm text-on-surface-variant mb-8">平台配置管理 · LLM Keys · 选择器热更新</p>

      {/* Platform Tabs */}
      <div className="flex gap-2 mb-6">
        {PLATFORM_TABS.map((p) => (
          <button
            key={p}
            onClick={() => setPlatform(p)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              platform === p ? 'bg-primary text-white' : 'bg-white text-on-surface-variant border border-surface-high hover:bg-surface'
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Config Table */}
      <div className="bg-white rounded-lg border border-surface-high overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-on-surface-variant">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">配置项</th>
              <th className="text-left px-4 py-3 font-semibold">值</th>
              <th className="text-left px-4 py-3 font-semibold">版本</th>
              <th className="text-right px-4 py-3 font-semibold">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-on-surface-variant">加载中...</td></tr>
            ) : (
              data?.map((c: any) => (
                <tr key={`${c.platform}:${c.configKey}`} className="border-t border-surface-high">
                  <td className="px-4 py-3 font-medium">{c.configKey}</td>
                  <td className="px-4 py-3 text-on-surface-variant truncate max-w-xs">{c.configValue}</td>
                  <td className="px-4 py-3">v{c.version}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing({ key: c.configKey, value: c.configValue })}
                      className="text-primary hover:underline text-xs font-medium"
                    >
                      编辑
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Edit Modal (simplified) */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg">
            <h3 className="font-semibold mb-4">编辑: {editing.key}</h3>
            <textarea
              className="w-full border rounded-md p-3 text-sm font-mono h-32"
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            />
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => setEditing(null)} className="px-4 py-2 text-sm text-on-surface-variant">取消</button>
              <button
                onClick={() => {
                  updateConfig.mutate({ platform, configKey: editing.key, configValue: editing.value });
                  setEditing(null);
                }}
                className="px-4 py-2 text-sm bg-primary text-white rounded-md"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
