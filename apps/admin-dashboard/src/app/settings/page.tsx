'use client';

import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react';
import {
  useInfraConfig,
  useUpdateInfraConfig,
  useLLMProviders,
  useLLMGroups,
  useUpdateLLMGroup,
  usePrompts,
  useUpdatePrompt,
  useMediaConfig,
  useUpdateMediaConfig,
  useAutomationConfig,
  useUpdateAutomationConfig,
  useCustomSelectors,
  useUpsertCustomSelector,
  useFlowRules,
  useUpdateFlowRules,
  useResetFlowRules,
  useDeleteCustomSelector,
  useNetworkConfig,
  useUpdateNetworkConfig,
  useNotificationChannels,
  useUpdateNotificationChannel,
  useNotificationRules,
  useUpdateNotificationRule,
  useWecomConfig,
  useUpdateWecomConfig,
  useRbacUsers,
  useCrawlSettings,
  useUpdateCrawlSetting,
  useCreateRbacUser,
  useUpdateRbacUser,
  useDeleteRbacUser,
  useAuditLogs,
  useSecurityApiKey,
  useRotateApiKey,
  type RbacUser,
  type LLMGroupConfig,
  type LLMPromptTemplate,
  type CustomSelector,
  type WecomConfig,
} from '@/hooks/useApi';
import { MaterialIcon, Avatar, type MaterialIconName } from '@/components/ui/MaterialIcon';
import { HeaderStrip, AccentBar, BentoCard } from '@/components/ui/Bento';
import { StatusPill, RoleBadge, MetricBar, ToggleSwitch } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Fallback data
// ---------------------------------------------------------------------------

const FALLBACK_PROVIDERS = [
  { name: 'groq', displayName: 'Groq Cloud', role: 'primary', apiKeyMasked: 'gsk_xxxxxx_mock_key_xxxxxx', failoverEnabled: true, monthlyUsage: '4.2M', status: 'ok' },
  { name: 'google', displayName: 'Google Gemini', role: 'fallback_1', apiKeyMasked: 'AIzaSy_xxxxxx_mock_key_xxxxxx', failoverEnabled: true, monthlyUsage: '850K', status: 'ok' },
  { name: 'zhipu', displayName: '智谱 GLM', role: 'fallback_2', apiKeyMasked: 'zhipu_xxxxxx_mock_key_xxxxxx', failoverEnabled: false, monthlyUsage: '5.0M', status: 'error' },
];

const MOCK_LOGS = [
  { id: '1', time: '2024-03-15 14:32:01', actor: 'Admin User', action: 'UPDATE_ENV', resource: 'system_env.REDIS_PORT', status: 'SUCCESS' },
  { id: '2', time: '2024-03-15 14:15:22', actor: 'System Agent', action: 'FAILOVER_TRIGGER', resource: 'llm_router.zhipu_glm', status: 'WARN' },
  { id: '3', time: '2024-03-15 09:01:45', actor: 'Admin User', action: 'USER_LOGIN', resource: 'auth.session', status: 'SUCCESS' },
];

// ---------------------------------------------------------------------------
// Types & Nav
// ---------------------------------------------------------------------------

type SectionId =
  | 'panel-infra'
  | 'panel-llm-creds'
  | 'panel-llm-workspace'
  | 'panel-media'
  | 'panel-automation'
  | 'panel-network'
  | 'panel-notification'
  | 'panel-security';

type NavItem = { id: SectionId; label: string; icon: MaterialIconName; badge?: boolean };

const NAV_ITEMS: NavItem[] = [
  { id: 'panel-infra', label: '基础设施变量', icon: 'storage' },
  { id: 'panel-llm-creds', label: '大模型路由与凭证', icon: 'psychology', badge: true },
  { id: 'panel-llm-workspace', label: '大模型参数与工作组', icon: 'tune' },
  { id: 'panel-media', label: '智能创作与媒体渲染', icon: 'movie' },
  { id: 'panel-automation', label: '自动化矩阵核心', icon: 'smart_toy' as MaterialIconName },
  { id: 'panel-network', label: '网络路由与物理代理', icon: 'language' },
  { id: 'panel-notification', label: '企业微信与通知路由', icon: 'campaign' },
  { id: 'panel-security', label: '权限、安全与审计', icon: 'admin_panel_settings' },
];

const ACCENT_MAP: Record<SectionId, 'primary' | 'tertiary' | 'success' | 'error'> = {
  'panel-infra': 'primary',
  'panel-llm-creds': 'tertiary',
  'panel-llm-workspace': 'primary',
  'panel-media': 'success',
  'panel-automation': 'tertiary',
  'panel-network': 'primary',
  'panel-notification': 'success',
  'panel-security': 'error',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StrategyBadge({ strategy, carrier }: { strategy: string; carrier: string }) {
  const toneMap: Record<string, 'success' | 'warning' | 'error' | 'info' | 'primary' | 'neutral'> = {
    restart: 'warning',
    hot: 'success',
    cold: 'info',
    instant: 'primary',
    readonly: 'neutral',
  };
  const iconMap: Record<string, MaterialIconName> = {
    restart: 'replay',
    hot: 'trending_up',
    cold: 'cloud',
    instant: 'bolt',
    readonly: 'visibility',
  };
  const labelMap: Record<string, string> = {
    restart: '重启更新',
    hot: '热更新',
    cold: '冷更新',
    instant: '即时路由热轮换',
    readonly: '只读历史流',
  };
  const tone = toneMap[strategy] || 'neutral';
  const icon = iconMap[strategy] || 'info';
  const label = labelMap[strategy] || strategy;
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] text-on-surface-variant hidden md:inline">{carrier}</span>
      <StatusPill tone={tone} icon={icon}>{label}</StatusPill>
    </div>
  );
}

function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="p-inner-component-padding space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-10 rounded animate-shimmer"
          style={{
            background: 'linear-gradient(90deg, #edeeef 25%, #e7e8e9 50%, #edeeef 75%)',
            backgroundSize: '1000px 100%',
          }}
        />
      ))}
    </div>
  );
}

function QueryError({ message = '加载失败，请刷新重试' }: { message?: string }) {
  return (
    <div className="p-inner-component-padding text-center text-error">
      <MaterialIcon icon="error" size="xl" className="mb-2" />
      <p className="text-body-sm">{message}</p>
    </div>
  );
}

function KeyValueEditor({
  value,
  onChange,
  preseedKeys,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  preseedKeys?: string[];
}) {
  const entries = useMemo(() => {
    const map = new Map<string, string>();
    preseedKeys?.forEach((k) => map.set(k, value[k] || ''));
    Object.entries(value).forEach(([k, v]) => {
      if (!map.has(k)) map.set(k, v);
    });
    return Array.from(map.entries()).map(([key, val]) => ({ key, value: val }));
  }, [value, preseedKeys]);

  const updateEntry = (index: number, field: 'key' | 'value', newVal: string) => {
    const next = entries.map((e, i) => (i === index ? { ...e, [field]: newVal } : e));
    const record: Record<string, string> = {};
    next.forEach((e) => { if (e.key) record[e.key] = e.value; });
    onChange(record);
  };

  const addEntry = () => {
    onChange({ ...value, '': '' });
  };

  const removeEntry = (index: number) => {
    const next = entries.filter((_, i) => i !== index);
    const record: Record<string, string> = {};
    next.forEach((e) => { if (e.key) record[e.key] = e.value; });
    onChange(record);
  };

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <div key={`${entry.key}-${i}`} className="flex gap-2 items-center">
          <input
            className="form-input flex-1 font-mono text-sm"
            value={entry.key}
            onChange={(e) => updateEntry(i, 'key', e.target.value)}
            placeholder="键"
          />
          <input
            className="form-input flex-[2] font-mono text-sm"
            value={entry.value}
            onChange={(e) => updateEntry(i, 'value', e.target.value)}
            placeholder="值"
          />
          <button
            type="button"
            onClick={() => removeEntry(i)}
            className="btn-ghost text-error shrink-0"
          >
            <MaterialIcon icon="delete" size="sm" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addEntry} className="btn-secondary text-sm">
        <MaterialIcon icon="add" size="sm" />
        新增
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider card (preserved from original lines 56-160)
// ---------------------------------------------------------------------------

