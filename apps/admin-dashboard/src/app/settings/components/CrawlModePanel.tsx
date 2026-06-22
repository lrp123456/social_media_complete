'use client';

import { useState, useEffect } from 'react';
import { useCrawlSettings, useUpdateCrawlSetting } from '@/hooks/useApi';

export default function CrawlModePanel() {
  const { data: settingsData, isLoading } = useCrawlSettings() as { data: any[]; isLoading: boolean };
  const updateCrawlSetting = useUpdateCrawlSetting();
  const [localSettings, setLocalSettings] = useState<Record<string, { mode: 'deep' | 'light'; enabled: boolean }>>({});

  // Initialize local state when data loads
  useEffect(() => {
    if (settingsData && Array.isArray(settingsData)) {
      const initial: Record<string, { mode: 'deep' | 'light'; enabled: boolean }> = {};
      settingsData.forEach((s) => {
        initial[s.platform] = { mode: s.mode, enabled: s.enabled };
      });
      setLocalSettings(initial);
    }
  }, [settingsData]);

  const handleModeChange = (platform: string, mode: 'deep' | 'light') => {
    setLocalSettings((prev) => ({ ...prev, [platform]: { ...prev[platform], mode } }));
  };

  const handleEnabledChange = (platform: string, enabled: boolean) => {
    setLocalSettings((prev) => ({ ...prev, [platform]: { ...prev[platform], enabled } }));
  };

  const handleSave = async (platform: string) => {
    const setting = localSettings[platform];
    if (!setting) return;
    try {
      await updateCrawlSetting.mutateAsync({ platform, mode: setting.mode, enabled: setting.enabled });
    } catch (e) {
      console.error('更新爬取配置失败', e);
    }
  };

  if (isLoading) {
    return <div className="text-on-surface-variant py-4">加载中…</div>;
  }

  if (!settingsData || !Array.isArray(settingsData) || settingsData.length === 0) {
    return <div className="text-on-surface-variant py-4">暂无爬取配置</div>;
  }

  return (
    <div className="space-y-3">
      {settingsData.map((setting) => {
        const local = localSettings[setting.platform] || { mode: setting.mode, enabled: setting.enabled };
        const isXiaohongshu = setting.platform === 'xiaohongshu';
        return (
          <div key={setting.platform} className="flex items-center gap-4 p-3 bg-surface border border-outline-variant rounded-lg">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-label-md text-on-surface font-medium">{setting.platformName}</span>
                {isXiaohongshu && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">仅支持轻量</span>
                )}
              </div>
              <p className="text-[11px] text-on-surface-variant mt-0.5">
                {local.mode === 'deep' ? '深度爬取：获取评论详情' : '轻量通知：仅监控评论数量变化'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <select
                className="form-input text-sm py-1"
                value={local.mode}
                onChange={(e) => handleModeChange(setting.platform, e.target.value as 'deep' | 'light')}
                disabled={isXiaohongshu}
              >
                <option value="deep">深度爬取</option>
                <option value="light">轻量通知</option>
              </select>
              <button
                onClick={() => handleSave(setting.platform)}
                disabled={updateCrawlSetting.isPending || local.mode === setting.mode}
                className="btn-primary text-xs px-3 py-1 disabled:opacity-40"
              >
                {updateCrawlSetting.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
