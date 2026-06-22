'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon, type MaterialIconName } from '@/components/ui/MaterialIcon';
import { AccentBar } from '@/components/ui/Bento';
import { RoleBadge, MetricBar, ToggleSwitch } from '@/components/ui/StatusPill';

const FALLBACK_PROVIDERS = [
  { name: 'groq', displayName: 'Groq Cloud', role: 'primary', apiKeyMasked: 'gsk_xxxxxx_mock_key_xxxxxx', failoverEnabled: true, monthlyUsage: '4.2M', status: 'ok' },
  { name: 'google', displayName: 'Google Gemini', role: 'fallback_1', apiKeyMasked: 'AIzaSy_xxxxxx_mock_key_xxxxxx', failoverEnabled: true, monthlyUsage: '850K', status: 'ok' },
  { name: 'zhipu', displayName: '智谱 GLM', role: 'fallback_2', apiKeyMasked: 'zhipu_xxxxxx_mock_key_xxxxxx', failoverEnabled: false, monthlyUsage: '5.0M', status: 'error' },
];

export function ProviderCard({
  provider,
}: {
  provider: (typeof FALLBACK_PROVIDERS)[number];
}) {
  const hasError = provider.status === 'error';
  const initials = provider.displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2);
  const usage: any = provider.monthlyUsage;
  let usagePercent: number;
  let usageDisplay: string;
  if (typeof usage === 'string') {
    const n = parseFloat(usage);
    const isM = usage.endsWith('M');
    usagePercent = isM ? Math.min((n / 10) * 100, 100) : Math.min((n / 5000) * 100, 100);
    usageDisplay = usage;
  } else if (usage && typeof usage === 'object') {
    const used = Number(usage.used) || 0;
    const total = Number(usage.total) || 1;
    usagePercent = Math.min((used / total) * 100, 100);
    const fmt = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
    usageDisplay = `${fmt(used)} / ${fmt(total)}`;
  } else {
    usagePercent = 0;
    usageDisplay = '—';
  }

  const accentColor = hasError ? 'error' : provider.role === 'primary' ? 'primary' : 'tertiary';
  const metricTone = hasError ? 'error' : provider.role === 'primary' ? 'primary' : 'tertiary';
  const [failover, setFailover] = useState(provider.failoverEnabled);

  return (
    <div
      className={cn(
        'border rounded-lg p-4 bg-surface flex flex-col md:flex-row gap-6 relative overflow-hidden',
        hasError ? 'border-error/30 bg-error-container/10' : 'border-outline-variant',
      )}
    >
      <AccentBar color={accentColor} />
      <div className="flex-1 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-on-surface text-surface flex items-center justify-center font-bold font-mono text-sm">
              {initials}
            </div>
            <h4 className="text-label-md text-label-md text-on-surface">{provider.displayName}</h4>
            <RoleBadge role={provider.role} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-label-md text-label-md text-on-surface-variant">故障转移启用</span>
            <ToggleSwitch id={`failover-${provider.name}`} checked={failover} onChange={setFailover} />
          </div>
        </div>
        <div className="space-y-1">
          <label className={cn('text-label-md text-label-md', hasError ? 'text-error' : 'text-on-surface-variant')}>
            API Key
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={provider.apiKeyMasked}
              readOnly
              className={cn('flex-1 form-input font-mono text-sm', hasError && 'border-error/50')}
            />
            <button type="button" title="验证连接" className="btn-icon">
              <MaterialIcon icon="bolt" size="lg" className={hasError ? 'text-error' : 'text-primary'} />
            </button>
          </div>
        </div>
      </div>
      <div className="w-full md:w-48 border-t md:border-t-0 md:border-l border-outline-variant pt-4 md:pt-0 md:pl-6 flex flex-col justify-center">
        <span className="text-label-md text-label-md text-on-surface-variant">本月 Token 消耗</span>
        <span className="text-headline-md text-headline-md text-on-surface">{usageDisplay}</span>
        <MetricBar percent={usagePercent} tone={metricTone} />
      </div>
    </div>
  );
}