function ProviderCard({
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

// ---------------------------------------------------------------------------
// RBAC Panel (preserved from original)
// ---------------------------------------------------------------------------

function RbacPanel({
  users,
  isLoading,
  onCreate,
  onUpdate,
  onDelete,
  creating,
}: {
  users: RbacUser[];
  isLoading: boolean;
  onCreate: (u: Omit<RbacUser, 'id' | 'createdAt' | 'lastLoginAt'>) => void;
  onUpdate: (u: Partial<RbacUser> & { id: number }) => void;
  onDelete: (id: number) => void;
  creating: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Omit<RbacUser, 'id' | 'createdAt' | 'lastLoginAt'>>({
    username: '',
    displayName: '',
    email: '',
    role: 'viewer',
    status: 'active',
  });

  return (
    <div className="p-inner-component-padding space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-headline-md text-[18px] text-on-surface">用户与角色</h4>
          <p className="font-body text-body-sm text-on-surface-variant mt-0.5">
            共 {users.length} 个账号 · 角色: admin / operator / viewer
          </p>
        </div>
        <button onClick={() => setShowForm((s) => !s)} className="btn-primary text-sm">
          <MaterialIcon icon="add" size="sm" />
          {showForm ? '取消' : '新增用户'}
        </button>
      </div>

      {showForm && (
        <div className="bento-card bg-surface space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              className="form-input"
              placeholder="用户名 (login)"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <input
              className="form-input"
              placeholder="显示名"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <input
              className="form-input"
              type="email"
              placeholder="邮箱"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <select
              className="form-input"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as RbacUser['role'] })}
            >
              <option value="admin">admin</option>
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="btn-ghost">取消</button>
            <button
              onClick={() => {
                onCreate(form);
                setShowForm(false);
                setForm({ username: '', displayName: '', email: '', role: 'viewer', status: 'active' });
              }}
              disabled={!form.username || !form.displayName || creating}
              className="btn-primary"
            >
              {creating ? '创建中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto border border-outline-variant rounded-md">
        <table className="table-flat w-full">
          <thead>
            <tr>
              <th className="text-left">用户</th>
              <th className="text-left">邮箱</th>
              <th className="text-left">角色</th>
              <th className="text-left">状态</th>
              <th className="text-left">最后登录</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="text-center text-on-surface-variant py-8">加载中…</td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-on-surface-variant py-8">暂无用户</td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Avatar name={u.displayName} size={28} />
                      <div>
                        <div className="text-sm font-medium">{u.displayName}</div>
                        <div className="font-mono text-[11px] text-outline">@{u.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm text-on-surface-variant">{u.email}</td>
                  <td>
                    <select
                      className="form-input py-1 text-xs w-auto inline-block"
                      value={u.role}
                      onChange={(e) => onUpdate({ id: u.id, role: e.target.value as RbacUser['role'] })}
                    >
                      <option value="admin">admin</option>
                      <option value="operator">operator</option>
                      <option value="viewer">viewer</option>
                    </select>
                  </td>
                  <td>
                    <button
                      onClick={() => onUpdate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}
                    >
                      {u.status === 'active' ? (
                        <StatusPill tone="success" dot>启用</StatusPill>
                      ) : (
                        <StatusPill tone="neutral" dot>已停用</StatusPill>
                      )}
                    </button>
                  </td>
                  <td className="font-mono text-[12px] text-outline">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未'}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => {
                        if (confirm(`确定删除用户 ${u.displayName}?`)) onDelete(u.id);
                      }}
                      className="btn-ghost text-error"
                    >
                      <MaterialIcon icon="delete" size="sm" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification Channels & Rules Panel (preserved from original)
// ---------------------------------------------------------------------------

function NotificationChannelsPanel({
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

function statusPillFor(status: string) {
  if (status === 'SUCCESS') return <StatusPill tone="success">{status}</StatusPill>;
  if (status === 'WARN') return <StatusPill tone="warning">{status}</StatusPill>;
  return <StatusPill tone="error">{status}</StatusPill>;
}

const maskKey = (key: string) => {
  if (!key || key.length < 8) return '********';
  return key.slice(0, 3) + '...' + key.slice(-4);
};

const INFRA_KEYS = ['DB_HOST', 'DATABASE_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'LITELLM_MASTER_KEY', 'LITELLM_BASE_URL', 'WEB_PORT', 'DATA_DIR', 'LOG_LEVEL'];
const GROUP_ORDER = ['video', 'image', 'text'];
const FFMPEG_FIELDS = [
  { key: 'res_width', label: '分辨率宽度', type: 'number' },
  { key: 'res_height', label: '分辨率高度', type: 'number' },
  { key: 'fps', label: '帧率', type: 'number' },
  { key: 'pixel_format', label: '像素格式', type: 'text' },
  { key: 'video_codec', label: '视频编码器', type: 'text' },
  { key: 'audio_codec', label: '音频编码器', type: 'text' },
];
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i));
const MONITOR_FIELDS = [
  { key: 'interval_active_min', label: '高频周期最小值 (秒)', type: 'number' },
  { key: 'interval_active_max', label: '高频周期最大值 (秒)', type: 'number' },
  { key: 'interval_idle_min', label: '空闲周期最小值 (秒)', type: 'number' },
  { key: 'interval_idle_max', label: '空闲周期最大值 (秒)', type: 'number' },
  { key: 'idle_threshold', label: '空闲阈值', type: 'number' },
  { key: 'sleep_start_hour', label: '休眠开始时间 (时)', type: 'select' },
  { key: 'sleep_end_hour', label: '休眠结束时间 (时)', type: 'select' },
];
const BROWSER_FIELDS = [
  { key: 'max_tab_reuse', label: '最大标签复用次数', type: 'number' },
  { key: 'enable_warmup', label: '启用预热', type: 'toggle' },
];
const RAPIDAPI_PRESEED = ['xiaohongshu', 'tiktok', 'instagram'];
const HOSTS_PRESEED = ['xiaohongshu', 'tiktok'];

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SectionId>('panel-infra');

  // Panel 1
  const infraQuery = useInfraConfig();
  const updateInfra = useUpdateInfraConfig();
  const [infraForm, setInfraForm] = useState<Record<string, string>>({});
  const infraInitRef = useRef(false);

  // Panel 2
  const providersQuery = useLLMProviders();
  const providers = (providersQuery.data?.length ? providersQuery.data : FALLBACK_PROVIDERS) as typeof FALLBACK_PROVIDERS;
  const errorProviderCount = providers.filter((p) => p.status === 'error').length;

  // Panel 3
  const groupsQuery = useLLMGroups();
  const updateGroup = useUpdateLLMGroup();
  const [groupForms, setGroupForms] = useState<Record<string, LLMGroupConfig>>({});
  const groupsInitRef = useRef(false);

  const promptsQuery = usePrompts();
  const updatePrompt = useUpdatePrompt();
  const [promptEdits, setPromptEdits] = useState<Record<string, string>>({});
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const promptsInitRef = useRef(false);

  // Panel 4
  const mediaQuery = useMediaConfig();
  const updateMedia = useUpdateMediaConfig();
  const [mediaForm, setMediaForm] = useState({
    ffmpeg: { res_width: 1920, res_height: 1080, fps: 30, pixel_format: 'yuv420p', video_codec: 'libx264', audio_codec: 'aac' },
    media: { tts_provider: 'indextts2', max_clips_per_video: 10, min_material_score: 60 },
  });
  const mediaInitRef = useRef(false);

  // Panel 5
  const autoQuery = useAutomationConfig();
  const updateAuto = useUpdateAutomationConfig();
  const [autoForm, setAutoForm] = useState({
    monitor: { interval_active_min: 3, interval_active_max: 5, interval_idle_min: 15, interval_idle_max: 20, idle_threshold: 5, sleep_start_hour: 0, sleep_end_hour: 6 },
    browser: { max_tab_reuse: 50, enable_warmup: true },
  });
  const autoInitRef = useRef(false);

  const selectorsQuery = useCustomSelectors();
  const upsertSelector = useUpsertCustomSelector();
  const deleteSelector = useDeleteCustomSelector();
  const flowRulesQuery = useFlowRules();
  const updateFlowRules = useUpdateFlowRules();
  const resetFlowRules = useResetFlowRules();
  const [flowRulesEdit, setFlowRulesEdit] = useState<Record<string, { json: string; isEditing: boolean }>>({});
  const [showSelectorForm, setShowSelectorForm] = useState(false);
  const [expandedSelector, setExpandedSelector] = useState<string | null>(null);
  const [newSelector, setNewSelector] = useState({
    platform: '',
    category: 'buttons' as string,
    name: '',
    primary: '',
    fallbacks: [] as string[],
    selectorType: 'css' as string,
    description: '',
    enabled: true,
  });
  const [selectorFilter, setSelectorFilter] = useState({
    platform: '',
    category: '',
    purpose: '',
  });
  const [editingSelector, setEditingSelector] = useState<string | null>(null);
  const [originalSelectorKey, setOriginalSelectorKey] = useState<{ platform: string; categoryKey: string } | null>(null);

  const filteredSelectors = useMemo(() => {
    const data = selectorsQuery.data || [];
    return data.filter((s: CustomSelector) => {
      if (selectorFilter.platform && s.platform !== selectorFilter.platform) return false;
      if (selectorFilter.category && s.category !== selectorFilter.category) return false;
      if (selectorFilter.purpose && !(s.purposes || []).includes(selectorFilter.purpose)) return false;
      return true;
    });
  }, [selectorsQuery.data, selectorFilter]);

  // Panel 6
  const netQuery = useNetworkConfig();
  const updateNetwork = useUpdateNetworkConfig();
  const [netForm, setNetForm] = useState({
    proxy: { download_proxy_url: '' },
    api: { rapidapi_keys: {}, hosts: {} },
  });
  const netInitRef = useRef(false);

  // Panel 7
  const channelsQuery = useNotificationChannels();
  const updateChannel = useUpdateNotificationChannel();
  const rulesQuery = useNotificationRules();
  const updateRule = useUpdateNotificationRule();
  const wecomQuery = useWecomConfig();
  const updateWecom = useUpdateWecomConfig();
  const [wecomForm, setWecomForm] = useState<Partial<WecomConfig>>({});
  const [mappingText, setMappingText] = useState('{}');
  const wecomInitRef = useRef(false);
  const channels = channelsQuery.data || [];
  const rules = rulesQuery.data || [];
  const notifLoading = channelsQuery.isLoading || rulesQuery.isLoading;

  // Panel 8
  const rbacQuery = useRbacUsers();
  const createUser = useCreateRbacUser();
  const updateUser = useUpdateRbacUser();
  const deleteUser = useDeleteRbacUser();
  const auditQuery = useAuditLogs();
  const apiKeyQuery = useSecurityApiKey();
  const rotateKey = useRotateApiKey();
  const [rbacTab, setRbacTab] = useState<'audit' | 'rbac'>('audit');
  const rbacUsers = rbacQuery.data || [];
  const rbacLoading = rbacQuery.isLoading;

  const logs = (auditQuery.data?.length ? auditQuery.data : MOCK_LOGS) as typeof MOCK_LOGS;

  // Init effects
  useEffect(() => { if (infraQuery.data && !infraInitRef.current) { const initial: Record<string, string> = {}; INFRA_KEYS.forEach((k) => { initial[k] = String(infraQuery.data[k] ?? ''); }); setInfraForm(initial); infraInitRef.current = true; } }, [infraQuery.data]);
  useEffect(() => { if (groupsQuery.data && !groupsInitRef.current) { const data = groupsQuery.data; const normalized: Record<string, LLMGroupConfig> = {}; if (data && typeof data === 'object' && !Array.isArray(data)) { Object.entries(data).forEach(([k, v]) => { normalized[k] = v as LLMGroupConfig; }); } setGroupForms(normalized); groupsInitRef.current = true; } }, [groupsQuery.data]);
  useEffect(() => { if (promptsQuery.data && !promptsInitRef.current) { const edits: Record<string, string> = {}; (promptsQuery.data as LLMPromptTemplate[]).forEach((p) => { edits[p.name] = p.content; }); setPromptEdits(edits); promptsInitRef.current = true; } }, [promptsQuery.data]);
  useEffect(() => { if (mediaQuery.data && !mediaInitRef.current) { const d = mediaQuery.data; setMediaForm({ ffmpeg: { res_width: 1920, res_height: 1080, fps: 30, pixel_format: 'yuv420p', video_codec: 'libx264', audio_codec: 'aac', ...(d.ffmpeg || {}) }, media: { tts_provider: 'indextts2', max_clips_per_video: 10, min_material_score: 60, ...(d.media || {}) }, }); mediaInitRef.current = true; } }, [mediaQuery.data]);
  useEffect(() => { if (autoQuery.data && !autoInitRef.current) { const d = autoQuery.data; setAutoForm({ monitor: { interval_active_min: 3, interval_active_max: 5, interval_idle_min: 15, interval_idle_max: 20, idle_threshold: 5, sleep_start_hour: 0, sleep_end_hour: 6, ...(d.monitor || {}) }, browser: { max_tab_reuse: 50, enable_warmup: true, ...(d.browser || {}) }, }); autoInitRef.current = true; } }, [autoQuery.data]);
  useEffect(() => { if (netQuery.data && !netInitRef.current) { setNetForm({ proxy: { download_proxy_url: netQuery.data.proxy?.download_proxy_url || '' }, api: { rapidapi_keys: netQuery.data.api?.rapidapi_keys || {}, hosts: netQuery.data.api?.hosts || {} }, }); netInitRef.current = true; } }, [netQuery.data]);
  useEffect(() => { if (wecomQuery.data && !wecomInitRef.current) { setWecomForm(wecomQuery.data); setMappingText(JSON.stringify(wecomQuery.data.account_chat_mapping || {}, null, 2)); wecomInitRef.current = true; } }, [wecomQuery.data]);

  // IntersectionObserver for active section
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => { entries.forEach((entry) => { if (entry.isIntersecting) setActiveSection(entry.target.id as SectionId); }); },
      { rootMargin: '-10% 0px -80% 0px', threshold: 0 }
    );
    NAV_ITEMS.forEach((item) => { const el = document.getElementById(item.id); if (el) observer.observe(el); });
    return () => observer.disconnect();
  }, []);

  const scrollToSection = useCallback((id: SectionId) => {
    setActiveSection(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleSaveInfra = () => {
    const updates: Record<string, string | number> = {};
    INFRA_KEYS.forEach((k) => { if (k !== 'DATABASE_URL') updates[k] = infraForm[k]; });
    updateInfra.mutate(updates);
  };

  const handleSaveMedia = () => updateMedia.mutate(mediaForm);
  const handleSaveAuto = () => updateAuto.mutate(autoForm);
  const handleSaveNetwork = () => updateNetwork.mutate(netForm);

  const handleSaveWecom = () => {
    let mapping: Record<string, string> = {};
    try { mapping = JSON.parse(mappingText); } catch { alert('JSON 格式错误，请检查 account_chat_mapping'); return; }
    updateWecom.mutate({ ...wecomForm, account_chat_mapping: mapping });
  };

  const handleRotateKey = () => {
    if (confirm('确定要轮换 API Key 吗？旧 Key 将立即失效。')) rotateKey.mutate('');
  };

  const handleSaveSelector = () => {
    if (!newSelector.platform || !newSelector.category || !newSelector.name || !newSelector.primary) return;
    const categoryKey = `${newSelector.category}:${newSelector.name}`;
    const selectorValue = JSON.stringify({
      purposes: ['publish', 'monitor'],
      primary: newSelector.primary,
      fallbacks: newSelector.fallbacks.filter(Boolean),
      selectorType: newSelector.selectorType,
      description: newSelector.description || '',
      enabled: newSelector.enabled !== false,
    });
    upsertSelector.mutate({
      platform: newSelector.platform,
      categoryKey,
      selector_value: selectorValue,
      ...(originalSelectorKey ? {
        originalPlatform: originalSelectorKey.platform,
        originalCategoryKey: originalSelectorKey.categoryKey,
      } : {}),
    });
    setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true });
    setShowSelectorForm(false);
    setEditingSelector(null);
    setOriginalSelectorKey(null);
  };

  return (
    <div>
      <h2 className="text-headline-lg text-headline-lg text-on-surface">系统设置中心</h2>
      <p className="font-body text-body-md text-on-surface-variant mt-1">管理系统环境变量、外部API接入与访问控制策略。</p>

      {/* Mobile horizontal tabs */}
      <div className="lg:hidden flex overflow-x-auto gap-2 pb-2 mb-4 border-b border-outline-variant sticky top-0 bg-surface z-10 -mx-4 px-4">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => scrollToSection(item.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 rounded-full text-sm whitespace-nowrap transition-colors shrink-0',
              activeSection === item.id ? 'bg-primary-container text-on-primary' : 'bg-surface-container text-on-surface-variant',
            )}
          >
            <MaterialIcon icon={item.icon} size="sm" />
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-bento-gap items-start relative mt-6">
        {/* Desktop sidebar */}
        <div className="hidden lg:block lg:col-span-3">
          <nav className="bg-surface-container-lowest border border-outline-variant rounded-xl p-4 sticky top-4 space-y-1">
            <div className="text-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-3">配置模块</div>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => scrollToSection(item.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors border-l-2',
                  activeSection === item.id ? 'bg-surface-container text-primary border-l-primary' : 'text-on-surface hover:bg-surface-container border-l-transparent hover:border-outline-variant',
                )}
              >
                <MaterialIcon icon={item.icon} size="lg" className={activeSection === item.id ? 'text-primary' : ''} />
                <span className="flex-1 text-left">{item.label}</span>
                {item.badge && errorProviderCount > 0 && (
                  <span className="bg-error-container text-on-error-container text-[10px] px-1.5 py-0.5 rounded-full font-medium">{errorProviderCount}</span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="lg:col-span-9 space-y-6">
          {/* Panel 1: Infrastructure */}
          <section id="panel-infra" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-infra']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">基础设施变量</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">核心服务连接字符串与端口配置。修改后需重启实例生效。</p>
              </div>
              <div className="flex items-center gap-3">
                <StrategyBadge strategy="restart" carrier=".env → Docker Compose" />
                <button onClick={handleSaveInfra} disabled={updateInfra.isPending} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <MaterialIcon icon="save" size="sm" />
                  {updateInfra.isPending ? '保存中…' : '保存配置'}
                </button>
              </div>
            </HeaderStrip>
            <div className="p-inner-component-padding">
              {infraQuery.isLoading ? <PanelSkeleton rows={5} /> : infraQuery.isError ? <QueryError /> : (
                <div className="overflow-x-auto">
                  <table className="table-flat w-full">
                    <thead><tr><th className="text-left w-1/3">配置项</th><th className="text-left">值</th></tr></thead>
                    <tbody>
                      {INFRA_KEYS.map((key) => (
                        <tr key={key}>
                          <td className="font-mono text-sm text-on-surface-variant">{key}</td>
                          <td>
                            {key === 'DATABASE_URL' ? (
                              <span className="text-body-sm text-on-surface-variant italic">READ-ONLY</span>
                            ) : (
                              <input
                                type={/PASSWORD|SECRET|KEY/.test(key) ? 'password' : 'text'}
                                value={String(infraForm[key] ?? '')}
                                onChange={(e) => setInfraForm((prev) => ({ ...prev, [key]: e.target.value }))}
                                className="form-input font-mono text-sm"
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* Panel 2: LLM Credentials */}
          <section id="panel-llm-creds" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-llm-creds']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">大模型路由与凭证</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">管理LLM服务供应商的API密钥、故障转移策略与用量监控。</p>
              </div>
              <StrategyBadge strategy="instant" carrier="PostgreSQL (LiteLLM 官方表)" />
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-4">
              {providersQuery.isLoading ? <PanelSkeleton rows={3} /> : providersQuery.isError ? <QueryError /> : (
                providers.map((provider) => <ProviderCard key={provider.name} provider={provider} />)
              )}
            </div>
          </section>

          {/* Panel 3: LLM Workspace */}
          <section id="panel-llm-workspace" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-llm-workspace']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">大模型参数与工作组</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">工作组路由参数与提示词模板管理。</p>
              </div>
              <StrategyBadge strategy="hot" carrier="PostgreSQL + Redis Cache" />
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              {/* Sub-section a: Groups */}
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">工作组路由参数</h4>
                {groupsQuery.isLoading ? <PanelSkeleton rows={3} /> : groupsQuery.isError ? <QueryError /> : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-bento-gap">
                    {GROUP_ORDER.map((name) => {
                      const group = groupForms[name] || { default_model: '', temperature: 0.7, max_tokens: 2048 };
                      return (
                        <BentoCard key={name} className="space-y-3">
                          <h5 className="text-label-md text-label-md text-on-surface capitalize">{name}</h5>
                          <div className="space-y-1">
                            <label className="text-label-md text-label-md text-on-surface-variant">默认模型</label>
                            <input className="form-input font-mono text-sm" value={group.default_model} onChange={(e) => setGroupForms((prev) => ({ ...prev, [name]: { ...group, default_model: e.target.value } }))} />
                          </div>
                          <div className="space-y-1">
                            <label className="text-label-md text-label-md text-on-surface-variant">Temperature ({group.temperature})</label>
                            <input type="range" min="0" max="2" step="0.1" value={group.temperature} onChange={(e) => setGroupForms((prev) => ({ ...prev, [name]: { ...group, temperature: parseFloat(e.target.value) } }))} className="w-full" />
                          </div>
                          <div className="space-y-1">
                            <label className="text-label-md text-label-md text-on-surface-variant">Max Tokens</label>
                            <input type="number" className="form-input font-mono text-sm" value={group.max_tokens} onChange={(e) => setGroupForms((prev) => ({ ...prev, [name]: { ...group, max_tokens: parseInt(e.target.value) || 0 } }))} />
                          </div>
                          <div className="flex justify-end">
                            <button onClick={() => updateGroup.mutate({ name, ...group })} disabled={updateGroup.isPending} className="btn-secondary text-sm">
                              <MaterialIcon icon="save" size="sm" />
                              {updateGroup.isPending ? '保存中…' : '保存'}
                            </button>
                          </div>
                        </BentoCard>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-outline-variant" />

              {/* Sub-section b: Prompts */}
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">提示词模板</h4>
                {promptsQuery.isLoading ? <PanelSkeleton rows={4} /> : promptsQuery.isError ? <QueryError /> : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-bento-gap">
                    {(promptsQuery.data || []).map((prompt: LLMPromptTemplate) => (
                      <div
                        key={prompt.name}
                        className="bento-card cursor-pointer"
                        onClick={() => setExpandedPrompt(expandedPrompt === prompt.name ? null : prompt.name)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-mono text-sm text-on-surface">{prompt.name}</span>
                          <span className="text-[11px] text-on-surface-variant shrink-0">{prompt.updatedAt}</span>
                        </div>
                        <p className="text-body-sm text-on-surface-variant line-clamp-2 mt-1">{prompt.content}</p>
                        {expandedPrompt === prompt.name && (
                          <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                            <textarea
                              className="form-input font-mono text-sm h-32"
                              value={promptEdits[prompt.name] ?? prompt.content}
                              onChange={(e) => setPromptEdits((prev) => ({ ...prev, [prompt.name]: e.target.value }))}
                            />
                            <div className="flex justify-end">
                              <button
                                onClick={() => { updatePrompt.mutate({ name: prompt.name, content: promptEdits[prompt.name] || prompt.content }); setExpandedPrompt(null); }}
                                disabled={updatePrompt.isPending}
                                className="btn-primary text-sm"
                              >
                                <MaterialIcon icon="save" size="sm" />
                                {updatePrompt.isPending ? '保存中…' : '保存'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Panel 4: Media Engine */}
          <section id="panel-media" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-media']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">智能创作与媒体渲染</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">FFmpeg 重编码参数与媒体引擎配置。</p>
              </div>
              <div className="flex items-center gap-3">
                <StrategyBadge strategy="cold" carrier="PostgreSQL config_entries" />
                <button onClick={handleSaveMedia} disabled={updateMedia.isPending} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <MaterialIcon icon="save" size="sm" />
                  {updateMedia.isPending ? '保存中…' : '保存配置'}
                </button>
              </div>
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">FFmpeg 重编码参数</h4>
                {mediaQuery.isLoading ? <PanelSkeleton rows={2} /> : mediaQuery.isError ? <QueryError /> : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {FFMPEG_FIELDS.map((field) => (
                      <div key={field.key} className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">{field.label}</label>
                        <input
                          type={field.type}
                          className="form-input font-mono text-sm"
                          value={(mediaForm.ffmpeg as any)[field.key] || ''}
                          onChange={(e) => setMediaForm((prev) => ({ ...prev, ffmpeg: { ...prev.ffmpeg, [field.key]: field.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value } }))}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="border-t border-outline-variant" />
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">媒体引擎参数</h4>
                {mediaQuery.isLoading ? <PanelSkeleton rows={2} /> : mediaQuery.isError ? <QueryError /> : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <label className="text-label-md text-label-md text-on-surface-variant">TTS 提供商</label>
                      <select className="form-input font-mono text-sm" value={mediaForm.media.tts_provider} onChange={(e) => setMediaForm((prev) => ({ ...prev, media: { ...prev.media, tts_provider: e.target.value } }))}>
                        <option value="indextts2">indextts2</option>
                        <option value="qwen3">qwen3</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-label-md text-label-md text-on-surface-variant">单视频最大片段数 (2-20)</label>
                      <input type="number" min={2} max={20} className="form-input font-mono text-sm" value={mediaForm.media.max_clips_per_video} onChange={(e) => setMediaForm((prev) => ({ ...prev, media: { ...prev.media, max_clips_per_video: parseInt(e.target.value) || 2 } }))} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-label-md text-label-md text-on-surface-variant">素材最低质量分 (0-100)</label>
                      <input type="number" min={0} max={100} className="form-input font-mono text-sm" value={mediaForm.media.min_material_score} onChange={(e) => setMediaForm((prev) => ({ ...prev, media: { ...prev.media, min_material_score: parseInt(e.target.value) || 0 } }))} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Panel 5: Automation */}
          <section id="panel-automation" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-automation']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">自动化矩阵核心</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">监控调度、浏览器养号与动态选择器管理。</p>
              </div>
              <div className="flex items-center gap-3">
                <StrategyBadge strategy="hot" carrier="PostgreSQL config_entries + custom_selectors 表" />
                <button onClick={handleSaveAuto} disabled={updateAuto.isPending} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <MaterialIcon icon="save" size="sm" />
                  {updateAuto.isPending ? '保存中…' : '保存配置'}
                </button>
              </div>
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">监控调度</h4>
                {autoQuery.isLoading ? <PanelSkeleton rows={3} /> : autoQuery.isError ? <QueryError /> : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {MONITOR_FIELDS.map((field) => (
                      <div key={field.key} className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">{field.label}</label>
                        {field.type === 'select' ? (
                          <select
                            className="form-input font-mono text-sm"
                            value={(autoForm.monitor as any)[field.key] ?? 0}
                            onChange={(e) => setAutoForm((prev) => ({ ...prev, monitor: { ...prev.monitor, [field.key]: parseInt(e.target.value) } }))}
                          >
                            {HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h}:00</option>)}
                          </select>
                        ) : (
                          <input
                            type="number"
                            className="form-input font-mono text-sm"
                            value={(autoForm.monitor as any)[field.key] ?? ''}
                            onChange={(e) => setAutoForm((prev) => ({ ...prev, monitor: { ...prev.monitor, [field.key]: parseInt(e.target.value) || 0 } }))}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-body-sm text-on-surface-variant mt-3">当前高频周期: 180-300秒 (3-5分钟), 空闲周期: 900-1200秒 (15-20分钟)</p>
              </div>

              {/* 爬取模式配置 */}
              <div className="border-t border-outline-variant pt-6">
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">爬取模式配置</h4>
                <CrawlModePanel />
              </div>

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

              <div className="border-t border-outline-variant pt-6">
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md flex items-center justify-between">
                  <span>动态选择器管理</span>
                  <button onClick={() => { setShowSelectorForm(true); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }} className="btn-secondary text-sm">
                    <MaterialIcon icon="add" size="sm" /> 新增选择器
                  </button>
                </h4>
                {/* 筛选栏 */}
                <div className="flex flex-wrap gap-3 mb-4">
                  <select
                    className="form-input text-sm w-auto min-w-[140px]"
                    value={selectorFilter.platform}
                    onChange={(e) => setSelectorFilter((prev) => ({ ...prev, platform: e.target.value }))}
                  >
                    <option value="">全部平台</option>
                    <option value="douyin">抖音 (douyin)</option>
                    <option value="kuaishou">快手 (kuaishou)</option>
                    <option value="xiaohongshu">小红书 (xiaohongshu)</option>
                    <option value="bilibili">B站 (bilibili)</option>
                  </select>
                  <select
                    className="form-input text-sm w-auto min-w-[140px]"
                    value={selectorFilter.category}
                    onChange={(e) => setSelectorFilter((prev) => ({ ...prev, category: e.target.value }))}
                  >
                    <option value="">全部类别</option>
                    <option value="menus">菜单 (menus)</option>
                    <option value="buttons">按钮 (buttons)</option>
                    <option value="regions">区域 (regions)</option>
                    <option value="textboxes">文本框 (textboxes)</option>
                  </select>
                  <select
                    className="form-input text-sm w-auto min-w-[140px]"
                    value={selectorFilter.purpose}
                    onChange={(e) => setSelectorFilter((prev) => ({ ...prev, purpose: e.target.value }))}
                  >
                    <option value="">全部场景</option>
                    <option value="publish">发布 (publish)</option>
                    <option value="monitor">监控 (monitor)</option>
                  </select>
                  {(selectorFilter.platform || selectorFilter.category || selectorFilter.purpose) && (
                    <button
                      className="btn-ghost text-sm text-on-surface-variant"
                      onClick={() => setSelectorFilter({ platform: '', category: '', purpose: '' })}
                    >
                      <MaterialIcon icon="filter_list" size="sm" /> 清除筛选
                    </button>
                  )}
                </div>
                {selectorsQuery.isLoading ? <PanelSkeleton rows={3} /> : selectorsQuery.isError ? <QueryError /> : (
                  <div className="overflow-x-auto">
                    <table className="table-flat w-full">
                      <thead>
                        <tr>
                          <th className="text-left">平台</th>
                          <th className="text-left">类别</th>
                          <th className="text-left">名称</th>
                          <th className="text-left">主选择器</th>
                          <th className="text-left">使用场景</th>
                          <th className="text-left">更新时间</th>
                          <th className="text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSelectors.map((selector: CustomSelector) => {
                          const cat = selector.category;
                          const name = selector.name;
                          const primary = selector.primary || '—';
                          const fallbacks = selector.fallbacks || [];
                          const purposes = selector.purposes || [];
                          // 写入侧走 URL `:platform/:categoryKey` 仍需合并串
                          const selectorKey = `${cat}:${name}`;
                          const isExpanded = expandedSelector === `${selector.platform}-${selectorKey}`;
                          return (
                            <Fragment key={`${selector.platform}-${selectorKey}`}>
                              <tr
                                className="cursor-pointer hover:bg-surface-container/50 transition-colors"
                                onClick={() => setExpandedSelector(isExpanded ? null : `${selector.platform}-${selectorKey}`)}
                              >
                                <td className="font-mono text-sm">
                                  <div className="flex items-center gap-1.5">
                                    <MaterialIcon icon={isExpanded ? 'expand_less' : 'expand_more'} size="sm" className="text-on-surface-variant" />
                                    {selector.platform}
                                  </div>
                                </td>
                                <td className="text-sm">
                                  <StatusPill tone="primary" dot>{cat}</StatusPill>
                                </td>
                                <td className="font-mono text-sm">{name}</td>
                                <td className="font-mono text-[12px] text-on-surface-variant max-w-xs truncate">{primary}</td>
                                <td className="text-sm">
                                  <div className="flex flex-wrap gap-1">
                                    {purposes.length > 0 ? purposes.map((p: string) => (
                                      <span key={p} className={cn(
                                        'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium',
                                        p === 'publish' ? 'bg-primary-container text-on-primary-container' : 'bg-secondary-container text-on-secondary-container',
                                      )}>
                                        {p === 'publish' ? '发布' : p === 'monitor' ? '监控' : p}
                                      </span>
                                    )) : <span className="text-on-surface-variant">—</span>}
                                  </div>
                                </td>
                                <td className="text-[12px] text-on-surface-variant">
                                  {selector.updatedAt ? new Date(selector.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                                </td>
                                <td className="text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingSelector(`${selector.platform}-${selectorKey}`);
                                        setOriginalSelectorKey({ platform: selector.platform, categoryKey: selectorKey });
                                        setNewSelector({
                                          platform: selector.platform,
                                          category: cat,
                                          name: name,
                                          primary: selector.primary || '',
                                          fallbacks: [...(selector.fallbacks || [])],
                                          selectorType: selector.selectorType || 'css',
                                          description: selector.description || '',
                                          enabled: selector.enabled !== false,
                                        });
                                        setShowSelectorForm(true);
                                      }}
                                      className="btn-ghost text-primary"
                                      title="编辑选择器"
                                    >
                                      <MaterialIcon icon="edit" size="sm" />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); if (confirm(`确定删除 ${selector.platform}/${selectorKey}?`)) deleteSelector.mutate({ platform: selector.platform, categoryKey: selectorKey }); }}
                                      disabled={deleteSelector.isPending}
                                      className="btn-ghost text-error"
                                      title="删除选择器"
                                    >
                                      <MaterialIcon icon="delete" size="sm" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                              {isExpanded && (
                                <tr>
                                  <td colSpan={7} className="bg-surface-container/30 p-4">
                                    <div className="space-y-3">
                                      {/* 启用状态切换 */}
                                      <div className="flex items-center gap-3">
                                        <span className="text-label-md text-on-surface-variant">启用状态</span>
                                        <span className={cn(
                                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                                          selector.enabled !== false
                                            ? 'bg-success-container text-on-success-container'
                                            : 'bg-error-container text-on-error-container',
                                        )}>
                                          <span className={cn('w-1.5 h-1.5 rounded-full', selector.enabled !== false ? 'bg-success' : 'bg-error')} />
                                          {selector.enabled !== false ? '已启用' : '已禁用'}
                                        </span>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            const categoryKey = `${cat}:${name}`;
                                            const selectorValue = JSON.stringify({
                                              purposes: purposes,
                                              primary: selector.primary,
                                              fallbacks: fallbacks,
                                              selectorType: selector.selectorType || 'css',
                                              description: selector.description || '',
                                              enabled: selector.enabled === false ? true : false,
                                            });
                                            upsertSelector.mutate({ platform: selector.platform, categoryKey, selector_value: selectorValue });
                                          }}
                                          className="btn-ghost text-sm text-primary"
                                        >
                                          <MaterialIcon icon={(selector.enabled !== false ? 'toggle_off' : 'toggle_on') as MaterialIconName} size="sm" />
                                          {selector.enabled !== false ? '禁用' : '启用'}
                                        </button>
                                      </div>
                                      {/* 选择器列表：主选择器 + 回退选择器 */}
                                      <div>
                                        <span className="text-label-md text-on-surface-variant block mb-1">选择器列表</span>
                                        <div className="space-y-1">
                                          <div className="font-mono text-[12px] text-on-surface bg-primary-container/30 px-2 py-1 rounded flex items-center gap-2">
                                            <span className="bg-primary text-on-primary text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0">主</span>
                                            {primary}
                                          </div>
                                          {fallbacks.map((fb: string, i: number) => (
                                            <div key={i} className="font-mono text-[12px] text-on-surface-variant bg-surface-container px-2 py-1 rounded flex items-center gap-2">
                                              <span className="text-on-surface-variant text-[10px] px-1.5 py-0.5 shrink-0">{i + 1}</span>
                                              {fb}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                      {/* 描述 */}
                                      {selector.description && (
                                        <div className="text-[11px] text-on-surface-variant">
                                          描述: {selector.description}
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {showSelectorForm && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => { setShowSelectorForm(false); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }}>
                    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4" onClick={(e) => e.stopPropagation()}>
                      {/* Modal Header */}
                      <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant">
                        <h5 className="text-headline-sm text-on-surface font-medium">
                          {editingSelector ? '编辑选择器' : '新增选择器'}
                        </h5>
                        <button onClick={() => { setShowSelectorForm(false); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }} className="btn-ghost rounded-full p-1">
                          <MaterialIcon icon="close" size="md" />
                        </button>
                      </div>
                      {/* Modal Body */}
                      <div className="px-6 py-5 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-label-sm text-on-surface-variant">平台</label>
                            <select className="form-input" value={newSelector.platform}
                              onChange={(e) => setNewSelector({ ...newSelector, platform: e.target.value })}
                              disabled={!!editingSelector}>
                              <option value="">选择平台</option>
                              <option value="douyin">抖音 (douyin)</option>
                              <option value="kuaishou">快手 (kuaishou)</option>
                              <option value="xiaohongshu">小红书 (xiaohongshu)</option>
                              <option value="bilibili">B站 (bilibili)</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-label-sm text-on-surface-variant">类别</label>
                            <select className="form-input" value={newSelector.category}
                              onChange={(e) => setNewSelector({ ...newSelector, category: e.target.value })}>
                              <option value="">选择类别</option>
                              <option value="menus">菜单 (menus)</option>
                              <option value="buttons">按钮 (buttons)</option>
                              <option value="regions">区域 (regions)</option>
                              <option value="textboxes">文本框 (textboxes)</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-label-sm text-on-surface-variant">选择器名称</label>
                            <input className="form-input font-mono text-sm" placeholder="如 btn_publish_submit"
                              value={newSelector.name}
                              onChange={(e) => setNewSelector({ ...newSelector, name: e.target.value })} />
                          </div>
                          <div className="space-y-1">
                            <label className="text-label-sm text-on-surface-variant">选择器类型</label>
                            <select className="form-input" value={newSelector.selectorType}
                              onChange={(e) => setNewSelector({ ...newSelector, selectorType: e.target.value })}>
                              <option value="css">css</option>
                              <option value="role">role</option>
                              <option value="text">text</option>
                              <option value="placeholder">placeholder</option>
                              <option value="label">label</option>
                            </select>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="text-label-md text-on-surface-variant">主选择器 (primary)</label>
                          <input className="form-input font-mono text-sm w-full" placeholder="如 button:has-text(&quot;发布&quot;)"
                            value={newSelector.primary}
                            onChange={(e) => setNewSelector({ ...newSelector, primary: e.target.value })} />
                        </div>

                        <div className="space-y-1">
                          <label className="text-label-md text-on-surface-variant">回退选择器列表 (fallbacks)</label>
                          <div className="space-y-2">
                            {(newSelector.fallbacks || []).map((fb: string, i: number) => (
                              <div key={i} className="flex gap-2">
                                <input className="form-input font-mono text-sm flex-1"
                                  value={fb} placeholder={`回退选择器 ${i + 1}`}
                                  onChange={(e) => {
                                    const updated = [...newSelector.fallbacks];
                                    updated[i] = e.target.value;
                                    setNewSelector({ ...newSelector, fallbacks: updated });
                                  }} />
                                <button onClick={() => {
                                  const updated = newSelector.fallbacks.filter((_: string, j: number) => j !== i);
                                  setNewSelector({ ...newSelector, fallbacks: updated });
                                }} className="btn-ghost text-error">
                                  <MaterialIcon icon="delete" size="sm" />
                                </button>
                              </div>
                            ))}
                            <button onClick={() => setNewSelector({ ...newSelector, fallbacks: [...(newSelector.fallbacks || []), ''] })}
                              className="btn-ghost text-sm">
                              <MaterialIcon icon="add" size="sm" /> 添加回退选择器
                            </button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="text-label-md text-on-surface-variant">描述</label>
                          <input className="form-input font-mono text-sm w-full" placeholder="选择器描述/用途说明"
                            value={newSelector.description || ''}
                            onChange={(e) => setNewSelector({ ...newSelector, description: e.target.value })} />
                        </div>
                      </div>
                      {/* Modal Footer */}
                      <div className="flex justify-end gap-2 px-6 py-4 border-t border-outline-variant">
                        <button onClick={() => { setShowSelectorForm(false); setEditingSelector(null); setOriginalSelectorKey(null); setNewSelector({ platform: '', category: 'buttons', name: '', primary: '', fallbacks: [], selectorType: 'css', description: '', enabled: true }); }} className="btn-ghost">取消</button>
                        <button onClick={handleSaveSelector} disabled={upsertSelector.isPending} className="btn-primary">
                          {upsertSelector.isPending ? '保存中…' : '保存'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Panel 5b: 发布流程控制规则 (v2.1+) — 显示 scope/disabled 检测方式/URL 模式等流程级配置 */}
          <section id="panel-flow-rules" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color="tertiary" />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-on-surface">发布流程控制规则</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">
                  按钮搜索范围、disabled/可见性检测方式、URL 成功/导航模式、重试参数。所有规则来自
                  <code className="mx-1 px-1.5 py-0.5 rounded bg-surface-container text-[12px]">data/selectors.json</code>
                  的 <code className="mx-1 px-1.5 py-0.5 rounded bg-surface-container text-[12px]">flowRules</code> 字段。
                </p>
              </div>
            </HeaderStrip>
            <div className="p-6">
              {flowRulesQuery.isLoading && (
                <div className="text-on-surface-variant text-sm">加载中…</div>
              )}
              {flowRulesQuery.data && Object.keys(flowRulesQuery.data).length === 0 && (
                <div className="text-on-surface-variant text-sm">暂无流程规则配置</div>
              )}
              <div className="space-y-4">
                {flowRulesQuery.data && Object.entries(flowRulesQuery.data).map(([plat, info]: [string, any]) => {
                  const fr = info?.flowRules || {};
                  const ruleCount = Object.keys(fr).length;
                  const editing = flowRulesEdit[plat]?.isEditing ?? false;
                  const draftJson = flowRulesEdit[plat]?.json ?? JSON.stringify(fr, null, 2);
                  return (
                    <div key={plat} className="border border-outline-variant rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-2.5 bg-surface-container/50">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium">{plat}</span>
                          <StatusPill tone={ruleCount > 0 ? 'primary' : 'warning'} dot>
                            {ruleCount > 0 ? `${ruleCount} 项规则` : '未配置 (使用代码兜底)'}
                          </StatusPill>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-on-surface-variant">
                            {info?.updatedAt ? `updated: ${new Date(info.updatedAt).toLocaleString('zh-CN')}` : '—'}
                          </span>
                          {editing ? (
                            <>
                              <button
                                onClick={async () => {
                                  try {
                                    const parsed = JSON.parse(flowRulesEdit[plat]?.json || '{}');
                                    await updateFlowRules.mutateAsync({ platform: plat, flowRules: parsed });
                                    setFlowRulesEdit((prev) => ({ ...prev, [plat]: { json: '', isEditing: false } }));
                                  } catch (e: any) {
                                    alert(`JSON 解析失败: ${e.message}`);
                                  }
                                }}
                                disabled={updateFlowRules.isPending}
                                className="btn-primary text-xs px-2.5 py-1 flex items-center gap-1"
                              >
                                <MaterialIcon icon="save" size="sm" />保存
                              </button>
                              <button
                                onClick={() => setFlowRulesEdit((prev) => ({ ...prev, [plat]: { json: '', isEditing: false } }))}
                                className="btn-secondary text-xs px-2.5 py-1"
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => setFlowRulesEdit((prev) => ({
                                  ...prev,
                                  [plat]: { json: JSON.stringify(fr, null, 2), isEditing: true },
                                }))}
                                className="btn-secondary text-xs px-2.5 py-1 flex items-center gap-1"
                              >
                                <MaterialIcon icon="edit" size="sm" />编辑
                              </button>
                              {ruleCount > 0 && (
                                <button
                                  onClick={async () => {
                                    if (!confirm(`确认重置 ${plat} 的流程规则? 将回退到 BasePublisher 硬编码默认。`)) return;
                                    await resetFlowRules.mutateAsync({ platform: plat });
                                  }}
                                  disabled={resetFlowRules.isPending}
                                  className="btn-secondary text-xs px-2.5 py-1 text-error"
                                >
                                  重置
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {editing ? (
                        <div className="p-3 bg-surface-container-lowest">
                          <textarea
                            value={draftJson}
                            onChange={(e) => setFlowRulesEdit((prev) => ({
                              ...prev,
                              [plat]: { json: e.target.value, isEditing: true },
                            }))}
                            className="w-full h-72 p-2 text-[11px] font-mono bg-surface-container border border-outline-variant rounded resize-y focus:outline-none focus:ring-2 focus:ring-primary/40"
                            spellCheck={false}
                          />
                          <div className="mt-2 text-[11px] text-on-surface-variant">
                            字段说明: <code>scopeSelectors</code> (发布按钮搜索容器) · <code>disabledCheckMethods</code> (dom-property/attr-disabled/aria-disabled/pseudo-disabled/class-disabled/cursor/opacity) · <code>successUrlPatterns</code> (发布成功后的 URL 模式) · <code>navRedirectUrlPatterns</code> (导航误命中模式, 触发重填) · <code>filterTag</code> (BUTTON/INPUT/A) · <code>declareModalMethod</code> (selector/page-text/both) · 其他: <code>publishMaxRetries</code> · <code>disabledRetryDelayMs</code> · <code>notFoundBackoffMs</code> · <code>postClickStabilizeMs</code> · <code>scrollAmountPx</code> · <code>publishWaitMs</code> · <code>viewportInsetPx</code>
                          </div>
                        </div>
                      ) : ruleCount > 0 ? (
                        <pre className="bg-surface-container-lowest p-3 text-[11px] font-mono overflow-x-auto max-h-72 overflow-y-auto">
                          {JSON.stringify(fr, null, 2)}
                        </pre>
                      ) : (
                        <div className="px-4 py-3 text-[12px] text-on-surface-variant">
                          该平台 <code className="px-1 py-0.5 rounded bg-surface-container">flowRules</code> 为空。
                          运行时将回退到代码中的默认值, 建议尽快在 <code className="px-1 py-0.5 rounded bg-surface-container">data/selectors.json</code> 补齐以避免漂移。
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 text-[12px] text-on-surface-variant">
                提示: 点击"编辑"可在线修改 (支持 <code>flowRules</code> 15 个字段, 修改后通过 <code>PUT /api/v1/config-automation/selectors/flow-rules</code> 热重载)。 重置后会回退到 BasePublisher 中硬编码的默认值。
              </div>
            </div>
          </section>

          {/* Panel 6: Network */}
          <section id="panel-network" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-network']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">网络路由与物理代理</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">下载代理、RapidAPI 密钥与域名映射。</p>
              </div>
              <div className="flex items-center gap-3">
                <StrategyBadge strategy="cold" carrier="PostgreSQL config_entries" />
                <button onClick={handleSaveNetwork} disabled={updateNetwork.isPending} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <MaterialIcon icon="save" size="sm" />
                  {updateNetwork.isPending ? '保存中…' : '保存配置'}
                </button>
              </div>
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">下载代理</h4>
                {netQuery.isLoading ? <PanelSkeleton rows={1} /> : netQuery.isError ? <QueryError /> : (
                  <div className="relative">
                    <MaterialIcon icon="router" size="sm" className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
                    <input
                      type="text"
                      className="form-input pl-10 font-mono text-sm"
                      placeholder="http://proxy.internal:8080"
                      value={netForm.proxy.download_proxy_url}
                      onChange={(e) => setNetForm((prev) => ({ ...prev, proxy: { ...prev.proxy, download_proxy_url: e.target.value } }))}
                    />
                  </div>
                )}
              </div>
              <div className="border-t border-outline-variant pt-6">
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">RapidAPI Keys</h4>
                {netQuery.isLoading ? <PanelSkeleton rows={3} /> : netQuery.isError ? <QueryError /> : (
                  <KeyValueEditor value={netForm.api.rapidapi_keys} onChange={(v) => setNetForm((prev) => ({ ...prev, api: { ...prev.api, rapidapi_keys: v } }))} preseedKeys={RAPIDAPI_PRESEED} />
                )}
              </div>
              <div className="border-t border-outline-variant pt-6">
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">API 域名映射</h4>
                {netQuery.isLoading ? <PanelSkeleton rows={2} /> : netQuery.isError ? <QueryError /> : (
                  <KeyValueEditor value={netForm.api.hosts} onChange={(v) => setNetForm((prev) => ({ ...prev, api: { ...prev.api, hosts: v } }))} preseedKeys={HOSTS_PRESEED} />
                )}
              </div>
            </div>
          </section>

          {/* Panel 7: Notification */}
          <section id="panel-notification" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-notification']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">企业微信与通知路由</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">企业微信连接、通知渠道与触发规则。</p>
              </div>
              <StrategyBadge strategy="hot" carrier="PostgreSQL config_entries" />
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">企业微信连接</h4>
                {wecomQuery.isLoading ? <PanelSkeleton rows={3} /> : wecomQuery.isError ? <QueryError /> : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Bot ID</label>
                        <input className="form-input font-mono text-sm" value={wecomForm.bot_id || ''} onChange={(e) => setWecomForm((prev) => ({ ...prev, bot_id: e.target.value }))} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Bot Secret</label>
                        <input type="password" className="form-input font-mono text-sm" value={wecomForm.bot_secret || ''} onChange={(e) => setWecomForm((prev) => ({ ...prev, bot_secret: e.target.value }))} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Global Chat ID</label>
                        <input className="form-input font-mono text-sm" value={wecomForm.global_chat_id || ''} onChange={(e) => setWecomForm((prev) => ({ ...prev, global_chat_id: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-label-md text-label-md text-on-surface-variant">Account Chat Mapping (JSON)</label>
                      <textarea
                        className="form-input font-mono text-sm h-24"
                        value={mappingText}
                        onChange={(e) => setMappingText(e.target.value)}
                      />
                      {(() => {
                        let parsed: Record<string, string> = {};
                        let err = false;
                        try { parsed = JSON.parse(mappingText); } catch { err = true; }
                        if (err) return <p className="text-error text-body-sm mt-1">JSON 格式错误</p>;
                        return (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {Object.entries(parsed).map(([windowId, chatId]) => (
                              <span key={windowId} className="status-pill bg-surface-container text-on-surface-variant">
                                {windowId} → {chatId}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex justify-end">
                      <button onClick={handleSaveWecom} disabled={updateWecom.isPending} className="btn-secondary text-sm">
                        <MaterialIcon icon="save" size="sm" />
                        {updateWecom.isPending ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-outline-variant pt-6">
                <NotificationChannelsPanel
                  channels={channels}
                  rules={rules}
                  isLoading={notifLoading}
                  onUpdateChannel={(c) => updateChannel.mutate(c)}
                  onUpdateRule={(r) => updateRule.mutate(r)}
                />
              </div>
            </div>
          </section>

          {/* Panel 8: Security */}
          <section id="panel-security" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color={ACCENT_MAP['panel-security']} />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">权限、安全与审计</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">API 密钥轮换、RBAC 用户管理与审计日志。</p>
              </div>
              <StrategyBadge strategy="readonly" carrier="PostgreSQL config_audit_log (只读历史流)" />
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">API 安全密钥</h4>
                {apiKeyQuery.isLoading ? <PanelSkeleton rows={1} /> : apiKeyQuery.isError ? <QueryError /> : (
                  <div className="bento-card flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                      <MaterialIcon icon="shield" size="xl" className="text-primary" />
                      <div>
                        <div className="text-label-md text-label-md text-on-surface-variant">当前 API Key</div>
                        <div className="font-mono text-headline-md text-headline-md text-on-surface">
                          {maskKey(typeof apiKeyQuery.data === 'string' ? apiKeyQuery.data : apiKeyQuery.data?.key || '')}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={handleRotateKey}
                      disabled={rotateKey.isPending}
                      className="btn-secondary flex items-center gap-1.5"
                    >
                      <MaterialIcon icon={rotateKey.isPending ? 'sync' : 'refresh'} size="sm" spin={rotateKey.isPending} />
                      {rotateKey.isPending ? '轮换中…' : '轮换 Key'}
                    </button>
                  </div>
                )}
              </div>

              <div className="border-t border-outline-variant pt-6">
                <div className="border-b border-outline-variant bg-surface/50 mb-4">
                  <div className="flex items-center px-4 pt-2 gap-6">
                    <button
                      onClick={() => setRbacTab('rbac')}
                      className={cn(
                        'pb-3 border-b-2 text-label-md text-label-md pt-2 px-1 transition-colors',
                        rbacTab === 'rbac' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface',
                      )}
                    >
                      权限策略 (RBAC)
                    </button>
                    <button
                      onClick={() => setRbacTab('audit')}
                      className={cn(
                        'pb-3 border-b-2 text-label-md text-label-md pt-2 px-1 transition-colors',
                        rbacTab === 'audit' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface',
                      )}
                    >
                      安全审计日志
                    </button>
                  </div>
                </div>

                {rbacTab === 'rbac' && (
                  <RbacPanel
                    users={rbacUsers}
                    isLoading={rbacLoading}
                    onCreate={(u) => createUser.mutate(u)}
                    onUpdate={(u) => updateUser.mutate(u)}
                    onDelete={(id) => deleteUser.mutate(id)}
                    creating={createUser.isPending}
                  />
                )}

                {rbacTab === 'audit' && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-label-md text-label-md text-on-surface-variant">最近审计事件</span>
                      <button className="btn-secondary flex items-center gap-1.5 text-sm">
                        <MaterialIcon icon="download" size="sm" />
                        导出 CSV
                      </button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="table-flat w-full">
                        <thead>
                          <tr>
                            <th className="text-left">时间 (UTC+8)</th>
                            <th className="text-left">用户/实体</th>
                            <th className="text-left">操作类型</th>
                            <th className="text-left">资源对象</th>
                            <th className="text-right">状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditQuery.isLoading ? (
                            <tr><td colSpan={5} className="text-center text-on-surface-variant py-8">加载中…</td></tr>
                          ) : auditQuery.isError ? (
                            <tr><td colSpan={5} className="text-center text-error py-8">加载失败</td></tr>
                          ) : (
                            logs.map((log) => (
                              <tr key={log.id}>
                                <td className="font-mono text-[13px] text-outline">{log.time}</td>
                                <td>
                                  <div className="flex items-center gap-2">
                                    <Avatar name={log.actor} size={24} />
                                    <span className="text-sm">{log.actor}</span>
                                  </div>
                                </td>
                                <td className="font-medium text-on-surface">{log.action}</td>
                                <td className="font-mono text-[13px] text-outline">{log.resource}</td>
                                <td className="text-right">{statusPillFor(log.status)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex justify-center pt-2">
                      <button className="btn-secondary text-sm">加载更多记录</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Crawl Mode Panel Component
// ============================================================

function CrawlModePanel() {
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