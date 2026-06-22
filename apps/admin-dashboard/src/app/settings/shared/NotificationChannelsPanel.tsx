'use client';

import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { AccentBar } from '@/components/ui/Bento';
import { StatusPill, ToggleSwitch } from '@/components/ui/StatusPill';

export function NotificationChannelsPanel({
  channels,
  rules,
  isLoading,
  onUpdateChannel,
  onUpdateRule,
}: {
  channels: any[];
  rules: any[];
  isLoading: boolean;
  onUpdateChannel: (c: any) => void;
  onUpdateRule: (r: any) => void;
}) {
  const channelIcon: Record<string, 'campaign' | 'link' | 'send' | 'language'> = {
    wechat_work: 'campaign',
    webhook: 'link',
    email: 'send',
    sms: 'language',
  };
  const eventLabel: Record<string, string> = {
    publish_success: '发布成功',
    publish_failed: '发布失败',
    risk_detected: '风控检测',
    monitor_anomaly: '监控异常',
    quota_exceeded: 'LLM 超额',
  };

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md flex items-center gap-2">
          <MaterialIcon icon="campaign" size="md" className="text-primary" />
          通知渠道 ({channels.length})
        </h4>
        {isLoading ? (
          <div className="text-center py-8 text-on-surface-variant">加载中…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-bento-gap">
            {channels.map((c) => (
              <div key={c.id} className="bento-card bg-surface">
                <AccentBar color={c.enabled ? 'primary' : 'tertiary'} />
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <MaterialIcon
                      icon={channelIcon[c.type] || 'send'}
                      size="md"
                      className={c.enabled ? 'text-primary' : 'text-on-surface-variant'}
                    />
                    <div className="flex-1 min-w-0">
                      <h5 className="text-label-md text-label-md text-on-surface truncate">{c.name}</h5>
                      <p className="font-mono text-[11px] text-outline uppercase">{c.type}</p>
                    </div>
                  </div>
                  <ToggleSwitch
                    id={`ch-${c.id}`}
                    checked={c.enabled}
                    onChange={(v) => onUpdateChannel({ id: c.id, enabled: v })}
                  />
                </div>
                {c.config && Object.keys(c.config).length > 0 && (
                  <div className="mt-3 space-y-1 text-body-sm">
                    {Object.entries(c.config).map(([k, v]: [string, any]) => (
                      <div key={k} className="flex items-center justify-between gap-2">
                        <span className="text-on-surface-variant truncate">{k}</span>
                        <span className="font-mono text-[12px] text-outline truncate max-w-[60%]" title={String(v)}>
                          {String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md flex items-center gap-2">
          <MaterialIcon icon="tune" size="md" className="text-primary" />
          触发规则 ({rules.length})
        </h4>
        {isLoading ? (
          <div className="text-center py-8 text-on-surface-variant">加载中…</div>
        ) : (
          <div className="space-y-3">
            {rules.map((r) => (
              <div key={r.id} className="bento-card bg-surface">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-label-md text-label-md text-on-surface">{r.name}</span>
                    <StatusPill tone="primary">{eventLabel[r.event] || r.event}</StatusPill>
                    {r.threshold && (
                      <span className="font-mono text-[11px] text-on-surface-variant">
                        {r.threshold.count}次 / {r.threshold.windowMinutes}分钟
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-body-sm text-on-surface-variant">
                      {r.channelIds.length} 渠道
                    </span>
                    <ToggleSwitch
                      id={`rule-${r.id}`}
                      checked={r.enabled}
                      onChange={(v) => onUpdateRule({ id: r.id, enabled: v })}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
