'use client';

import { useState, useRef, useMemo, useCallback, useEffect, type KeyboardEvent } from 'react';
import {
  useHostedAccounts,
  useUploadVideo,
  useBatchPublish,
  useTaskStatuses,
  type BatchPublishResult,
  type BatchPublishAccount,
  type TaskStatus,
  type UploadResult,
  useMonitorTargets,
  useMonitorVideos,
  useVideoComments,
  useMarkCommentRead,
  useMarkAllCommentsRead,
  useReplyComment,
  useMonitorAccounts,
  useMonitorAccountDetail,
  useTriggerMonitor,
  useToggleMonitor,
  useNewCommentsOverview,
  useMonitorTaskStatuses,
  useSchedulerStatus,
  useTriggerAllMonitor,
  type MonitorAccount,
  type MonitorAccountDetail,
  type NewCommentVideo,
  type MonitorTaskStatus,
  usePinterestScrape,
  usePinterestStatus,
  useOperators,
  type Operator,
} from '@/hooks/useApi';
import { MaterialIcon, PlatformIcon, Avatar } from '@/components/ui/MaterialIcon';
import { BentoCard } from '@/components/ui/Bento';
import { StatusPill, ToggleSwitch } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';
import OperatorManagement from '@/components/matrix/OperatorManagement';

// ─────────────────────────────────────────────
//  Publish Tab Helpers & Types
// ─────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  douyin: 'Douyin',
  xiaohongshu: 'Xiaohongshu',
  tencent: 'WeChat Video',
  kuaishou: 'Kuaishou',
  bilibili: 'Bilibili',
  baijiahao: 'Baijiahao',
  tiktok: 'TikTok',
};

const MOCK_ACCOUNTS = [
  { id: '1', platform: 'douyin' as const, accountName: '抖音矩阵-主号', windowId: 'WIN-A892-DY', cookieStatus: 'valid' as const, cookieValidDays: 7 },
  { id: '2', platform: 'xiaohongshu' as const, accountName: '品牌薯-生活', windowId: 'WIN-B104-XHS', cookieStatus: 'valid' as const, cookieValidDays: 12 },
  { id: '3', platform: 'tencent' as const, accountName: '官方视频号', windowId: 'WIN-C099-WX', cookieStatus: 'expiring' as const, cookieValidDays: 2 },
  { id: '4', platform: 'kuaishou' as const, accountName: '快手小店-直播切片', windowId: 'WIN-D201-KS', cookieStatus: 'expired' as const, cookieValidDays: 0 },
];

type HostedAccount = (typeof MOCK_ACCOUNTS)[number];

type PublishStep = 'idle' | 'uploading' | 'submitting' | 'done' | 'upload_error' | 'upload_progress';

// ─────────────────────────────────────────────
//  Monitor Tab Helpers & Types
// ─────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return '—';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN');
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString('zh-CN');
}

const FALLBACK_TARGETS = [
  { platform: 'douyin', displayName: 'TechInsider', userCount: 3, videoCount: 45, commentCount: 328, monitoringEnabled: true },
  { platform: 'xiaohongshu', displayName: 'GlobalMarket', userCount: 1, videoCount: 12, commentCount: 86, monitoringEnabled: false },
];

const FALLBACK_VIDEOS = [
  { id: 'v1', description: 'Q3 智能设备市场份额分析与预测趋势', commentCount: 12, platform: 'douyin', windowId: 'w1', metrics: { viewCount: 12500, likeCount: 842 }, thumbnail: '', duration: '12:45' },
  { id: 'v2', description: 'SaaS 产品定价策略：如何打破内卷僵局', commentCount: 5, platform: 'xiaohongshu', windowId: 'w2', metrics: { viewCount: 5200, likeCount: 120 }, thumbnail: '', duration: '08:20' },
];

type Comment = {
  id: string | number;
  cid?: string;
  text: string;
  userNickname: string;
  diggCount?: number;
  createTime: string;
  isNew?: boolean;
  ipLocation?: string;
  replies?: Comment[];
};

// ─────────────────────────────────────────────
//  Main Page Component
// ─────────────────────────────────────────────

export default function MatrixPage() {
  const [activeTab, setActiveTab] = useState<'users' | 'publish' | 'monitor'>('users');

  return (
    <>
      {/* Tab Bar */}
      <div className="px-4 pt-4 pb-2">
        <div className="inline-flex gap-1 p-1 rounded-xl bg-surface-container">
          <button
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all',
              activeTab === 'users'
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
            )}
            onClick={() => setActiveTab('users')}
          >
            <MaterialIcon icon="people" size="sm" />
            用户管理
          </button>
          <button
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all',
              activeTab === 'publish'
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
            )}
            onClick={() => setActiveTab('publish')}
          >
            <MaterialIcon icon="send" size="sm" />
            发布管理
          </button>
          <button
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all',
              activeTab === 'monitor'
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
            )}
            onClick={() => setActiveTab('monitor')}
          >
            <MaterialIcon icon="monitoring" size="sm" />
            数据监控
          </button>
        </div>
      </div>

      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'publish' && <PublishTab />}
      {activeTab === 'monitor' && <MonitorTab />}
    </>
  );
}

// ─────────────────────────────────────────────
//  Tab 1: 用户管理
// ─────────────────────────────────────────────

function UsersTab() {
  return (
    <div className="max-w-6xl mx-auto px-4 pb-12">
      <OperatorManagement />
    </div>
  );
}

// ─────────────────────────────────────────────
//  Tab 2: 发布管理
// ─────────────────────────────────────────────

