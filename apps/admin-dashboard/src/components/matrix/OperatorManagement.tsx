'use client';

import { useState, useEffect } from 'react';
import { MaterialIcon, PlatformIcon, type MaterialIconName } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';
import {
  useOperators,
  useCreateOperator,
  useUpdateOperator,
  useDeleteOperator,
  useBrowserWindows,
  useSyncWindows,
  useCreateWindow,
  useBindWindow,
  useUnbindWindow,
  useAddPlatform,
  useRemovePlatform,
  useVerifyLogin,
  useCreateLinkRequest,
  usePollLinkResult,
  usePlatformCapabilities,
  type Operator,
  type BrowserWindowItem,
  type PlatformCapability,
} from '@/hooks/useApi';

// ============================================================
// Constants
// ============================================================

const PLATFORM_OPTIONS = [
  { key: 'douyin', label: '抖音' },
  { key: 'kuaishou', label: '快手' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'bilibili', label: 'B站' },
  { key: 'baijiahao', label: '百家号' },
  { key: 'tencent', label: '腾讯视频号' },
  { key: 'tiktok', label: 'TikTok' },
] as const;

const LOGIN_STATUS_MAP: Record<string, { label: string; tone: 'success' | 'warning' | 'error' | 'neutral'; icon: MaterialIconName }> = {
  logged_in: { label: '有效', tone: 'success', icon: 'check_circle' },
  pending: { label: '待确认', tone: 'warning', icon: 'help' },
  not_logged_in: { label: '失效', tone: 'error', icon: 'error' },
  unknown: { label: '未验证', tone: 'neutral', icon: 'visibility_off' },
  checking: { label: '验证中…', tone: 'warning', icon: 'sync' },
};

// ============================================================
// Sub-components
// ============================================================

function LoginBadge({ status }: { status: string }) {
  const s = LOGIN_STATUS_MAP[status] || LOGIN_STATUS_MAP.unknown;
  return <StatusPill tone={s.tone} icon={s.icon}>{s.label}</StatusPill>;
}

function PlatformRow({
  platform,
  loginStatus,
  onVerify,
  onRemove,
  verifying,
  capability,
}: {
  platform: string;
  loginStatus: string;
  onVerify: () => void;
  onRemove: () => void;
  verifying: boolean;
  capability?: PlatformCapability;
}) {
  const meta = PLATFORM_OPTIONS.find((p) => p.key === platform);

  // Debug: Log capability for tencent platform
  if (platform === 'tencent') {
    console.log('[DEBUG] PlatformRow tencent capability:', capability);
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface border border-outline-variant group hover:border-primary/30 transition-colors">
      <PlatformIcon platform={platform as any} size={24} />
      <span className="text-body-sm text-on-surface font-medium flex-1">{meta?.label || platform}</span>

      {/* Capability indicators */}
      {capability && (
        <div className="flex items-center gap-1.5 mr-2">
          {capability.canPublish && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium" title="支持发布">
              发布
            </span>
          )}
          {capability.canMonitor && (
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded font-medium',
              capability.canDeepCrawl
                ? 'bg-emerald-500/10 text-emerald-600'
                : 'bg-amber-500/10 text-amber-600'
            )} title={capability.canDeepCrawl ? '支持深度爬取' : '仅支持轻量通知'}>
              监控{capability.canDeepCrawl ? '·深度' : '·轻量'}
            </span>
          )}
          {!capability.canPublish && !capability.canMonitor && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
              仅发布
            </span>
          )}
        </div>
      )}

      <LoginBadge status={loginStatus} />
      <button
        onClick={onVerify}
        disabled={verifying}
        className="opacity-0 group-hover:opacity-100 text-primary text-xs hover:underline transition-opacity disabled:opacity-40"
        title="验证登录状态"
      >
        {verifying ? '验证中…' : '验证'}
      </button>
      <button
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 text-error text-xs hover:underline transition-opacity"
        title="移除平台"
      >
        移除
      </button>
    </div>
  );
}

// ============================================================
// Main Component
// ============================================================

