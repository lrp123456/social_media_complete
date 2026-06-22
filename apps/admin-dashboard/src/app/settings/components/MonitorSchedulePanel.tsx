'use client';

import { useState, useEffect, useRef } from 'react';
import { BentoCard } from '@/components/ui/Bento';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { HOUR_OPTIONS } from '../shared/constants';
import { useAutomationConfig, useUpdateAutomationConfig } from '@/hooks/useApi';

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'] as const;
const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', tencent: '视频号',
};

interface MonitorForm {
  interval_active_min: number;
  interval_active_max: number;
  interval_idle_min: number;
  interval_idle_max: number;
  idle_threshold: number;
  sleep_start_hour: number;
  sleep_end_hour: number;
}

interface PlatformOverride {
  interval_active_min?: number;
  interval_active_max?: number;
  interval_idle_min?: number;
  interval_idle_max?: number;
  idle_threshold?: number;
}

const DEFAULT_GLOBAL: MonitorForm = {
  interval_active_min: 180,
  interval_active_max: 300,
  interval_idle_min: 900,
  interval_idle_max: 1200,
  idle_threshold: 4,
  sleep_start_hour: 2,
  sleep_end_hour: 8,
};

export default function MonitorSchedulePanel() {
  const { data: automation, isLoading, isError } = useAutomationConfig();
  const updateMutation = useUpdateAutomationConfig();

  const [globalForm, setGlobalForm] = useState<MonitorForm>(DEFAULT_GLOBAL);
  const [overrides, setOverrides] = useState<Record<string, PlatformOverride>>({});
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (automation && !initRef.current) {
      const m = automation.monitor || {};
      setGlobalForm({
        interval_active_min: m.interval_active_min ?? DEFAULT_GLOBAL.interval_active_min,
        interval_active_max: m.interval_active_max ?? DEFAULT_GLOBAL.interval_active_max,
        interval_idle_min: m.interval_idle_min ?? DEFAULT_GLOBAL.interval_idle_min,
        interval_idle_max: m.interval_idle_max ?? DEFAULT_GLOBAL.interval_idle_max,
        idle_threshold: m.idle_threshold ?? DEFAULT_GLOBAL.idle_threshold,
        sleep_start_hour: m.sleep_start_hour ?? DEFAULT_GLOBAL.sleep_start_hour,
        sleep_end_hour: m.sleep_end_hour ?? DEFAULT_GLOBAL.sleep_end_hour,
      });
      setOverrides(m.platformOverrides ? { ...m.platformOverrides } : {});
      initRef.current = true;
    }
  }, [automation]);

  const handleGlobalChange = (key: keyof MonitorForm, value: number) => {
    setGlobalForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleOverrideChange = (platform: string, key: keyof PlatformOverride, value: number) => {
    setOverrides((prev) => ({
      ...prev,
      [platform]: { ...(prev[platform] || {}), [key]: value },
    }));
  };

  const removeOverride = (platform: string, key: keyof PlatformOverride) => {
    setOverrides((prev) => {
      const current = { ...(prev[platform] || {}) };
      delete current[key];
      if (Object.keys(current).length === 0) {
        const next = { ...prev };
        delete next[platform];
        return next;
      }
      return { ...prev, [platform]: current };
    });
  };

  const getEffectiveValue = (platform: string, key: keyof PlatformOverride & keyof MonitorForm): string => {
    const overrideVal = overrides[platform]?.[key as keyof PlatformOverride];
    if (overrideVal !== undefined) return String(overrideVal);
    return `${globalForm[key as keyof MonitorForm]}（使用全局）`;
  };

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        monitor: {
          ...globalForm,
          platformOverrides: overrides,
        },
      });
    } catch (e) {
      console.error('保存监控调度配置失败', e);
    }
  };

  if (isLoading) {
    return (
      <BentoCard>
        <h3 className="text-headline-md text-on-surface mb-4">监控调度周期</h3>
        <PanelSkeleton rows={5} />
      </BentoCard>
    );
  }

  if (isError) {
    return (
      <BentoCard>
        <h3 className="text-headline-md text-on-surface mb-4">监控调度周期</h3>
        <QueryError />
      </BentoCard>
    );
  }

  return (
    <BentoCard>
      <div className="flex items-center gap-2 mb-4">
        <MaterialIcon icon="schedule" size="md" className="text-primary" />
        <h3 className="text-headline-md text-on-surface">监控调度周期</h3>
      </div>

      {/* 全局默认参数 */}
      <div className="mb-6">
        <h4 className="text-label-md text-on-surface-variant font-medium mb-3">全局默认参数</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="text-label-sm text-on-surface-variant">高频周期最小值 (秒)</label>
            <input
              type="number"
              className="form-input font-mono text-sm"
              value={globalForm.interval_active_min}
              onChange={(e) => handleGlobalChange('interval_active_min', parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-label-sm text-on-surface-variant">高频周期最大值 (秒)</label>
            <input
              type="number"
              className="form-input font-mono text-sm"
              value={globalForm.interval_active_max}
              onChange={(e) => handleGlobalChange('interval_active_max', parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-label-sm text-on-surface-variant">空闲周期最小值 (秒)</label>
            <input
              type="number"
              className="form-input font-mono text-sm"
              value={globalForm.interval_idle_min}
              onChange={(e) => handleGlobalChange('interval_idle_min', parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-label-sm text-on-surface-variant">空闲周期最大值 (秒)</label>
            <input
              type="number"
              className="form-input font-mono text-sm"
              value={globalForm.interval_idle_max}
              onChange={(e) => handleGlobalChange('interval_idle_max', parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-label-sm text-on-surface-variant">空闲阈值</label>
            <input
              type="number"
              className="form-input font-mono text-sm"
              value={globalForm.idle_threshold}
              onChange={(e) => handleGlobalChange('idle_threshold', parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-label-sm text-on-surface-variant">休眠开始时间</label>
            <select
              className="form-input font-mono text-sm"
              value={globalForm.sleep_start_hour}
              onChange={(e) => handleGlobalChange('sleep_start_hour', parseInt(e.target.value))}
            >
              {HOUR_OPTIONS.map((h) => (
                <option key={h} value={h}>{h}:00</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-label-sm text-on-surface-variant">休眠结束时间</label>
            <select
              className="form-input font-mono text-sm"
              value={globalForm.sleep_end_hour}
              onChange={(e) => handleGlobalChange('sleep_end_hour', parseInt(e.target.value))}
            >
              {HOUR_OPTIONS.map((h) => (
                <option key={h} value={h}>{h}:00</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 按平台覆盖 */}
      <div>
        <h4 className="text-label-md text-on-surface-variant font-medium mb-3">按平台覆盖</h4>
        <div className="space-y-2">
          {PLATFORMS.map((platform) => {
            const isExpanded = expandedPlatform === platform;
            const hasOverrides = overrides[platform] && Object.keys(overrides[platform]).length > 0;
            return (
              <div key={platform} className="border border-outline-variant rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpandedPlatform(isExpanded ? null : platform)}
                  className="flex items-center justify-between w-full px-4 py-2.5 bg-surface-container/30 hover:bg-surface-container/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{PLATFORM_LABELS[platform]}</span>
                    {hasOverrides && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">已覆盖</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-on-surface-variant">
                      active: {getEffectiveValue(platform, 'interval_active_min')}~{getEffectiveValue(platform, 'interval_active_max')}s
                    </span>
                    <MaterialIcon icon={isExpanded ? 'expand_less' : 'expand_more'} size="sm" className="text-on-surface-variant" />
                  </div>
                </button>
                {isExpanded && (
                  <div className="p-4 border-t border-outline-variant bg-surface-container-lowest">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {(['interval_active_min', 'interval_active_max', 'interval_idle_min', 'interval_idle_max', 'idle_threshold'] as const).map((key) => {
                        const labelMap: Record<string, string> = {
                          interval_active_min: '高频周期最小值',
                          interval_active_max: '高频周期最大值',
                          interval_idle_min: '空闲周期最小值',
                          interval_idle_max: '空闲周期最大值',
                          idle_threshold: '空闲阈值',
                        };
                        const currentVal = overrides[platform]?.[key];
                        return (
                          <div key={key} className="space-y-1">
                            <label className="text-label-sm text-on-surface-variant">{labelMap[key]} (秒)</label>
                            <div className="flex gap-2">
                              <input
                                type="number"
                                className="form-input font-mono text-sm flex-1"
                                placeholder={`全局: ${globalForm[key]}`}
                                value={currentVal ?? ''}
                                onChange={(e) => {
                                  const v = parseInt(e.target.value);
                                  if (!isNaN(v)) {
                                    handleOverrideChange(platform, key, v);
                                  } else if (e.target.value === '') {
                                    removeOverride(platform, key);
                                  }
                                }}
                              />
                              {currentVal !== undefined && (
                                <button
                                  onClick={() => removeOverride(platform, key)}
                                  className="text-xs text-on-surface-variant hover:text-error px-1"
                                  title="恢复为全局默认"
                                >
                                  <MaterialIcon icon="replay" size="sm" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 保存按钮 */}
      <div className="mt-6 flex justify-end">
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="btn-primary px-6 py-2 text-sm disabled:opacity-40"
        >
          {updateMutation.isPending ? '保存中…' : '保存配置'}
        </button>
      </div>
    </BentoCard>
  );
}
