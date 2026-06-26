'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { SectionCard } from '@/components/ui/Bento';
import { cn } from '@/lib/utils';
import { useMaintenanceExecutions } from '@/hooks/useApi';
import type { MaintenanceHealth } from '@/hooks/useApi';
import { HealthBadge, SelectorResultBadge, FlowLabel, relativeTime } from './components';
import ExecutionDetailTab from './ExecutionDetailTab';

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok'];
const FLOW_TYPES = ['login', 'publish', 'monitor', 'collect', 'maintenance'];

export default function ExecutionHealthTab() {
  const [platform, setPlatform] = useState('');
  const [healthStatus, setHealthStatus] = useState('');
  const [flowType, setFlowType] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, refetch } = useMaintenanceExecutions({
    platform: platform || undefined,
    healthStatus: healthStatus ? (healthStatus as MaintenanceHealth) : undefined,
    flowType: flowType || undefined,
    limit: 50,
  });

  // If an execution is selected, show detail view
  if (selectedId) {
    return <ExecutionDetailTab executionId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const executions = Array.isArray(data) ? data : data?.executions ?? [];

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-headline-md text-headline-md text-on-surface">执行健康</h2>
          <p className="font-body text-body-sm text-on-surface-variant mt-1">
            查看所有维护任务的执行记录与健康状态
          </p>
        </div>
        <button onClick={() => refetch()} className="btn-secondary">
          <MaterialIcon icon="refresh" size="sm" />
          刷新
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select
          className="form-input w-auto"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="">全部平台</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="form-input w-auto"
          value={healthStatus}
          onChange={(e) => setHealthStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="healthy">健康</option>
          <option value="degraded">降级</option>
          <option value="failed">失败</option>
        </select>
        <select
          className="form-input w-auto"
          value={flowType}
          onChange={(e) => setFlowType(e.target.value)}
        >
          <option value="">全部类型</option>
          {FLOW_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <SectionCard noPadding>
        {isLoading ? (
          <div className="p-8">
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-10 rounded bg-on-surface-variant/10 animate-pulse" />
              ))}
            </div>
          </div>
        ) : executions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
            <MaterialIcon icon="history" size="2xl" className="opacity-30 mb-2" />
            <p className="font-body text-body-sm">暂无执行记录</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-flat">
              <thead>
                <tr>
                  <th className="whitespace-nowrap">平台</th>
                  <th className="whitespace-nowrap">流程</th>
                  <th className="whitespace-nowrap">窗口</th>
                  <th className="whitespace-nowrap">健康</th>
                  <th className="whitespace-nowrap">步骤(通过/总计)</th>
                  <th className="whitespace-nowrap">选择器</th>
                  <th className="whitespace-nowrap">URL 检测</th>
                  <th className="whitespace-nowrap">执行时间</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((ex: any) => (
                  <tr
                    key={ex.id}
                    className="cursor-pointer hover:bg-surface-container-low transition-colors"
                    onClick={() => setSelectedId(ex.id)}
                  >
                    <td className="font-medium">{ex.platform}</td>
                    <td>
                      <FlowLabel flowType={ex.flowType} />
                    </td>
                    <td className="font-mono text-body-sm max-w-[120px] truncate" title={ex.windowId}>
                      {ex.windowId}
                    </td>
                    <td>
                      <HealthBadge health={ex.overallHealth} />
                    </td>
                    <td>
                      <span className={cn(ex.failedSteps > 0 ? 'text-error' : ex.degradedSteps > 0 ? 'text-amber-600' : '')}>
                        {ex.healthySteps}/{ex.totalSteps}
                      </span>
                      {ex.failedSteps > 0 && (
                        <span className="text-error text-label-sm text-label-sm ml-1">
                          (-{ex.failedSteps})
                        </span>
                      )}
                    </td>
                    <td>
                      <SelectorResultBadge passed={ex.passedSelectors} total={ex.totalSelectors} />
                    </td>
                    <td>
                      <SelectorResultBadge passed={ex.passedUrlChecks} total={ex.totalUrlChecks} />
                    </td>
                    <td className="text-on-surface-variant whitespace-nowrap">
                      {relativeTime(ex.startedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