function PublishTab() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>(['SaaS工具', '企业管理', '效率提升']);
  const [visibility, setVisibility] = useState('公开可见');
  const [scheduleTime, setScheduleTime] = useState('');
  const [useSchedule, setUseSchedule] = useState(false); // 定时发布开关
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [ossUrl, setOssUrl] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null); // OSS 上传完成后的结果
  const [uploadError, setUploadError] = useState<string>(''); // 上传错误信息
  const [step, setStep] = useState<PublishStep>('idle');
  const [batchResult, setBatchResult] = useState<BatchPublishResult | null>(null);
  const [taskIds, setTaskIds] = useState<string[]>([]); // 发布后追踪执行状态

  const uploadVideo = useUploadVideo();
  const batchPublish = useBatchPublish();
  const taskStatuses = useTaskStatuses(taskIds);  // 轮询执行状态
  const { data: operators = [] as Operator[] } = useOperators();
  const [selected, setSelected] = useState<Map<number, Set<string>>>(new Map());

  // All platforms (union of all operator platforms)
  const allPlatforms = useMemo(() => {
    const set = new Set<string>();
    for (const op of operators) {
      for (const p of op.platforms) set.add(p.platform);
    }
    return Array.from(set);
  }, [operators]);

  // Helpers
  const isSelected = (opId: number, platform: string) => selected.get(opId)?.has(platform) ?? false;
  const isUserAllSelected = (opId: number) => {
    const op = operators.find((o) => o.id === opId);
    if (!op || op.platforms.length === 0) return false;
    return op.platforms.every((p) => isSelected(opId, p.platform));
  };
  const isPlatformAllSelected = (platform: string) => {
    const opsWithPlatform = operators.filter((op) => op.platforms.some((p) => p.platform === platform));
    return opsWithPlatform.length > 0 && opsWithPlatform.every((op) => isSelected(op.id, platform));
  };
  const isAllSelected = operators.length > 0 && operators.every((op) => isUserAllSelected(op.id));

  const totalSelected = useMemo(() => {
    let count = 0;
    for (const [, platforms] of selected) count += platforms.size;
    return count;
  }, [selected]);

  // Toggle single cell
  const toggleCell = (opId: number, platform: string) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(opId) || []);
      if (set.has(platform)) set.delete(platform); else set.add(platform);
      if (set.size === 0) next.delete(opId); else next.set(opId, set);
      return next;
    });
  };

  // Toggle all platforms for one user
  const toggleUser = (opId: number) => {
    const op = operators.find((o) => o.id === opId);
    if (!op) return;
    const allSelected = isUserAllSelected(opId);
    setSelected((prev) => {
      const next = new Map(prev);
      if (allSelected) {
        next.delete(opId);
      } else {
        next.set(opId, new Set(op.platforms.map((p) => p.platform)));
      }
      return next;
    });
  };

  // Toggle all users for one platform
  const togglePlatform = (platform: string) => {
    const allSelected = isPlatformAllSelected(platform);
    setSelected((prev) => {
      const next = new Map(prev);
      for (const op of operators) {
        if (!op.platforms.some((p) => p.platform === platform)) continue;
        const set = new Set(next.get(op.id) || []);
        if (allSelected) {
          set.delete(platform);
        } else {
          set.add(platform);
        }
        if (set.size === 0) next.delete(op.id); else next.set(op.id, set);
      }
      return next;
    });
  };

  // Toggle all
  const toggleAll = () => {
    if (isAllSelected) {
      setSelected(new Map());
    } else {
      const next = new Map<number, Set<string>>();
      for (const op of operators) {
        next.set(op.id, new Set(op.platforms.map((p) => p.platform)));
      }
      setSelected(next);
    }
  };

  // Build batch publish accounts from selection
  const buildBatchAccounts = (): BatchPublishAccount[] => {
    const accounts: BatchPublishAccount[] = [];
    for (const [opId, platforms] of selected) {
      const op = operators.find((o) => o.id === opId);
      if (!op || !op.windows[0]) continue;
      const window = op.windows[0];
      for (const platform of platforms) {
        accounts.push({
          accountId: String(opId),
          windowId: window.externalId,
          platform: platform as any,
          credentials: { username: op.displayName },
        });
      }
    }
    return accounts;
  };

  const canPublish = totalSelected > 0 && title.trim().length > 0 && !!uploadResult;
  const isProcessing = step === 'uploading' || step === 'upload_progress' || step === 'submitting';

  // Missing conditions for hint display
  const missingConditions: string[] = [];
  if (totalSelected === 0) missingConditions.push('选择发布目标（在上方矩阵中勾选用户×平台）');
  if (title.trim().length === 0) missingConditions.push('填写视频标题');
  if (!uploadResult) missingConditions.push('选择并上传视频文件');

  const handlePublish = async () => {
    if (!canPublish || !uploadResult) return;
    setBatchResult(null);
    setTaskIds([]);
    setStep('submitting');
    try {
      const result = await batchPublish.mutateAsync({
        video: { ossUrl: uploadResult.ossUrl, filename: uploadResult.filename, size: uploadResult.size, duration: uploadResult.duration },
        metadata: { title, tags, ...(useSchedule && scheduleTime ? { scheduleTime } : {}), isOriginal: true },
        accounts: buildBatchAccounts(),
      });
      setBatchResult(result);
      // 收集所有 taskId 开始轮询执行状态
      const ids = result.groups.flatMap((g) => g.results.map((r) => r.taskId).filter(Boolean)) as string[];
      setTaskIds(ids);
      setStep('done');
    } catch (err: any) {
      console.error('发布失败:', err);
      setStep('idle');
    }
  };

  // 选择文件 → 立即上传到 OSS
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    setOssUrl(null);
    setUploadResult(null);
    setBatchResult(null);
    setStep('upload_progress');
    try {
      const uploaded = await uploadVideo.mutateAsync(file);
      setOssUrl(uploaded.ossUrl);
      setUploadResult(uploaded);
      setStep('done');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || '未知错误';
      console.error('上传失败:', msg);
      setUploadError(msg);
      setStep('upload_error');
    }
  };

  const addTag = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const value = e.currentTarget.value.trim();
      if (value && !tags.includes(value)) { setTags([...tags, value]); e.currentTarget.value = ''; }
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 space-y-section-margin pb-12">
      {/* User × Platform Matrix Selection */}
      <section>
        <div className="flex items-center justify-between mb-stack-md">
          <div>
            <h2 className="text-headline-md text-on-background">选择发布目标</h2>
            <p className="text-body-sm text-on-surface-variant mt-1">
              按用户 × 平台矩阵选择发布目标。同窗口多平台串行执行（防风控锁），跨窗口并行。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-label-md text-on-surface-variant">已选 {totalSelected} 项</span>
          </div>
        </div>

        {operators.length === 0 ? (
          <div className="bento-card text-center py-12 rounded-xl">
            <MaterialIcon icon="people" size="3xl" className="text-outline mb-3 opacity-40" />
            <p className="text-body-sm text-on-surface-variant">暂无用户，请先在"用户管理"中添加</p>
          </div>
        ) : (
          <div className="bento-card rounded-xl border border-outline-variant overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr className="bg-surface-container">
                  <th className="py-3 px-4 text-label-md text-on-surface-variant font-semibold border-b border-outline-variant w-[200px]">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isAllSelected}
                        onChange={toggleAll}
                        className="rounded border-outline-variant text-primary focus:ring-primary w-4 h-4"
                      />
                      用户
                    </label>
                  </th>
                  {allPlatforms.map((platform) => (
                    <th key={platform} className="py-3 px-3 text-center border-b border-outline-variant">
                      <label className="flex flex-col items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isPlatformAllSelected(platform)}
                          onChange={() => togglePlatform(platform)}
                          className="rounded border-outline-variant text-primary focus:ring-primary w-4 h-4"
                        />
                        <PlatformIcon platform={platform as any} size={20} />
                        <span className="text-xs text-on-surface-variant">{PLATFORM_LABELS[platform] || platform}</span>
                      </label>
                    </th>
                  ))}
                  <th className="py-3 px-3 text-center text-label-sm text-on-surface-variant border-b border-outline-variant w-[100px]">窗口</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {operators.map((op) => {
                  const opPlatforms = new Set(op.platforms.map((p) => p.platform));
                  const boundWindow = op.windows[0];
                  return (
                    <tr key={op.id} className="hover:bg-surface-container-low transition-colors">
                      <td className="py-3 px-4">
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isUserAllSelected(op.id)}
                            onChange={() => toggleUser(op.id)}
                            className="rounded border-outline-variant text-primary focus:ring-primary w-4 h-4"
                          />
                          <div className="w-8 h-8 rounded-full bg-primary-container text-on-primary flex items-center justify-center shrink-0">
                            <MaterialIcon icon="person" size="sm" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-label-md text-on-surface truncate">{op.displayName}</p>
                            <p className="text-xs text-on-surface-variant font-mono">{op.wechatUserId}</p>
                          </div>
                        </label>
                      </td>
                      {allPlatforms.map((platform) => (
                        <td key={platform} className="py-3 px-3 text-center">
                          {opPlatforms.has(platform) ? (
                            (() => {
                              const plat = op.platforms.find((p) => p.platform === platform);
                              const status = plat?.loginStatus || 'unknown';
                              return (
                                <label className="flex flex-col items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={isSelected(op.id, platform)}
                                    onChange={() => toggleCell(op.id, platform)}
                                    className="rounded border-outline-variant text-primary focus:ring-primary w-4 h-4"
                                  />
                                  {status === 'logged_in' && <span className="w-2 h-2 rounded-full bg-emerald-500" title="有效" />}
                                  {status === 'not_logged_in' && <span className="w-2 h-2 rounded-full bg-red-500" title="失效" />}
                                  {status !== 'logged_in' && status !== 'not_logged_in' && <span className="w-2 h-2 rounded-full bg-gray-300" title="未验证" />}
                                </label>
                              );
                            })()
                          ) : (
                            <span className="text-outline/30">—</span>
                          )}
                        </td>
                      ))}
                      <td className="py-3 px-3 text-center">
                        {boundWindow ? (
                          <span className="text-xs font-mono text-on-surface-variant">{boundWindow.windowName || boundWindow.externalId}</span>
                        ) : (
                          <span className="text-xs text-warning">未绑定</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Publish Form */}
      <section>
        <h2 className="text-headline-md text-on-background mb-stack-md">发布设置</h2>
        <BentoCard className="bg-surface-container-lowest">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-5">
              <div
                className="h-full min-h-[300px] border border-dashed border-primary rounded-lg bg-primary-fixed/5 flex flex-col items-center justify-center p-8 text-center cursor-pointer hover:bg-primary-fixed/10 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {step === 'upload_progress' ? (
                  <div className="flex flex-col items-center">
                    <MaterialIcon icon="cloud_upload" size="3xl" fill className="animate-pulse text-primary mb-4" />
                    <h3 className="text-headline-md text-on-surface mb-2">上传中…</h3>
                    <p className="text-body-sm text-on-surface-variant">{videoFile?.name}</p>
                    <div className="w-48 h-1.5 bg-surface-container-highest rounded-full mt-3 overflow-hidden">
                      <div className="h-full bg-primary rounded-full animate-pulse" style={{ width: '60%' }} />
                    </div>
                    <p className="text-label-sm text-on-surface-variant mt-1">正在上传到 OSS…</p>
                  </div>
                ) : step === 'upload_error' ? (
                  <div className="flex flex-col items-center">
                    <MaterialIcon icon="error" size="3xl" fill className="text-error mb-4" />
                    <h3 className="text-headline-md text-on-surface mb-2">上传失败</h3>
                    <p className="text-body-sm text-error mb-2">{uploadError}</p>
                    <button className="btn-primary text-sm" onClick={() => { setUploadError(''); fileInputRef.current?.click(); }}>
                      重新选择文件
                    </button>
                  </div>
                ) : ossUrl ? (
                  <div className="flex flex-col items-center">
                    <MaterialIcon icon="check_circle" size="3xl" fill className="text-emerald-600 mb-4" />
                    <h3 className="text-headline-md text-on-surface mb-2">{videoFile?.name}</h3>
                    <p className="text-body-sm text-on-surface-variant">{videoFile && formatFileSize(videoFile.size)} · 已上传到 OSS</p>
                  </div>
                ) : step === 'idle' ? (
                  <>
                    <MaterialIcon icon="cloud_upload" size="3xl" fill className="text-primary mb-4" />
                    <h3 className="text-headline-md text-on-surface mb-2">拖拽视频文件至此</h3>
                    <p className="text-body-sm text-on-surface-variant mb-4">或点击上传</p>
                    <p className="text-label-md text-outline">支持 MP4, MOV，最大 500MB</p>
                  </>
                ) : null}
                <input ref={fileInputRef} type="file" accept="video/mp4,video/quicktime" className="hidden" onChange={handleFileSelect} />
              </div>
            </div>
            <div className="lg:col-span-7 flex flex-col justify-between">
              <div className="space-y-6">
                <div>
                  <label className="block text-label-md text-on-surface-variant mb-2">视频标题</label>
                  <input className="form-input text-lg py-3" placeholder="输入标题…" type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} disabled={isProcessing} />
                  <p className="text-body-sm text-outline mt-1 text-right">{title.length} / 60</p>
                </div>
                <div>
                  <label className="block text-label-md text-on-surface-variant mb-2">视频标签</label>
                  <div className="form-input flex flex-wrap gap-2 items-center min-h-[50px]">
                    {tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-1 bg-surface-container-high px-2 py-1 rounded text-on-surface text-body-sm">
                        #{tag}
                        <MaterialIcon icon="close" size="xs" className="cursor-pointer hover:text-error" onClick={() => setTags(tags.filter((t) => t !== tag))} />
                      </span>
                    ))}
                    <input className="bg-transparent border-none outline-none focus:ring-0 p-0 text-body-sm flex-1 min-w-[100px]" placeholder="添加标签…" onKeyDown={addTag} disabled={isProcessing} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-label-md text-on-surface-variant mb-2">可见范围</label>
                    <select className="form-input" value={visibility} onChange={(e) => setVisibility(e.target.value)} disabled={isProcessing}>
                      <option>公开可见</option><option>粉丝可见</option><option>仅自己可见</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-label-md text-on-surface-variant mb-2">定时发布</label>
                    <label className="flex items-center gap-2 cursor-pointer mb-2">
                      <input
                        type="checkbox"
                        className="toggle-checkbox sr-only"
                        checked={useSchedule}
                        onChange={(e) => setUseSchedule(e.target.checked)}
                        disabled={isProcessing}
                      />
                      <span className={`toggle-track relative w-10 ${useSchedule ? 'bg-primary-container' : 'bg-surface-dim'}`}>
                        <span className={`toggle-thumb absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${useSchedule ? 'left-5 border-primary-container' : 'left-0.5 border-outline-variant'}`} />
                      </span>
                      <span className="text-body-sm text-on-surface-variant">{useSchedule ? '已开启' : '关闭'}</span>
                    </label>
                    {useSchedule && (
                      <input className="form-input" type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} disabled={isProcessing} />
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-8 border-t border-outline-variant pt-6">
                {/* Missing condition hints */}
                {!canPublish && missingConditions.length > 0 && (
                  <div className="mb-4 p-3 bg-surface-container rounded-lg border border-outline-variant">
                    <p className="text-label-md text-on-surface-variant mb-2 flex items-center gap-1">
                      <MaterialIcon icon="info" size="sm" className="text-warning" />
                      还需完成以下步骤：
                    </p>
                    <ul className="space-y-1">
                      {missingConditions.map((cond, i) => (
                        <li key={i} className="text-body-sm text-on-surface-variant flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-surface-tint shrink-0" />
                          {cond}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex justify-end gap-4">
                <button className="px-6 py-2 rounded-lg border border-outline-variant bg-surface text-on-surface hover:bg-surface-container transition-colors text-label-md" disabled={isProcessing}>保存草稿</button>
                <button
                  className={cn('px-8 py-2 rounded-lg text-label-md flex items-center gap-2 shadow-sm transition-colors', canPublish && !isProcessing ? 'bg-primary text-on-primary hover:bg-surface-tint' : 'bg-primary/50 text-on-primary/50 cursor-not-allowed')}
                  disabled={!canPublish || isProcessing}
                  onClick={handlePublish}
                >
                  <MaterialIcon icon="send" size="md" fill />
                  {step === 'upload_progress' && '上传中…'}
                  {step === 'upload_error' && '上传失败—重试'}
                  {step === 'submitting' && '提交任务…'}
                  {(step === 'idle' || step === 'done') && `发布至 ${totalSelected} 个目标`}
                </button>
              </div>
              </div>
            </div>
          </div>
        </BentoCard>

        {/* Results */}
        {batchResult && (
          <div className="mt-6 bento-card">
            <div className="flex items-center justify-between mb-stack-md">
              <h3 className="text-headline-md text-on-surface">本次发布结果</h3>
              <button onClick={() => { setBatchResult(null); setTaskIds([]); }} className="btn-ghost"><MaterialIcon icon="close" size="sm" /> 关闭</button>
            </div>
            {/* 执行统计 — 基于轮询状态 */}
            {(() => {
              const statusData = taskStatuses.data ?? [];
              const statusMap = new Map((statusData as TaskStatus[]).map((s: TaskStatus) => [s.taskId, s]));
              const completed = (statusData as TaskStatus[]).filter((s: TaskStatus) => s.status === 'completed').length;
              const running = (statusData as TaskStatus[]).filter((s: TaskStatus) => s.status === 'running').length;
              const queued = (statusData as TaskStatus[]).filter((s: TaskStatus) => s.status === 'queued').length;
              const failCount = (statusData as TaskStatus[]).filter((s: TaskStatus) => s.status === 'failed').length;
              const isPolling = taskIds.length > 0 && !taskStatuses.data;
              return (
                <div className="grid grid-cols-4 gap-4 mb-stack-md">
                  <div className="text-center p-3 rounded bg-surface-container-low"><p className="text-headline-md text-on-surface">{batchResult.total}</p><p className="text-label-md text-on-surface-variant">总任务</p></div>
                  <div className="text-center p-3 rounded bg-blue-50"><p className="text-headline-md text-blue-700">{isPolling ? '…' : completed}</p><p className="text-label-md text-blue-700">已完成</p></div>
                  <div className="text-center p-3 rounded bg-amber-50"><p className="text-headline-md text-amber-700">{isPolling ? '…' : running + queued}</p><p className="text-label-md text-amber-700">{running > 0 ? '执行中' : '排队中'}</p></div>
                  <div className="text-center p-3 rounded bg-red-50"><p className="text-headline-md text-red-700">{isPolling ? '…' : failCount + batchResult.failed}</p><p className="text-label-md text-red-700">失败</p></div>
                </div>
              );
            })()}
            <div className="space-y-3">
              {batchResult.groups.map((g) => (
                <div key={g.windowId} className="border border-outline-variant rounded-md p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <MaterialIcon icon="open_in_new" size="sm" className="text-on-surface-variant" />
                    <span className="font-mono text-body-sm text-on-surface">{g.windowId}</span>
                    <span className="text-label-sm text-on-surface-variant">({g.results.length} 任务, 同组串行)</span>
                  </div>
                  <div className="space-y-1">
                    {g.results.map((r, i) => {
                      const st = r.taskId && ((taskStatuses.data ?? []) as TaskStatus[]).find((s: TaskStatus) => s.taskId === r.taskId);
                      if (!r.success) return (
                        <div key={i} className="flex items-center justify-between text-body-sm">
                          <div className="flex items-center gap-2">
                            <PlatformIcon platform={r.platform} size={24} />
                            <span className="font-mono text-label-sm text-outline">{r.accountId}</span>
                            <span>{r.platform}</span>
                          </div>
                          <StatusPill tone="error" icon="error">{r.error || '入队失败'}</StatusPill>
                        </div>
                      );
                      if (!st) return (
                        <div key={i} className="flex items-center justify-between text-body-sm">
                          <div className="flex items-center gap-2">
                            <PlatformIcon platform={r.platform} size={24} />
                            <span className="font-mono text-label-sm text-outline">{r.accountId}</span>
                            <span>{r.platform}</span>
                          </div>
                          <StatusPill tone="info" icon="schedule">等待状态</StatusPill>
                        </div>
                      );
                      if (st.status === 'completed') return (
                        <div key={i} className="flex items-center justify-between text-body-sm">
                          <div className="flex items-center gap-2">
                            <PlatformIcon platform={r.platform} size={24} />
                            <span className="font-mono text-label-sm text-outline">{r.accountId}</span>
                            <span>{r.platform}</span>
                          </div>
                          <StatusPill tone="success" icon="check">发布成功</StatusPill>
                        </div>
                      );
                      if (st.status === 'failed') return (
                        <div key={i} className="flex items-center justify-between text-body-sm">
                          <div className="flex items-center gap-2">
                            <PlatformIcon platform={r.platform} size={24} />
                            <span className="font-mono text-label-sm text-outline">{r.accountId}</span>
                            <span>{r.platform}</span>
                          </div>
                          <StatusPill tone="error" icon="error">{st.error?.slice(0, 30) || '执行失败'}</StatusPill>
                        </div>
                      );
                      if (st.status === 'running') return (
                        <div key={i} className="flex items-center justify-between text-body-sm">
                          <div className="flex items-center gap-2">
                            <PlatformIcon platform={r.platform} size={24} />
                            <span className="font-mono text-label-sm text-outline">{r.accountId}</span>
                            <span>{r.platform}</span>
                          </div>
                          <StatusPill tone="warning" icon="sync" className="animate-pulse">执行中…</StatusPill>
                        </div>
                      );
                      return (
                        <div key={i} className="flex items-center justify-between text-body-sm">
                          <div className="flex items-center gap-2">
                            <PlatformIcon platform={r.platform} size={24} />
                            <span className="font-mono text-label-sm text-outline">{r.accountId}</span>
                            <span>{r.platform}</span>
                          </div>
                          <StatusPill tone="pending" icon="schedule">排队中</StatusPill>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Tab 3: 数据监控（重新设计）
// ─────────────────────────────────────────────

const MONITOR_PLATFORM_CONFIG: Record<string, { gradient: string; bg: string; text: string; border: string }> = {
  douyin:        { gradient: 'from-[#fe2c55]/20 to-transparent', bg: 'bg-[#fe2c55]/10', text: 'text-[#fe2c55]', border: 'border-l-[#fe2c55]' },
  kuaishou:      { gradient: 'from-[#ff6600]/20 to-transparent', bg: 'bg-[#ff6600]/10', text: 'text-[#ff6600]', border: 'border-l-[#ff6600]' },
  xiaohongshu:   { gradient: 'from-[#ff2442]/20 to-transparent', bg: 'bg-[#ff2442]/10', text: 'text-[#ff2442]', border: 'border-l-[#ff2442]' },
  bilibili:      { gradient: 'from-[#00a1d6]/20 to-transparent', bg: 'bg-[#00a1d6]/10', text: 'text-[#00a1d6]', border: 'border-l-[#00a1d6]' },
  tencent:       { gradient: 'from-[#07c160]/20 to-transparent', bg: 'bg-[#07c160]/10', text: 'text-[#07c160]', border: 'border-l-[#07c160]' },
  baijiahao:     { gradient: 'from-[#2932e1]/20 to-transparent', bg: 'bg-[#2932e1]/10', text: 'text-[#2932e1]', border: 'border-l-[#2932e1]' },
  tiktok:        { gradient: 'from-[#69c9d0]/20 to-transparent', bg: 'bg-[#69c9d0]/10', text: 'text-[#69c9d0]', border: 'border-l-[#69c9d0]' },
};
const MONITOR_PLATFORM_FALLBACK = { gradient: 'from-primary/15 to-transparent', bg: 'bg-primary/10', text: 'text-primary', border: 'border-l-primary' };

type MonitorToast = { id: number; message: string; type: 'success' | 'error' | 'info' };

function useMonitorToast() {
  const [toasts, setToasts] = useState<MonitorToast[]>([]);
  const addToast = useCallback((message: string, type: MonitorToast['type'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  return { toasts, addToast, dismiss };
}

function MonitorTab() {
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [monitorTaskIds, setMonitorTaskIds] = useState<string[]>([]);
  const [showQueue, setShowQueue] = useState(false);
  const { toasts, addToast, dismiss } = useMonitorToast();

  const { data: accountsData, isLoading: accountsLoading, refetch: refetchAccounts } = useMonitorAccounts();
  const { data: newCommentsData, refetch: refetchNewComments } = useNewCommentsOverview();
  const { data: detailData, isLoading: detailLoading, refetch: refetchDetail } = useMonitorAccountDetail(
    viewMode === 'detail' ? selectedAccountId : null,
  );
  const { data: taskStatusesData } = useMonitorTaskStatuses(monitorTaskIds);
  const { data: schedulerData } = useSchedulerStatus();

  const triggerMonitor = useTriggerMonitor();
  const { data: videoCommentsData } = useVideoComments(selectedVideoId || '');
  const markAllRead = useMarkAllCommentsRead();
  const triggerAllMonitor = useTriggerAllMonitor();
  const toggleMonitor = useToggleMonitor();

  const accounts: MonitorAccount[] = useMemo(() => {
    if (Array.isArray(accountsData)) return accountsData;
    return [];
  }, [accountsData]);

  const newCommentVideos: NewCommentVideo[] = useMemo(() => {
    if (Array.isArray(newCommentsData)) return newCommentsData;
    return [];
  }, [newCommentsData]);

  const detail: MonitorAccountDetail | null = useMemo(() => {
    return detailData || null;
  }, [detailData]);

  const stats = useMemo(() => {
    const total = accounts.length;
    const active = accounts.filter((a) => a.monitoringEnabled && a.status !== 'blocked').length;
    const newCmts = accounts.reduce((s, a) => s + a.newComments, 0);
    const totalVideos = accounts.reduce((s, a) => s + a.videoCount, 0);
    return { total, active, newCmts, totalVideos };
  }, [accounts]);

  // 倒计时状态 — 后端驱动，前端本地插值
  const [countdown, setCountdown] = useState('');
  const [nextRunAt, setNextRunAt] = useState(0);
  const [intervalMin, setIntervalMin] = useState(0);

  // 从后端同步下次执行时间
  useEffect(() => {
    if (!schedulerData) return;
    setNextRunAt(schedulerData.nextRunAt);
    setIntervalMin(Math.round(schedulerData.intervalMs / 60000));
  }, [schedulerData]);

  // 本地倒计时插值（每秒更新）
  useEffect(() => {
    if (nextRunAt <= 0) return;

    const updateCountdown = () => {
      const remaining = Math.max(0, nextRunAt - Date.now());
      if (remaining <= 0) {
        setCountdown('即将执行');
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      if (mins > 0) {
        setCountdown(`${mins}分${secs.toString().padStart(2, '0')}秒`);
      } else {
        setCountdown(`${secs}秒`);
      }
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [nextRunAt]);

  const handleEnterDetail = (accountId: number) => {
    setSelectedAccountId(accountId);
    setViewMode('detail');
  };

  const handleBack = () => {
    setViewMode('list');
    setSelectedAccountId(null);
  };

  const handleTrigger = async (userId: number) => {
    try {
      const result = await triggerMonitor.mutateAsync(userId);
      const jobId = result?.jobId;
      if (jobId) {
        setMonitorTaskIds((prev) => [...prev, jobId]);
        setShowQueue(true);
      }
      addToast('监控任务已加入队列，稍后将自动执行', 'success');
    } catch (e: any) {
      addToast(e?.response?.data?.error || '触发监控失败', 'error');
    }
  };

  const handleToggle = async (userId: number, currentEnabled: boolean) => {
    try {
      await toggleMonitor.mutateAsync({ userId, enabled: !currentEnabled });
      addToast(!currentEnabled ? '已恢复监控' : '已暂停监控', !currentEnabled ? 'success' : 'info');
    } catch (e: any) {
      addToast(e?.response?.data?.error || '操作失败', 'error');
    }
  };

  const handleTriggerAll = async () => {
    try {
      const result = await triggerAllMonitor.mutateAsync();
      const jobIds = result?.jobIds || [];
      if (jobIds.length > 0) {
        setMonitorTaskIds((prev) => [...prev, ...jobIds]);
        setShowQueue(true);
      }
      addToast(result?.message || `已为 ${result?.total || 0} 个用户创建监控任务`, 'success');
    } catch (e: any) {
      addToast(e?.response?.data?.error || '统一触发监控失败', 'error');
    }
  };

  // ── Toast Layer ──
  const toastLayer = (
    <div className="fixed top-20 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-md min-w-[300px] max-w-[420px] animate-in fade-in slide-in-from-right-4 duration-300',
            toast.type === 'success' && 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
            toast.type === 'error' && 'bg-red-500/15 border-red-500/30 text-red-400',
            toast.type === 'info' && 'bg-primary/15 border-primary/30 text-primary',
          )}
        >
          <MaterialIcon
            icon={toast.type === 'success' ? 'check_circle' : toast.type === 'error' ? 'error' : 'info'}
            size="sm"
          />
          <span className="text-label-md flex-1">{toast.message}</span>
          <button onClick={() => dismiss(toast.id)} className="opacity-60 hover:opacity-100 transition-opacity">
            <MaterialIcon icon="close" size="xs" />
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] relative">
      {toastLayer}

      {viewMode === 'list' ? (
        /* ═══════════════════════════════════════════
           MAIN OVERVIEW
           ═══════════════════════════════════════════ */
        <div className="flex-1 overflow-y-auto px-4 pb-8">
          {/* ── Stats Bar + Countdown + Unified Trigger ── */}
          <div className="mb-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              {[
                { label: '监控用户', value: stats.total, icon: 'people', accent: 'text-primary' },
                { label: '运行中', value: stats.active, icon: 'monitoring', accent: 'text-emerald-500' },
                { label: '新评论', value: stats.newCmts, icon: 'priority_high', accent: 'text-amber-500' },
                { label: '监控视频', value: stats.totalVideos, icon: 'videocam', accent: 'text-blue-500' },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="bg-surface border border-outline-variant rounded-xl p-4 flex items-center gap-3 hover:border-primary/30 transition-colors"
                >
                  <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center bg-surface-container', stat.accent)}>
                    <MaterialIcon icon={stat.icon as any} size="md" />
                  </div>
                  <div>
                    <p className="text-headline-sm text-on-surface font-bold tabular-nums">{stat.value}</p>
                    <p className="text-label-sm text-on-surface-variant">{stat.label}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Countdown + Unified Trigger */}
            <div className="flex items-center gap-3">
              {/* 下次检查倒计时 */}
              <div className="flex-1 bg-surface border border-outline-variant rounded-xl px-4 py-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-surface-container text-indigo-500">
                  <MaterialIcon icon="schedule" size="md" />
                </div>
                  <div className="flex-1">
                    <p className="text-label-sm text-on-surface-variant">下次自动检查</p>
                    <p className="text-headline-sm text-on-surface font-bold tabular-nums">
                      {(() => {
                        // 检查是否有任务正在执行
                        const statusData = (taskStatusesData ?? []) as MonitorTaskStatus[];
                        const hasRunningTasks = statusData.some((s) => s.status === 'running' || s.status === 'queued');
                        if (hasRunningTasks) {
                          return '执行中…';
                        }
                        return nextRunAt > 0 ? (countdown || '即将执行') : '等待调度器…';
                      })()}
                    </p>
                  </div>
                  {nextRunAt > 0 && (
                    <div className="text-right">
                      <p className="text-[10px] text-on-surface-variant">
                        间隔 {intervalMin} 分钟
                      </p>
                      {schedulerData && schedulerData.lastRunAt > 0 && (
                        <p className="text-[10px] text-outline">
                          上次 {formatRelativeTime(new Date(schedulerData.lastRunAt).toISOString())}
                        </p>
                      )}
                    </div>
                  )}
              </div>

              {/* 统一立即更新按钮 */}
              <button
                onClick={handleTriggerAll}
                disabled={triggerAllMonitor.isPending || stats.active === 0}
                className={cn(
                  'flex items-center gap-2 px-5 py-3 rounded-xl text-label-lg font-medium shadow-sm transition-all',
                  'bg-primary text-on-primary hover:shadow-md active:scale-[0.98]',
                  'disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100',
                )}
              >
                <MaterialIcon
                  icon={triggerAllMonitor.isPending ? 'pending' : 'sync'}
                  size="sm"
                  className={triggerAllMonitor.isPending ? 'animate-spin' : ''}
                />
                {triggerAllMonitor.isPending ? '创建任务中…' : '立即更新全部'}
              </button>
            </div>
          </div>

          {/* ── Update Queue ── */}
          {showQueue && monitorTaskIds.length > 0 && (() => {
            const statusData = (taskStatusesData ?? []) as MonitorTaskStatus[];
            const completed = statusData.filter((s) => s.status === 'completed').length;
            const running = statusData.filter((s) => s.status === 'running').length;
            const queued = statusData.filter((s) => s.status === 'queued').length;
            const failed = statusData.filter((s) => s.status === 'failed').length;
            const isPolling = monitorTaskIds.length > 0 && statusData.length === 0;
            const allDone = statusData.length > 0 && statusData.every(
              (s) => s.status === 'completed' || s.status === 'failed',
            );

            return (
              <div className="mb-6 bg-surface border border-outline-variant rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant bg-surface-container">
                  <div className="flex items-center gap-2">
                    <MaterialIcon icon="sync" size="sm" className="text-primary" />
                    <h3 className="text-label-lg text-on-surface font-semibold">更新队列</h3>
                    <span className="text-label-sm text-on-surface-variant">({monitorTaskIds.length} 任务)</span>
                    {!allDone && (
                      <span className="flex items-center gap-1 ml-2">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                        </span>
                        <span className="text-[10px] text-primary font-medium">执行中</span>
                      </span>
                    )}
                    {allDone && (
                      <span className="flex items-center gap-1 ml-2 text-[10px] text-emerald-500 font-medium">
                        <MaterialIcon icon="check_circle" size="xs" />
                        全部完成
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => { setShowQueue(false); setMonitorTaskIds([]); }}
                    className="text-label-sm text-on-surface-variant hover:text-on-surface flex items-center gap-1"
                  >
                    <MaterialIcon icon="close" size="xs" />
                    关闭
                  </button>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-4 gap-3 p-3">
                  <div className="text-center p-2 rounded-lg bg-surface-container-low">
                    <p className="text-headline-sm text-on-surface font-bold">{monitorTaskIds.length}</p>
                    <p className="text-label-sm text-on-surface-variant">总任务</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-blue-50">
                    <p className="text-headline-sm text-blue-700 font-bold">{isPolling ? '…' : completed}</p>
                    <p className="text-label-sm text-blue-700">已完成</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-amber-50">
                    <p className="text-headline-sm text-amber-700 font-bold">{isPolling ? '…' : running + queued}</p>
                    <p className="text-label-sm text-amber-700">{running > 0 ? '执行中' : '排队中'}</p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-red-50">
                    <p className="text-headline-sm text-red-700 font-bold">{isPolling ? '…' : failed}</p>
                    <p className="text-label-sm text-red-700">失败</p>
                  </div>
                </div>

                {/* Task list */}
                {statusData.length > 0 && (
                  <div className="px-3 pb-3 space-y-1.5">
                    {statusData.map((task) => {
                      const platformConfig = MONITOR_PLATFORM_CONFIG[task.platform] || MONITOR_PLATFORM_FALLBACK;
                      const account = accounts.find((a) => a.id === task.userId);
                      return (
                        <div
                          key={task.taskId}
                          className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-container-lowest border border-outline-variant/50"
                        >
                          <div className="flex items-center gap-2.5">
                            <div className={cn('w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold', platformConfig.bg, platformConfig.text)}>
                              {(account?.platformName || task.platform).charAt(0)}
                            </div>
                            <div>
                              <p className="text-label-md text-on-surface font-medium">
                                {account?.platformName || task.platform}
                              </p>
                              <p className="text-[10px] text-on-surface-variant font-mono">
                                {task.taskId.slice(0, 20)}…
                              </p>
                            </div>
                          </div>
                          <div>
                            {task.status === 'completed' && (
                              <StatusPill tone="success" icon="check_circle">完成</StatusPill>
                            )}
                            {task.status === 'running' && (
                              <StatusPill tone="warning" icon="sync" className="animate-pulse">执行中…</StatusPill>
                            )}
                            {task.status === 'queued' && (
                              <StatusPill tone="pending" icon="schedule">排队中</StatusPill>
                            )}
                            {task.status === 'failed' && (
                              <StatusPill tone="error" icon="error">{task.error?.slice(0, 20) || '失败'}</StatusPill>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── Account Cards ── */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-title-lg text-on-surface font-bold flex items-center gap-2">
                <MaterialIcon icon="people" size="md" className="text-primary" />
                监控用户
              </h2>
              <button
                onClick={() => { refetchAccounts(); refetchNewComments(); }}
                className="text-label-md text-primary flex items-center gap-1 hover:underline"
              >
                <MaterialIcon icon="refresh" size="xs" />
                刷新
              </button>
            </div>

            {accountsLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-40 rounded-xl border border-outline-variant animate-pulse bg-surface-container" />
                ))}
              </div>
            ) : accounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-on-surface-variant">
                <MaterialIcon icon="person" size="3xl" className="text-outline mb-4 opacity-30" />
                <p className="text-title-md font-medium mb-1">暂无监控用户</p>
                <p className="text-body-sm">请先在「用户管理」中添加监控对象</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {accounts.map((account) => {
                  const pc = MONITOR_PLATFORM_CONFIG[account.platform] || MONITOR_PLATFORM_FALLBACK;
                  const isBlocked = account.status === 'blocked';
                  const isCooldown = account.cooldownUntil > Date.now();
                  const isActive = account.monitoringEnabled && !isBlocked;

                  return (
                    <div
                      key={account.id}
                      className={cn(
                        'group relative bg-surface border border-outline-variant rounded-xl overflow-hidden cursor-pointer',
                        'hover:border-primary/40 hover:shadow-lg transition-all duration-200',
                        `border-l-3 ${pc.border}`,
                      )}
                      onClick={() => handleEnterDetail(account.id)}
                    >
                      {/* Platform gradient accent */}
                      <div className={cn('absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none', pc.gradient)} />

                      <div className="relative p-4">
                        {/* Header: platform + status */}
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className={cn('w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm', pc.bg, pc.text)}>
                              {account.platformName.charAt(0)}
                            </div>
                            <div>
                              <h3 className="text-label-lg text-on-surface font-semibold">{account.platformName}</h3>
                              <p className="text-label-sm text-on-surface-variant font-mono text-[11px]">
                                {account.fingerprintWindowId}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {isActive && (
                              <span className="flex items-center gap-1.5">
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                                </span>
                                <span className="text-[10px] text-emerald-500 font-medium">运行中</span>
                              </span>
                            )}
                            {isBlocked && (
                              <span className="text-[10px] text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full font-medium">已封禁</span>
                            )}
                            {isCooldown && !isBlocked && (
                              <span className="text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full font-medium">冷却中</span>
                            )}
                            {!account.monitoringEnabled && (
                              <span className="text-[10px] text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full font-medium">已暂停</span>
                            )}
                          </div>
                        </div>

                        {/* Stats row */}
                        <div className="flex items-center gap-5 mb-3">
                          <div>
                            <p className="text-headline-sm text-on-surface font-bold tabular-nums">{account.videoCount}</p>
                            <p className="text-[10px] text-on-surface-variant">视频</p>
                          </div>
                          <div>
                            <p className="text-headline-sm text-on-surface font-bold tabular-nums">{account.totalComments}</p>
                            <p className="text-[10px] text-on-surface-variant">总评论</p>
                          </div>
                          <div>
                            <p className={cn('text-headline-sm font-bold tabular-nums', account.newComments > 0 ? 'text-amber-500' : 'text-on-surface-variant')}>
                              {account.newComments}
                            </p>
                            <p className="text-[10px] text-on-surface-variant">新评论</p>
                          </div>
                          <div className="ml-auto text-right">
                            <p className="text-[11px] text-on-surface-variant">
                              {account.lastCheckTime ? formatRelativeTime(account.lastCheckTime) : '未检测'}
                            </p>
                            <p className="text-[10px] text-outline">上次检查</p>
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleTrigger(account.id)}
                            disabled={triggerMonitor.isPending || !account.monitoringEnabled || isBlocked}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-label-md font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <MaterialIcon icon="sync" size="xs" />
                            立即更新
                          </button>
                          <button
                            onClick={() => handleToggle(account.id, account.monitoringEnabled)}
                            disabled={toggleMonitor.isPending}
                            className={cn(
                              'flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-label-md font-medium transition-colors disabled:opacity-30',
                              account.monitoringEnabled
                                ? 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                                : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20',
                            )}
                          >
                            <MaterialIcon icon={account.monitoringEnabled ? 'pause' : 'play_arrow'} size="xs" />
                            {account.monitoringEnabled ? '暂停' : '恢复'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── New Comments Section ── */}
          <div>
            <h2 className="text-title-lg text-on-surface font-bold flex items-center gap-2 mb-4">
              <MaterialIcon icon="priority_high" size="md" className="text-amber-500" />
              新评论动态
              {newCommentVideos.length > 0 && (
                <span className="ml-1 min-w-[22px] h-[22px] flex items-center justify-center rounded-full bg-amber-500 text-white text-[11px] font-bold">
                  {newCommentVideos.length}
                </span>
              )}
            </h2>

            {newCommentVideos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant bg-surface border border-outline-variant rounded-xl">
                <MaterialIcon icon="graphic_eq" size="2xl" className="text-outline mb-3 opacity-30" />
                <p className="text-body-md font-medium">暂无新评论</p>
                <p className="text-body-sm mt-1">当监控到新评论时将在此处展示</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {newCommentVideos.map((video) => {
                  const pc = MONITOR_PLATFORM_CONFIG[video.platform] || MONITOR_PLATFORM_FALLBACK;
                  return (
                    <div
                      key={video.id}
                      className={cn(
                        'flex items-center gap-4 p-4 bg-surface border border-outline-variant rounded-xl',
                        'hover:border-primary/30 hover:shadow-md transition-all cursor-pointer',
                        `border-l-3 ${pc.border}`,
                      )}
                      onClick={() => {
                        const isSame = selectedVideoId === video.id;
                        setSelectedVideoId(isSame ? null : video.id);
                        if (!isSame) markAllRead.mutate({ videoId: video.id } as any);
                      }}
                    >
                      <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center shrink-0', pc.bg, pc.text)}>
                        <MaterialIcon icon="movie" size="md" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-label-md text-on-surface truncate font-medium">{video.description || '无标题视频'}</p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className={cn('text-[11px] font-medium px-1.5 py-0.5 rounded', pc.bg, pc.text)}>
                            {video.platformName}
                          </span>
                          <span className="text-[11px] text-on-surface-variant">
                            共 {video.totalComments} 条评论
                          </span>
                          <span className="text-[11px] text-outline">
                            更新于 {formatRelativeTime(video.updatedAt)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="min-w-[28px] h-7 flex items-center justify-center rounded-full bg-amber-500/15 text-amber-500 text-label-md font-bold">
                          +{video.newCommentCount}
                        </span>
                        <MaterialIcon icon="chevron_right" size="sm" className="text-outline" />
                      </div>
                    </div>
                  );
                    {selectedVideoId === video.id && (
                      <div className="ml-2 border-l-2 border-primary/20 pl-3 pb-1">
                        {videoCommentsData?.data ? (
                          videoCommentsData.data.length === 0 ? (
                            <p className="text-body-sm text-on-surface-variant py-2">暂无评论</p>
                          ) : (
                            <div className="flex flex-col gap-2 pt-2">
                              {videoCommentsData.data.map((root: any) => (
                                <div key={root.cid} className="bg-surface-variant/50 rounded-lg p-2.5 border-l-2 border-amber-500/40">
                                  <div className="flex items-start gap-1.5">
                                    <span className="text-label-xs font-medium text-on-surface">{root.userNickname || '匿名'}</span>
                                    {root.isNew && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0 mt-1" />}
                                  </div>
                                  <p className="text-body-sm text-on-surface mt-0.5 leading-relaxed">{root.text}</p>
                                  <span className="text-[10px] text-on-surface-variant/60">{formatRelativeTime(root.createTime)}</span>
                                  {root.replies?.length > 0 && (
                                    <div className="ml-3 mt-1.5 border-l border-outline-variant pl-2.5 flex flex-col gap-1.5">
                                      {root.replies.map((sub: any) => (
                                        <div key={sub.cid} className="py-0.5">
                                          <div className="flex items-start gap-1.5">
                                            <span className="text-label-xs font-medium text-on-surface">{sub.userNickname || '匿名'}</span>
                                            {sub.isNew && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0 mt-1" />}
                                            {sub.replyToName && <span className="text-[10px] text-primary/70">@ {sub.replyToName}</span>}
                                          </div>
                                          <p className="text-body-sm text-on-surface-variant/80 mt-0.5">{sub.text}</p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )
                        ) : (
                          <p className="text-body-sm text-on-surface-variant py-2">加载中...</p>
                        )}
                      </div>
                    )}
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ═══════════════════════════════════════════
           DETAIL VIEW
           ═══════════════════════════════════════════ */
        <div className="flex-1 overflow-y-auto px-4 pb-8">
          {/* Breadcrumb */}
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 text-label-md text-primary hover:underline mb-4 mt-1"
          >
            <MaterialIcon icon="arrow_back" size="sm" />
            返回监控概览
          </button>

          {detailLoading || !detail ? (
            <div className="space-y-4">
              <div className="h-24 rounded-xl bg-surface-container animate-pulse" />
              <div className="h-64 rounded-xl bg-surface-container animate-pulse" />
            </div>
          ) : (
            <>
              {/* ── User Header ── */}
              {(() => {
                const pc = MONITOR_PLATFORM_CONFIG[detail.platform] || MONITOR_PLATFORM_FALLBACK;
                const isBlocked = detail.status === 'blocked';
                const isActive = detail.monitoringEnabled && !isBlocked;

                return (
                  <div className={cn('relative bg-surface border border-outline-variant rounded-xl overflow-hidden mb-6 border-l-3', pc.border)}>
                    <div className={cn('absolute inset-0 bg-gradient-to-r opacity-50', pc.gradient)} />
                    <div className="relative p-5">
                      <div className="flex items-center justify-between flex-wrap gap-4">
                        <div className="flex items-center gap-4">
                          <div className={cn('w-14 h-14 rounded-full flex items-center justify-center font-bold text-xl', pc.bg, pc.text)}>
                            {detail.platformName.charAt(0)}
                          </div>
                          <div>
                            <h2 className="text-title-lg text-on-surface font-bold">{detail.platformName}</h2>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-label-sm text-on-surface-variant font-mono">
                                {detail.fingerprintWindowId}
                              </span>
                              {isActive && (
                                <span className="flex items-center gap-1.5">
                                  <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                                  </span>
                                  <span className="text-[11px] text-emerald-500 font-medium">监控中</span>
                                </span>
                              )}
                              {isBlocked && (
                                <span className="text-[11px] text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">已封禁</span>
                              )}
                              {!detail.monitoringEnabled && (
                                <span className="text-[11px] text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full">已暂停</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => handleTrigger(detail.id)}
                            disabled={triggerMonitor.isPending || !detail.monitoringEnabled || isBlocked}
                            className="btn-primary flex items-center gap-2 disabled:opacity-30"
                          >
                            <MaterialIcon icon={triggerMonitor.isPending ? 'pending' : 'sync'} size="sm" />
                            {triggerMonitor.isPending ? '排队中…' : '立即更新评论'}
                          </button>
                          <button
                            onClick={() => handleToggle(detail.id, detail.monitoringEnabled)}
                            disabled={toggleMonitor.isPending}
                            className={cn(
                              'flex items-center gap-2 px-4 py-2 rounded-lg text-label-md font-medium border transition-colors disabled:opacity-30',
                              detail.monitoringEnabled
                                ? 'border-outline-variant text-on-surface-variant hover:bg-surface-container'
                                : 'border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/10',
                            )}
                          >
                            <MaterialIcon icon={detail.monitoringEnabled ? 'pause' : 'play_arrow'} size="sm" />
                            {detail.monitoringEnabled ? '暂停监控' : '恢复监控'}
                          </button>
                        </div>
                      </div>

                      {/* Detail stats */}
                      <div className="flex items-center gap-8 mt-5 pt-4 border-t border-outline-variant/50">
                        <div>
                          <p className="text-headline-sm text-on-surface font-bold tabular-nums">{detail.videos.length}</p>
                          <p className="text-[11px] text-on-surface-variant">监控视频</p>
                        </div>
                        <div>
                          <p className="text-headline-sm text-on-surface font-bold tabular-nums">
                            {detail.videos.reduce((s, v) => s + v.commentCount, 0)}
                          </p>
                          <p className="text-[11px] text-on-surface-variant">总评论数</p>
                        </div>
                        <div>
                          <p className={cn(
                            'text-headline-sm font-bold tabular-nums',
                            detail.videos.some((v) => v.newCommentCount > 0) ? 'text-amber-500' : 'text-on-surface-variant',
                          )}>
                            {detail.videos.reduce((s, v) => s + v.newCommentCount, 0)}
                          </p>
                          <p className="text-[11px] text-on-surface-variant">新评论</p>
                        </div>
                        <div className="ml-auto text-right">
                          <p className="text-label-sm text-on-surface-variant">
                            {detail.lastCheckTime ? formatRelativeTime(detail.lastCheckTime) : '尚未检测'}
                          </p>
                          <p className="text-[11px] text-outline">最近一次检查</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ── Videos List ── */}
              <div>
                <h3 className="text-title-md text-on-surface font-bold flex items-center gap-2 mb-4">
                  <MaterialIcon icon="movie" size="md" className="text-primary" />
                  监控视频列表
                  <span className="text-label-sm text-on-surface-variant font-normal ml-1">
                    ({detail.videos.length})
                  </span>
                </h3>

                {detail.videos.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-on-surface-variant bg-surface border border-outline-variant rounded-xl">
                    <MaterialIcon icon="videocam" size="3xl" className="text-outline mb-3 opacity-30" />
                    <p className="text-body-md font-medium">暂无监控视频</p>
                    <p className="text-body-sm mt-1">触发「立即更新」后将获取视频列表</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {detail.videos.map((video) => {
                      const pc = MONITOR_PLATFORM_CONFIG[detail.platform] || MONITOR_PLATFORM_FALLBACK;
                      const hasNew = video.newCommentCount > 0;

                      return (
                        <div
                          key={video.id}
                          className={cn(
                            'bg-surface border border-outline-variant rounded-xl p-4 hover:shadow-md transition-all cursor-pointer',
                            hasNew && 'border-amber-500/30 bg-amber-500/[0.03]',
                            `border-l-3 ${pc.border}`,
                          )}
                            onClick={() => {
                              const isSame = selectedVideoId === video.id;
                              setSelectedVideoId(isSame ? null : video.id);
                              if (!isSame) markAllRead.mutate({ videoId: video.id } as any);
                            }}
                        >
                          <div className="flex items-start gap-4">
                            {/* Video thumbnail placeholder */}
                            <div className="w-20 h-20 rounded-lg bg-surface-container flex items-center justify-center shrink-0 overflow-hidden relative">
                              <MaterialIcon icon="play_circle" size="xl" className="text-outline/30" />
                              {hasNew && (
                                <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center">
                                  <span className="text-[9px] text-white font-bold">新</span>
                                </div>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <h4 className="text-label-lg text-on-surface font-medium line-clamp-2 leading-snug">
                                {video.description || '无标题视频'}
                              </h4>
                              <div className="flex items-center gap-4 mt-2 flex-wrap">
                                <span className="flex items-center gap-1 text-label-sm text-on-surface-variant">
                                  <MaterialIcon icon="message" size="xs" />
                                  {video.commentCount} 条评论
                                </span>
                                {hasNew && (
                                  <span className="flex items-center gap-1 text-label-sm text-amber-500 font-medium">
                                    <MaterialIcon icon="auto_awesome" size="xs" />
                                    +{video.newCommentCount} 条新评论
                                  </span>
                                )}
                                {video.metrics?.viewCount != null && (
                                  <span className="flex items-center gap-1 text-label-sm text-on-surface-variant">
                                    <MaterialIcon icon="visibility" size="xs" />
                                    {formatNumber(video.metrics.viewCount)} 播放
                                  </span>
                                )}
                                {video.metrics?.likeCount != null && (
                                  <span className="flex items-center gap-1 text-label-sm text-on-surface-variant">
                                    <MaterialIcon icon="thumb_up" size="xs" />
                                    {formatNumber(video.metrics.likeCount)} 点赞
                                  </span>
                                )}
                                <span className="text-[11px] text-outline">
                                  更新于 {formatRelativeTime(video.updatedAt)}
                                </span>
                              </div>
                            </div>

                            <button
                              onClick={() => handleTrigger(detail.id)}
                              disabled={triggerMonitor.isPending || !detail.monitoringEnabled || detail.status === 'blocked'}
                              className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg text-label-md text-primary bg-primary/10 hover:bg-primary/20 transition-colors disabled:opacity-30"
                              title="更新此用户的评论"
                            >
                              <MaterialIcon icon="refresh" size="xs" />
                              更新
                            </button>
                          </div>
                        </div>
                      );
                      {selectedVideoId === video.id && (
                        <div className="ml-4 border-l-2 border-primary/30 pl-3 pb-2 mt-2">
                          {videoCommentsData?.data ? (
                            videoCommentsData.data.length === 0 ? (
                              <p className="text-body-sm text-on-surface-variant py-2">暂无评论</p>
                            ) : (
                              <div className="flex flex-col gap-2 pt-1">
                                {videoCommentsData.data.map((root: any) => (
                                  <div key={root.cid} className="bg-surface-variant/50 rounded-lg p-2.5 border-l-2 border-amber-500/40">
                                    <div className="flex items-start gap-1.5">
                                      <span className="text-label-xs font-medium text-on-surface">{root.userNickname || '匿名'}</span>
                                      {root.isNew && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0 mt-1" />}
                                    </div>
                                    <p className="text-body-sm text-on-surface mt-0.5 leading-relaxed">{root.text}</p>
                                    {root.replies?.length > 0 && (
                                      <div className="ml-3 mt-1.5 border-l border-outline-variant pl-2.5 flex flex-col gap-1.5">
                                        {root.replies.map((sub: any) => (
                                          <div key={sub.cid} className="py-0.5">
                                            <div className="flex items-start gap-1.5">
                                              <span className="text-label-xs font-medium text-on-surface">{sub.userNickname || '匿名'}</span>
                                              {sub.isNew && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0 mt-1" />}
                                              {sub.replyToName && <span className="text-[10px] text-primary/70">@ {sub.replyToName}</span>}
                                            </div>
                                            <p className="text-body-sm text-on-surface-variant/80 mt-0.5">{sub.text}</p>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )
                          ) : (
                            <p className="text-body-sm text-on-surface-variant py-2">加载中...</p>
                          )}
                        </div>
                      )}
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Mobile fallback */}
      <div className="lg:hidden flex-1 flex flex-col items-center justify-center text-on-surface-variant py-12">
        <MaterialIcon icon="apps" size="3xl" className="text-outline mb-3 opacity-40" />
        <p className="text-body-md font-medium">请使用桌面端查看监控面板</p>
        <p className="text-body-sm text-on-surface-variant mt-1">矩阵监控页面需要更大的屏幕空间</p>
      </div>
    </div>
  );
}