export default function OperatorManagement() {
  // Data
  const { data: operators = [], isLoading } = useOperators() as { data: Operator[]; isLoading: boolean };
  const { data: windowsData } = useBrowserWindows('all') as { data: { windows: BrowserWindowItem[]; limits: any } };
  const windows = windowsData?.windows || [];
  const limits = windowsData?.limits || { bitbrowser: { current: 0, max: 10 }, roxybrowser: { current: 0, max: 5 }, total: { current: 0, max: 15 } };
  const { data: capabilitiesData } = usePlatformCapabilities() as { data: PlatformCapability[] };
  const createOperator = useCreateOperator();

  // Debug: Log capabilities data
  useEffect(() => {
    console.log('[DEBUG] capabilitiesData:', capabilitiesData);
    if (capabilitiesData) {
      const tencentCap = capabilitiesData.find((c) => c.platform === 'tencent');
      console.log('[DEBUG] tencent capability:', tencentCap);
    }
  }, [capabilitiesData]);
  const updateOperator = useUpdateOperator();
  const deleteOperator = useDeleteOperator();
  const syncWindows = useSyncWindows();
  const createWindow = useCreateWindow();
  const bindWindow = useBindWindow();
  const unbindWindow = useUnbindWindow();
  const addPlatform = useAddPlatform();
  const removePlatform = useRemovePlatform();
  const verifyLogin = useVerifyLogin();
  const createLinkRequest = useCreateLinkRequest();

  // UI State
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [addPlatformForOp, setAddPlatformForOp] = useState<number | null>(null);
  const [newPlatformKey, setNewPlatformKey] = useState('');
  const [selectedVendor, setSelectedVendor] = useState('bitbrowser');

  // 页面加载时自动同步所有厂商的窗口（容错：某厂商不可用不影响其他）
  useEffect(() => {
    syncWindows.mutate('all');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [showWindowList, setShowWindowList] = useState(false);
  const [showCreateWindow, setShowCreateWindow] = useState(false);
  const [newWindowName, setNewWindowName] = useState('');
  const [verifyingPlatforms, setVerifyingPlatforms] = useState<Set<string>>(new Set());

  // Link request state
  const [linkCode, setLinkCode] = useState('');
  const [linkPolling, setLinkPolling] = useState(false);
  const { data: linkResult } = usePollLinkResult(linkCode, linkPolling);

  // Add form state
  const [formWechatId, setFormWechatId] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formWindowId, setFormWindowId] = useState<number | null>(null);

  const resetForm = () => {
    setFormWechatId('');
    setFormDisplayName('');
    setFormPhone('');
    setFormWindowId(null);
    setShowAddForm(false);
    setEditingId(null);
    setLinkCode('');
    setLinkPolling(false);
  };

  const handleStartLink = () => {
    createLinkRequest.mutate(
      { timeoutMs: 120_000 },
      {
        onSuccess: (data: any) => {
          setLinkCode(data?.code || '');
          setLinkPolling(true);
        },
      },
    );
  };

  // When link result comes back, auto-fill wechatUserId
  if (linkResult?.status === 'completed' && linkResult?.userid) {
    const userid = linkResult.userid;
    if (formWechatId !== userid) {
      setFormWechatId(userid);
      setLinkPolling(false);
      setLinkCode('');
    }
  }
  if (linkResult?.status === 'timeout') {
    setLinkPolling(false);
    setLinkCode('');
  }

  const handleCreate = () => {
    if (!formWechatId.trim() || !formDisplayName.trim()) return;
    createOperator.mutate(
      { wechatUserId: formWechatId.trim(), displayName: formDisplayName.trim(), phone: formPhone.trim() || undefined },
      {
        onSuccess: (data: any) => {
          // If a window was selected, bind it
          if (formWindowId && data?.id) {
            bindWindow.mutate(
              { windowId: formWindowId, operatorId: data.id },
              {
                onError: (err: any) => {
                  alert(`用户已创建，但绑定窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                },
              },
            );
          }
          resetForm();
        },
        onError: (err: any) => {
          alert(`创建用户失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
        },
      },
    );
  };

  const handleUpdate = () => {
    if (!editingId || !formDisplayName.trim() || !formWechatId.trim()) return;
    updateOperator.mutate(
      { id: editingId, wechatUserId: formWechatId.trim(), displayName: formDisplayName.trim(), phone: formPhone.trim() || undefined },
      {
        onSuccess: () => {
          // Handle window binding changes
          const currentWindow = operators.find((op) => op.id === editingId)?.windows[0];
          if (formWindowId && formWindowId !== currentWindow?.id) {
            // Bind new window
            bindWindow.mutate(
              { windowId: formWindowId, operatorId: editingId },
              {
                onError: (err: any) => {
                  alert(`用户信息已更新，但绑定窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                },
              },
            );
          } else if (!formWindowId && currentWindow) {
            // Unbind current window
            unbindWindow.mutate(currentWindow.id, {
              onError: (err: any) => {
                alert(`用户信息已更新，但解绑窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
              },
            });
          }
          resetForm();
        },
        onError: (err: any) => {
          alert(`更新用户失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
        },
      },
    );
  };

  const startEdit = (op: Operator) => {
    setEditingId(op.id);
    setFormWechatId(op.wechatUserId);
    setFormDisplayName(op.displayName);
    setFormPhone(op.phone || '');
    setFormWindowId(op.windows[0]?.id || null);
    setShowAddForm(false);
  };

  const handleDelete = (id: number) => {
    deleteOperator.mutate(id, {
      onSuccess: () => setDeletingId(null),
      onError: (err: any) => {
        alert(`删除用户失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
      },
    });
  };

  const handleBindWindow = (operatorId: number, windowId: number) => {
    bindWindow.mutate(
      { windowId, operatorId },
      {
        onError: (err: any) => {
          alert(`绑定窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
        },
      },
    );
  };

  const handleAddPlatform = (operatorId: number) => {
    if (!newPlatformKey) return;
    addPlatform.mutate(
      { operatorId, platform: newPlatformKey },
      {
        onSuccess: () => { setAddPlatformForOp(null); setNewPlatformKey(''); },
        onError: (err: any) => {
          alert(`添加平台失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
        },
      },
    );
  };

  // Unbound windows for binding dropdown
  const unboundWindows = windows.filter((w) => w.status === 'available');

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-headline-md text-on-surface">用户管理</h2>
          <p className="text-body-sm text-on-surface-variant mt-1">
            每个用户绑定一个窗口，窗口内管理多个平台账号。用户ID为企业微信ID。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncWindows.mutate(selectedVendor)}
            disabled={syncWindows.isPending}
            className="btn-ghost flex items-center gap-1.5 text-sm"
          >
            <MaterialIcon icon="sync" size="sm" className={syncWindows.isPending ? 'animate-spin-slow' : ''} />
            {syncWindows.isPending ? '同步中…' : '同步窗口'}
          </button>
          <button
            onClick={() => { setShowAddForm(true); setEditingId(null); setFormWechatId(''); setFormDisplayName(''); setFormPhone(''); }}
            className="btn-primary flex items-center gap-1.5"
          >
            <MaterialIcon icon="add" size="sm" />
            添加用户
          </button>
        </div>
      </div>

      {/* Window list toggle */}
      <div className="flex items-center gap-2 text-body-sm text-on-surface-variant">
        <button
          onClick={() => setShowWindowList(!showWindowList)}
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          <MaterialIcon icon="visibility" size="xs" />
          {showWindowList ? '隐藏窗口列表' : `查看可用窗口 (${windows.length})`}
        </button>
      </div>

      {/* Window list (collapsible) */}
      {showWindowList && (
        <div className="p-3 bg-surface-container rounded-xl border border-outline-variant">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-label-md text-on-surface-variant">窗口管理</h4>
            <button
              onClick={() => syncWindows.mutate(selectedVendor)}
              disabled={syncWindows.isPending}
              className="btn-ghost text-xs flex items-center gap-1"
            >
              <MaterialIcon icon="sync" size="xs" className={syncWindows.isPending ? 'animate-spin-slow' : ''} />
              同步
            </button>
          </div>

          {/* BitBrowser section */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-on-surface-variant">BitBrowser</span>
              <span className="text-xs text-on-surface-variant">
                {limits.bitbrowser.current}/{limits.bitbrowser.max}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
              {windows
                .filter((w) => w.browserVendor === 'bitbrowser')
                .map((w) => (
                  <div
                    key={w.id}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs',
                      w.status === 'bound'
                        ? 'border-primary/30 bg-primary/5'
                        : 'border-outline-variant bg-surface',
                    )}
                  >
                    <MaterialIcon icon="open_in_new" size="xs" className="text-primary shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-on-surface truncate">{w.windowName || w.externalId}</p>
                      {w.operator && <p className="text-on-surface-variant truncate">{w.operator.displayName}</p>}
                    </div>
                    {w.status === 'bound' && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
                  </div>
                ))}
              {/* Placeholder slots */}
              {Array.from({ length: Math.max(0, limits.bitbrowser.max - limits.bitbrowser.current) }).map((_, i) => (
                <button
                  key={`bit-placeholder-${i}`}
                  onClick={() => { setShowCreateWindow(true); setSelectedVendor('bitbrowser'); }}
                  className="flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-dashed border-outline-variant/60 text-xs text-on-surface-variant/50 hover:border-primary/40 hover:text-primary/70 hover:bg-primary/5 transition-colors"
                >
                  <MaterialIcon icon="add" size="xs" />
                  <span>添加窗口</span>
                </button>
              ))}
            </div>
          </div>

          {/* RoxyBrowser section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-on-surface-variant">RoxyBrowser</span>
              <span className="text-xs text-on-surface-variant">
                {limits.roxybrowser.current}/{limits.roxybrowser.max}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
              {windows
                .filter((w) => w.browserVendor === 'roxybrowser')
                .map((w) => (
                  <div
                    key={w.id}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs',
                      w.status === 'bound'
                        ? 'border-primary/30 bg-primary/5'
                        : 'border-outline-variant bg-surface',
                    )}
                  >
                    <MaterialIcon icon="open_in_new" size="xs" className="text-primary shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-on-surface truncate">{w.windowName || w.externalId}</p>
                      {w.operator && <p className="text-on-surface-variant truncate">{w.operator.displayName}</p>}
                    </div>
                    {w.status === 'bound' && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
                  </div>
                ))}
              {/* Placeholder slots */}
              {Array.from({ length: Math.max(0, limits.roxybrowser.max - limits.roxybrowser.current) }).map((_, i) => (
                <button
                  key={`roxy-placeholder-${i}`}
                  onClick={() => { setShowCreateWindow(true); setSelectedVendor('roxybrowser'); }}
                  className="flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-dashed border-outline-variant/60 text-xs text-on-surface-variant/50 hover:border-primary/40 hover:text-primary/70 hover:bg-primary/5 transition-colors"
                >
                  <MaterialIcon icon="add" size="xs" />
                  <span>添加窗口</span>
                </button>
              ))}
            </div>
          </div>

          {/* Total count */}
          <div className="mt-3 pt-2 border-t border-outline-variant/50 flex items-center justify-between text-xs text-on-surface-variant">
            <span>总计窗口</span>
            <span>{limits.total.current}/{limits.total.max}</span>
          </div>
        </div>
      )}

      {/* Create Window Form (inline) */}
      {showCreateWindow && (
        <div className="p-4 bg-surface-container-lowest rounded-xl border border-primary/30 shadow-sm">
          <h3 className="text-label-md text-on-surface mb-3">
            创建新窗口 — {selectedVendor === 'bitbrowser' ? 'BitBrowser' : 'RoxyBrowser'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">窗口名称 *</label>
              <input
                className="form-input w-full"
                value={newWindowName}
                onChange={(e) => setNewWindowName(e.target.value)}
                placeholder="例如: 抖音运营01"
              />
            </div>
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">供应商</label>
              <select
                className="form-input w-full"
                value={selectedVendor}
                onChange={(e) => setSelectedVendor(e.target.value)}
              >
                <option value="bitbrowser">BitBrowser (剩余 {limits.bitbrowser.max - limits.bitbrowser.current} 个)</option>
                <option value="roxybrowser">RoxyBrowser (剩余 {limits.roxybrowser.max - limits.roxybrowser.current} 个)</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn-ghost" onClick={() => { setShowCreateWindow(false); setNewWindowName(''); }}>取消</button>
            <button
              className="btn-primary"
              onClick={() => {
                if (!newWindowName.trim()) return;
                createWindow.mutate(
                  { vendor: selectedVendor, name: newWindowName.trim() },
                  { onSuccess: () => { setShowCreateWindow(false); setNewWindowName(''); } },
                );
              }}
              disabled={createWindow.isPending || !newWindowName.trim()}
            >
              {createWindow.isPending ? '创建中…' : '创建窗口'}
            </button>
          </div>
        </div>
      )}

      {/* Add / Edit Form (inline) */}
      {(showAddForm || editingId) && (
        <div className="p-4 bg-surface-container-lowest rounded-xl border border-primary/30 shadow-sm">
          <h3 className="text-label-md text-on-surface mb-3">{editingId ? '编辑用户' : '添加新用户'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">企业微信用户ID *</label>
              <div className="flex gap-2">
                <input
                  className="form-input flex-1"
                  value={formWechatId}
                  onChange={(e) => setFormWechatId(e.target.value)}
                  placeholder="例如: WangXiaoMing"
                />
                {!editingId && (
                  <button
                    type="button"
                    onClick={handleStartLink}
                    disabled={createLinkRequest.isPending || linkPolling}
                    className="btn-ghost text-xs px-2 py-1 shrink-0 flex items-center gap-1 border border-outline-variant rounded hover:border-primary"
                    title="通过企业微信机器人自动获取用户ID"
                  >
                    <MaterialIcon icon="link" size="sm" />
                    {linkPolling ? '等待中…' : '获取ID'}
                  </button>
                )}
              </div>
              {/* Link request status */}
              {linkPolling && linkCode && (
                <div className="mt-2 p-2 bg-primary/5 border border-primary/20 rounded-lg text-xs text-on-surface-variant">
                  <p className="flex items-center gap-1 mb-1">
                    <MaterialIcon icon="sync" size="xs" className="animate-spin-slow text-primary" />
                    <span className="text-primary font-medium">等待用户回复验证码…</span>
                  </p>
                  <p>验证码: <span className="font-mono text-primary font-bold text-sm">{linkCode}</span></p>
                  <p className="mt-1 opacity-70">请让用户向企业微信机器人发送此验证码，系统将自动获取用户ID。</p>
                </div>
              )}
            </div>
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">显示名称 *</label>
              <input
                className="form-input w-full"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder="例如: 王小明"
              />
            </div>
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">手机号（可选）</label>
              <input
                className="form-input w-full"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value)}
                placeholder="例如: 13800138000"
              />
            </div>
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">绑定窗口（可选）</label>
              <select
                className="form-input w-full"
                value={formWindowId || ''}
                onChange={(e) => setFormWindowId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">暂不绑定</option>
                {unboundWindows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.windowName || w.externalId} ({w.browserVendor})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn-ghost" onClick={resetForm}>取消</button>
            <button
              className="btn-primary"
              onClick={editingId ? handleUpdate : handleCreate}
              disabled={createOperator.isPending || updateOperator.isPending || !formWechatId.trim() || !formDisplayName.trim()}
            >
              {(createOperator.isPending || updateOperator.isPending) ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="bento-card animate-pulse h-48 rounded-xl" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && operators.length === 0 && (
        <div className="bento-card text-center py-12 rounded-xl">
          <MaterialIcon icon="people" size="3xl" className="text-outline mb-3 opacity-40" />
          <p className="text-body-sm text-on-surface-variant">暂无用户，点击"添加用户"开始</p>
        </div>
      )}

      {/* Operator Cards */}
      {operators.map((op) => {
        const boundWindow = op.windows[0] || null;
        const isDeleting = deletingId === op.id;
        const isAddingPlatform = addPlatformForOp === op.id;
        const usedPlatforms = op.platforms.map((p) => p.platform);
        const availablePlatforms = PLATFORM_OPTIONS.filter((p) => !usedPlatforms.includes(p.key));

        return (
          <div
            key={op.id}
            className={cn(
              'bento-card rounded-xl border overflow-hidden transition-all',
              isDeleting ? 'border-error/50 bg-error/5' : 'border-outline-variant bg-surface-container-lowest',
            )}
          >
            {/* Card Header: User info + Window + Actions */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant">
              <div className="flex items-center gap-4 flex-1 min-w-0">
                {/* User avatar/icon */}
                <div className="w-10 h-10 rounded-full bg-primary-container text-on-primary flex items-center justify-center shrink-0">
                  <MaterialIcon icon="person" size="md" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-label-md text-on-surface font-bold truncate">{op.displayName}</h3>
                    <span className="text-xs text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full font-mono shrink-0">
                      {op.wechatUserId}
                    </span>
                    {!op.enabled && (
                      <StatusPill tone="error">已禁用</StatusPill>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-body-sm text-on-surface-variant">
                    {/* Bound window */}
                    {boundWindow ? (
                      <span className="flex items-center gap-1">
                        <MaterialIcon icon="open_in_new" size="xs" />
                        <span className="font-mono">{boundWindow.windowName || boundWindow.externalId}</span>
                        <span className="text-xs opacity-60">({boundWindow.browserVendor})</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-warning">
                        <MaterialIcon icon="link_off" size="xs" />
                        未绑定窗口
                      </span>
                    )}
                    {/* Platform count */}
                    <span className="flex items-center gap-1">
                      <MaterialIcon icon="apps" size="xs" />
                      {op.platforms.length} 个平台
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {/* Bind window dropdown */}
                {!boundWindow && unboundWindows.length > 0 && (
                  <select
                    className="form-input text-xs py-1 px-2 w-40"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        const wid = Number(e.target.value);
                        bindWindow.mutate(
                          { windowId: wid, operatorId: op.id },
                          {
                            onError: (err: any) => {
                              alert(`绑定窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                            },
                          },
                        );
                      }
                    }}
                  >
                    <option value="">绑定窗口…</option>
                    {unboundWindows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.windowName || w.externalId} ({w.browserVendor})
                      </option>
                    ))}
                  </select>
                )}
                {boundWindow && (
                  <button
                    onClick={() => unbindWindow.mutate(boundWindow.id, {
                      onError: (err: any) => {
                        alert(`解绑窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                      },
                    })}
                    className="btn-ghost text-xs px-2 py-1"
                    title="解绑窗口"
                  >
                    <MaterialIcon icon="link_off" size="sm" />
                  </button>
                )}
                <button onClick={() => startEdit(op)} className="btn-ghost px-2 py-1" title="编辑用户">
                  <MaterialIcon icon="edit" size="sm" />
                </button>
                {isDeleting ? (
                  <div className="flex items-center gap-1 ml-1">
                    <button
                      onClick={() => handleDelete(op.id)}
                      className="text-xs bg-error text-white px-2 py-1 rounded hover:bg-error/90"
                      disabled={deleteOperator.isPending}
                    >
                      {deleteOperator.isPending ? '删除中…' : '确认删除'}
                    </button>
                    <button onClick={() => setDeletingId(null)} className="text-xs text-on-surface-variant hover:text-on-surface px-1">
                      取消
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setDeletingId(op.id)} className="btn-ghost px-2 py-1 text-error" title="删除用户">
                    <MaterialIcon icon="delete" size="sm" />
                  </button>
                )}
              </div>
            </div>

            {/* Card Body: Platform List */}
            <div className="px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-label-md text-on-surface-variant">平台管理</h4>
                {availablePlatforms.length > 0 && (
                  <button
                    onClick={() => setAddPlatformForOp(isAddingPlatform ? null : op.id)}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <MaterialIcon icon="add" size="xs" />
                    {isAddingPlatform ? '取消' : '添加平台'}
                  </button>
                )}
              </div>

              {/* Add platform inline */}
              {isAddingPlatform && (
                <div className="flex items-center gap-2 mb-3 p-2 bg-surface-container rounded-lg border border-outline-variant">
                  <select
                    className="form-input text-sm py-1 flex-1"
                    value={newPlatformKey}
                    onChange={(e) => setNewPlatformKey(e.target.value)}
                  >
                    <option value="">选择平台…</option>
                    {availablePlatforms.map((p) => (
                      <option key={p.key} value={p.key}>{p.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleAddPlatform(op.id)}
                    disabled={!newPlatformKey || addPlatform.isPending}
                    className="btn-primary text-xs px-3 py-1"
                  >
                    {addPlatform.isPending ? '添加中…' : '确认'}
                  </button>
                </div>
              )}

              {/* Platform rows */}
              {op.platforms.length === 0 ? (
                <p className="text-body-sm text-on-surface-variant text-center py-4">暂无平台，请点击"添加平台"</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {op.platforms.map((plat) => {
                    const capability = capabilitiesData?.find((c) => c.platform === plat.platform);
                    return (
                      <PlatformRow
                        key={plat.platform}
                        platform={plat.platform}
                        loginStatus={plat.loginStatus}
                        onVerify={() => {
                          const key = `${op.id}_${plat.platform}`;
                          setVerifyingPlatforms(prev => new Set(prev).add(key));
                          verifyLogin.mutate(
                            { operatorId: op.id, platform: plat.platform },
                            { onSettled: () => setVerifyingPlatforms(prev => {
                              const next = new Set(prev);
                              next.delete(key);
                              return next;
                            })},
                          );
                        }}
                        onRemove={() => removePlatform.mutate(
                          { operatorId: op.id, platform: plat.platform },
                          {
                            onError: (err: any) => {
                              alert(`移除平台失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                            },
                          },
                        )}
                        verifying={verifyingPlatforms.has(`${op.id}_${plat.platform}`)}
                        capability={capability}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
