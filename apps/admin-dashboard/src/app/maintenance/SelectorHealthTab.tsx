'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';
import { SectionCard } from '@/components/ui/Bento';
import { cn } from '@/lib/utils';
import { useSelectorHealth } from '@/hooks/useApi';

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok'];

export default function SelectorHealthTab() {
  const [platform, setPlatform] = useState('');
  const [sortField, setSortField] = useState<string>('degradationRate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const { data, isLoading, refetch } = useSelectorHealth(platform || undefined);

  const selectors = Array.isArray(data) ? data : data?.selectors ?? [];

  // Sort
  const sorted = [...selectors].sort((a: any, b: any) => {
    const av = a[sortField] ?? 0;
    const bv = b[sortField] ?? 0;
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  function SortIcon({ field }: { field: string }) {
    if (sortField !== field) return <MaterialIcon icon="sort" size="xs" className="opacity-30" />;
    return (
      <MaterialIcon
        icon={sortDir === 'desc' ? 'expand_more' : 'expand_less'}
        size="xs"
        className="text-primary"
      />
    );
  }

  function DegradationRateBadge({ rate }: { rate: number }) {
    const pct = (rate * 100).toFixed(1);
    if (rate >= 0.3) {
      return <span className="text-error font-semibold">{pct}%</span>;
    }
    if (rate >= 0.15) {
      return <span className="text-amber-600 font-semibold">{pct}%</span>;
    }
    return <span className="text-on-surface-variant">{pct}%</span>;
  }

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-headline-md text-headline-md text-on-surface">选择器健康</h2>
          <p className="font-body text-body-sm text-on-surface-variant mt-1">
            各平台选择器的历史执行成功率与健康状况
          </p>
        </div>
        <div className="flex gap-2">
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
          <button onClick={() => refetch()} className="btn-secondary">
            <MaterialIcon icon="refresh" size="sm" />
            刷新
          </button>
        </div>
      </div>

      {/* Table */}
      <SectionCard noPadding>
        {isLoading ? (
          <div className="p-8">
            <div className="space-y-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-10 rounded bg-on-surface-variant/10 animate-pulse" />
              ))}
            </div>
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
            <MaterialIcon icon="bug_report" size="2xl" className="opacity-30 mb-2" />
            <p className="font-body text-body-sm">暂无选择器健康数据</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-flat">
              <thead>
                <tr>
                  <th className="whitespace-nowrap">平台</th>
                  <th className="whitespace-nowrap">选择器</th>
                  <th className="whitespace-nowrap">类型</th>
                  <th
                    className="whitespace-nowrap cursor-pointer select-none"
                    onClick={() => toggleSort('totalAttempts')}
                  >
                    <span className="inline-flex items-center gap-1">
                      总次数 <SortIcon field="totalAttempts" />
                    </span>
                  </th>
                  <th
                    className="whitespace-nowrap cursor-pointer select-none"
                    onClick={() => toggleSort('successRate')}
                  >
                    <span className="inline-flex items-center gap-1">
                      成功率 <SortIcon field="successRate" />
                    </span>
                  </th>
                  <th className="whitespace-nowrap">主选择器率</th>
                  <th
                    className="whitespace-nowrap cursor-pointer select-none"
                    onClick={() => toggleSort('degradationRate')}
                  >
                    <span className="inline-flex items-center gap-1">
                      降级率 <SortIcon field="degradationRate" />
                    </span>
                  </th>
                  <th className="whitespace-nowrap">耗时(ms)</th>
                  <th className="whitespace-nowrap">最后使用</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((sel: any, idx: number) => {
                  const successRate = sel.totalAttempts > 0
                    ? ((sel.successCount / sel.totalAttempts) * 100).toFixed(1)
                    : '-';
                  const degRate = sel.totalAttempts > 0
                    ? sel.degradedCount != null
                      ? (sel.degradedCount / sel.totalAttempts)
                      : 1 - (sel.successCount / sel.totalAttempts)
                    : 0;
                  const primaryRate = sel.primarySuccessCount != null && sel.totalAttempts > 0
                    ? ((sel.primarySuccessCount / sel.totalAttempts) * 100).toFixed(1)
                    : '-';

                  return (
                    <tr key={sel.key || sel.name || idx}>
                      <td className="font-medium">{sel.platform}</td>
                      <td className="font-mono text-body-sm max-w-[240px] truncate" title={sel.name || sel.key}>
                        {sel.name || sel.key}
                      </td>
                      <td>
                        <StatusPill tone="neutral">{sel.selectorType || sel.category || '-'}</StatusPill>
                      </td>
                      <td>{sel.totalAttempts ?? 0}</td>
                      <td className={cn(Number(successRate) < 80 ? 'text-error' : Number(successRate) < 95 ? 'text-amber-600' : '')}>
                        {successRate}%
                      </td>
                      <td>{primaryRate}%</td>
                      <td>
                        <DegradationRateBadge rate={degRate} />
                      </td>
                      <td className="text-on-surface-variant">{sel.avgDurationMs != null ? Math.round(sel.avgDurationMs) : '-'}</td>
                      <td className="text-on-surface-variant text-body-sm">
                        {sel.lastUsedAt ? new Date(sel.lastUsedAt).toLocaleDateString() : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
