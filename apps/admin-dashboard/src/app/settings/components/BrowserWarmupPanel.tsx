'use client';

import { useState, useEffect, useRef } from 'react';
import { ToggleSwitch } from '@/components/ui/StatusPill';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { useAutomationConfig, useUpdateAutomationConfig } from '@/hooks/useApi';

export default function BrowserWarmupPanel() {
  const autoQuery = useAutomationConfig();
  const updateAuto = useUpdateAutomationConfig();
  const [autoForm, setAutoForm] = useState({
    monitor: { interval_active_min: 3, interval_active_max: 5, interval_idle_min: 15, interval_idle_max: 20, idle_threshold: 5, sleep_start_hour: 0, sleep_end_hour: 6 },
    browser: { max_tab_reuse: 50, enable_warmup: true },
  });
  const autoInitRef = useRef(false);

  useEffect(() => {
    if (autoQuery.data && !autoInitRef.current) {
      const d = autoQuery.data;
      setAutoForm({
        monitor: {
          interval_active_min: 3, interval_active_max: 5, interval_idle_min: 15, interval_idle_max: 20,
          idle_threshold: 5, sleep_start_hour: 0, sleep_end_hour: 6,
          ...(d.monitor || {}),
        },
        browser: { max_tab_reuse: 50, enable_warmup: true, ...(d.browser || {}) },
      });
      autoInitRef.current = true;
    }
  }, [autoQuery.data]);

  return (
    <div className="border-t border-outline-variant pt-6">
      <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">浏览器养号</h4>
      {autoQuery.isLoading ? <PanelSkeleton rows={2} /> : autoQuery.isError ? <QueryError /> : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-label-md text-label-md text-on-surface-variant">最大标签复用次数</label>
            <input
              type="number"
              className="form-input font-mono text-sm"
              value={(autoForm.browser as any).max_tab_reuse ?? 50}
              onChange={(e) => setAutoForm((prev) => ({ ...prev, browser: { ...prev.browser, max_tab_reuse: parseInt(e.target.value) || 0 } }))}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-label-md text-label-md text-on-surface-variant">启用预热</span>
            <ToggleSwitch
              checked={(autoForm.browser as any).enable_warmup ?? true}
              onChange={(v) => setAutoForm((prev) => ({ ...prev, browser: { ...prev.browser, enable_warmup: v } }))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
