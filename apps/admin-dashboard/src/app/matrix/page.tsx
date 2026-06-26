'use client';

import { useState, useRef, useMemo, useCallback, useEffect, type KeyboardEvent } from 'react';
import api from '@/lib/api';
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
  useClearUserData,
  useEnableAllUsers,
  useRestoreAllPlatforms,
  useClearAllUserData,
  useDebugMode,
  useUpdateDebugMode,
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
  useGenerateAiReply,
  useRegenerateAiReply,
  useAcceptAiReply,
  useUpdateSkipPinnedVideos,
} from '@/hooks/useApi';
import { MaterialIcon, PlatformIcon, Avatar, type MaterialIconName } from '@/components/ui/MaterialIcon';
import { BentoCard } from '@/components/ui/Bento';
import { StatusPill, ToggleSwitch } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';
import OperatorManagement from '@/components/matrix/OperatorManagement';
import AiReplyCard from '@/components/matrix/AiReplyCard';
import QueueBar from '@/components/matrix/QueueBar';
import QueueTab from '@/components/matrix/QueueTab';

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
  suggestedReply?: string | null;
  suggestionStatus?: string;
  suggestionModel?: string | null;
  suggestionLatencyMs?: number | null;
  replyStatus?: string;
};

// ─────────────────────────────────────────────
//  Main Page Component
// ─────────────────────────────────────────────

export default function MatrixPage() {
  const [activeTab, setActiveTab] = useState<'users' | 'publish' | 'monitor' | 'queue'>('users');

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
          <button
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all',
              activeTab === 'queue'
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
            )}
            onClick={() => setActiveTab('queue')}
          >
            <MaterialIcon icon={'list' as MaterialIconName} size="sm" />
            执行队列
          </button>
        </div>
      </div>

      {/* 常驻执行队列简略条 */}
      <QueueBar onClickViewAll={() => setActiveTab('queue')} />

      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'publish' && <PublishTab />}
      {activeTab === 'monitor' && <MonitorTab />}
      {activeTab === 'queue' && <QueueTab />}
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
  const [commentTab, setCommentTab] = useState<'comments' | 'notifications'>('comments');
  const [monitorTaskIds, setMonitorTaskIds] = useState<string[]>([]);
  const [showQueue, setShowQueue] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [showPinnedSettings, setShowPinnedSettings] = useState<number | null>(null);
  const [pinnedSettings, setPinnedSettings] = useState<Record<string, boolean>>({});
  const { toasts, addToast, dismiss } = useMonitorToast();

  // ── Crawl Config ──
  const [crawlConfig, setCrawlConfig] = useState({
    mode: 'simple',
    maxRootComments: 30,
  });

  useEffect(() => {
    fetch('/api/v1/matrix/crawl-settings')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setCrawlConfig(data.data);
        }
      });
  }, []);

  const saveConfig = async () => {
    await fetch('/api/v1/matrix/crawl-settings/douyin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: crawlConfig.mode,
        config: { max_root_comments: crawlConfig.maxRootComments },
      }),
    });
  };

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
  const clearUserData = useClearUserData();
  const enableAllUsers = useEnableAllUsers();
  const restoreAllPlatforms = useRestoreAllPlatforms();
  const clearAllUserData = useClearAllUserData();

  const [showClearConfirm, setShowClearConfirm] = useState<number | null>(null);
  const [clearCountdown, setClearCountdown] = useState(0);
  const { data: debugModeData } = useDebugMode();
  const updateDebugMode = useUpdateDebugMode();
  const isDebugMode = debugModeData?.enabled ?? false;
  const updateSkipPinned = useUpdateSkipPinnedVideos();

  const savePinnedSettings = async () => {
    if (showPinnedSettings === null) return;
    try {
      await updateSkipPinned.mutateAsync({
        userId: showPinnedSettings,
        skipPinnedVideos: pinnedSettings,
      });
      addToast('置顶视频设置已保存', 'success');
      setShowPinnedSettings(null);
    } catch (e: any) {
      addToast(e?.response?.data?.error || '保存置顶视频设置失败', 'error');
    }
  };

  const accounts: MonitorAccount[] = useMemo(() => {
    if (Array.isArray(accountsData)) return accountsData;
    return [];
  }, [accountsData]);

  // 可用平台列表（去重）
  const availablePlatforms = useMemo(() => {
    const platforms = new Set(accounts.map((a) => a.platform));
    return Array.from(platforms).sort();
  }, [accounts]);

  // 按平台筛选后的账号列表
  const filteredAccounts = useMemo(() => {
    if (platformFilter === 'all') return accounts;
    return accounts.filter((a) => a.platform === platformFilter);
  }, [accounts, platformFilter]);

  // 按窗口分组（按 operatorId + windowId）
  const groupedByUser = useMemo(() => {
    const groups = new Map<string, {
      operatorId: number | null;
      operatorName: string;
      windowId: string;
      windowName: string;
      wechatUserId: string;
      accounts: MonitorAccount[]
    }>();
    for (const account of filteredAccounts) {
      const groupKey = `op_${account.operatorId || 'none'}_win_${account.windowId}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          operatorId: account.operatorId,
          operatorName: account.operatorName || '未知用户',
          windowId: account.windowId,
          windowName: account.windowName || String(account.windowId),
          wechatUserId: account.wechatUserId,
          accounts: [],
        });
      }
      groups.get(groupKey)!.accounts.push(account);
    }
    // 排序：同操作员窗口相邻，按 operatorName → windowName 排序
    return Array.from(groups.values()).sort((a, b) => {
      const opA = a.operatorName || '';
      const opB = b.operatorName || '';
      if (opA !== opB) return opA.localeCompare(opB, 'zh-CN');
      const winA = a.windowName || '';
      const winB = b.windowName || '';
      return winA.localeCompare(winB, 'zh-CN');
    });
  }, [filteredAccounts]);

  const newCommentVideos: NewCommentVideo[] = useMemo(() => {
    if (Array.isArray(newCommentsData)) return newCommentsData;
    return [];
  }, [newCommentsData]);

  const detail: MonitorAccountDetail | null = useMemo(() => {
    return detailData || null;
  }, [detailData]);

  const stats = useMemo(() => {
    const total = accounts.length;
    const active = accounts.filter((a) => a.monitoringEnabled && a.status !== 'blocked' && a.status !== 'login_required').length;
    const newCmts = accounts.reduce((s, a) => s + a.newComments, 0);
    const totalVideos = accounts.reduce((s, a) => s + a.videoCount, 0);
    return { total, active, newCmts, totalVideos };
  }, [accounts]);

  // 判断某个 (windowId, platform) 是否已全部暂停
  const pausedPairs = useMemo(() => {
    const map = new Map<string, boolean>(); // key = "windowId_platform" → isPaused
    if (!accounts.length) return map;
    // 按 (windowId, platform) 分组
    const groups = new Map<string, MonitorAccount[]>();
    for (const a of accounts) {
      const k = `${a.windowId}_${a.platform}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(a);
    }
    for (const [k, accs] of groups) {
      map.set(k, accs.every((a) => !a.monitoringEnabled || a.status === 'blocked' || a.status === 'login_required'));
    }
    return map;
  }, [accounts]);

  // 倒计时 — tick 驱动每秒重渲染，渲染时直接从 schedulerData 实时计算
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // 清空确认倒计时
  useEffect(() => {
    if (showClearConfirm !== null) {
      setClearCountdown(3);
      const timer = setInterval(() => {
        setClearCountdown(prev => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [showClearConfirm]);

  // 渲染时计算倒计时，直接从最新 schedulerData 读取，不依赖闭包
  const countdownMap = useMemo(() => {
    const map = new Map<string, string>();
    const statuses = schedulerData?.statuses || [];
    const now = Date.now();
    for (const s of statuses) {
      const key = `${s.windowId}_${s.platform}`;
      if (pausedPairs.get(key)) {
        map.set(key, '已暂停');
        continue;
      }
      const remaining = s.nextRunAt - now;
      if (remaining <= 0) {
        map.set(key, '即将执行');
      } else {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        map.set(key, mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`);
      }
    }
    return map;
  }, [schedulerData, tick, pausedPairs]);

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

            <div className="flex flex-wrap items-center gap-2">
              {/* 统一立即更新按钮 */}
              <button
                onClick={handleTriggerAll}
                disabled={triggerAllMonitor.isPending || stats.active === 0}
                className={cn(
                  'flex items-center gap-2 px-5 py-3 rounded-xl text-label-lg font-medium shadow-sm transition-all flex-shrink-0',
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

              {/* 一键恢复所有用户 */}
              <button
                onClick={() => enableAllUsers.mutate()}
                disabled={enableAllUsers.isPending}
                className="flex items-center gap-2 px-4 py-3 rounded-xl text-label-md font-medium shadow-sm transition-all bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 active:scale-[0.98] flex-shrink-0"
              >
                <MaterialIcon icon="replay" size="sm" />
                {enableAllUsers.isPending ? '恢复中...' : '一键恢复所有用户'}
              </button>

              {/* 清空数据库按钮 */}
              <button
                onClick={async () => {
                  if (!confirm('确定清空所有视频、评论、快照数据？')) return;
                  try {
                    const res = await api.post('/matrix/monitor/videos/clear');
                    addToast((res.data as any)?.message || '已清空', 'success');
                  } catch (e: any) {
                    addToast(e?.response?.data?.error || e?.message || '清空失败', 'error');
                  }
                }}
                className="flex items-center gap-2 px-4 py-3 rounded-xl text-label-md font-medium shadow-sm transition-all bg-red-500/10 text-red-500 border border-red-500/30 hover:bg-red-500/20 active:scale-[0.98] flex-shrink-0"
              >
                <MaterialIcon icon="delete" size="sm" />
                清空数据
              </button>

              {/* 回复调试开关 */}
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-surface border border-outline-variant flex-shrink-0">
                <MaterialIcon icon="bug_report" size="sm" className="text-amber-500" />
                <span className="text-label-md text-on-surface-variant">回复调试</span>
                <ToggleSwitch
                  id="debug-mode-toggle"
                  checked={isDebugMode}
                  onChange={(v) => updateDebugMode.mutate(v)}
                  disabled={updateDebugMode.isPending}
                />
              </div>
              </div>

              {/* ── 采集模式配置 ── */}
              <div className="flex items-center gap-4 px-4 py-3 rounded-xl bg-surface border border-outline-variant flex-shrink-0">
                <div className="flex items-center gap-2">
                  <MaterialIcon icon="settings" size="sm" className="text-primary" />
                  <span className="text-label-md text-on-surface-variant">采集模式</span>
                </div>
                <select
                  value={crawlConfig.mode}
                  onChange={(e) => setCrawlConfig({...crawlConfig, mode: e.target.value})}
                  className="form-input text-sm py-1 px-2 rounded-md border border-outline-variant bg-surface-container"
                >
                  <option value="simple">简单模式（仅根评论）</option>
                  <option value="deep">深度模式（完整评论树）</option>
                </select>
                <div className="flex items-center gap-2">
                  <label className="text-label-sm text-on-surface-variant whitespace-nowrap">根评论上限：</label>
                  <input
                    type="number"
                    value={crawlConfig.maxRootComments}
                    onChange={(e) => setCrawlConfig({...crawlConfig, maxRootComments: parseInt(e.target.value)})}
                    className="form-input text-sm py-1 px-2 rounded-md border border-outline-variant bg-surface-container w-20"
                    min={1}
                  />
                </div>
                <button
                  onClick={saveConfig}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-label-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  <MaterialIcon icon="save" size="xs" />
                  保存配置
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
                          className="px-3 py-2 rounded-lg bg-surface-container-lowest border border-outline-variant/50"
                        >
                          <div className="flex items-center justify-between">
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

                          {/* 进度详情 — 仅运行中且有进度数据时显示 */}
                          {task.status === 'running' && task.progress && (
                            <div className="mt-2 pl-9">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[11px] font-semibold text-primary">{task.progress.phase}</span>
                                <span className="text-[11px] text-on-surface-variant">{task.progress.step}</span>
                              </div>
                              {task.progress.detail && (
                                <p className="text-[10px] text-on-surface-variant mb-1.5">{task.progress.detail}</p>
                              )}
                              <div className="w-full h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                                  style={{ width: `${task.progress.percent}%` }}
                                />
                              </div>
                              <p className="text-[10px] text-on-surface-variant mt-0.5 text-right">{task.progress.percent}%</p>
                            </div>
                          )}
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
                {platformFilter !== 'all' && (
                  <span className="text-label-sm text-on-surface-variant font-normal ml-1">
                    ({filteredAccounts.length}/{accounts.length})
                  </span>
                )}
              </h2>
              <div className="flex items-center gap-3">
                {/* 平台筛选器 */}
                {availablePlatforms.length > 1 && (
                  <div className="flex items-center gap-1.5 bg-surface-container rounded-lg p-1">
                    <button
                      onClick={() => setPlatformFilter('all')}
                      className={cn(
                        'px-3 py-1.5 rounded-md text-label-sm font-medium transition-all',
                        platformFilter === 'all'
                          ? 'bg-primary text-on-primary shadow-sm'
                          : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
                      )}
                    >
                      全部
                    </button>
                    {availablePlatforms.map((p) => {
                      const pc = MONITOR_PLATFORM_CONFIG[p] || MONITOR_PLATFORM_FALLBACK;
                      return (
                        <button
                          key={p}
                          onClick={() => setPlatformFilter(p)}
                          className={cn(
                            'px-3 py-1.5 rounded-md text-label-sm font-medium transition-all flex items-center gap-1',
                            platformFilter === p
                              ? `${pc.bg} ${pc.text} shadow-sm`
                              : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
                          )}
                        >
                          <PlatformIcon platform={p as any} size={14} />
                          {PLATFORM_LABELS[p] || p}
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  onClick={() => { refetchAccounts(); refetchNewComments(); }}
                  className="text-label-md text-primary flex items-center gap-1 hover:underline"
                >
                  <MaterialIcon icon="refresh" size="xs" />
                  刷新
                </button>
              </div>
            </div>

            {accountsLoading ? (
              <div className="space-y-6">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-48 rounded-2xl border border-outline-variant animate-pulse bg-surface-container" />
                ))}
              </div>
            ) : groupedByUser.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-on-surface-variant">
                <MaterialIcon icon="person" size="3xl" className="text-outline mb-4 opacity-30" />
                <p className="text-title-md font-medium mb-1">
                  {accounts.length === 0 ? '暂无监控用户' : '当前筛选条件下无用户'}
                </p>
                <p className="text-body-sm">
                  {accounts.length === 0 ? '请先在「用户管理」中添加监控对象' : '请尝试选择其他平台'}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {groupedByUser.map((group, groupIdx) => {
                  const totalVideos = group.accounts.reduce((s, a) => s + a.videoCount, 0);
                  const totalComments = group.accounts.reduce((s, a) => s + a.totalComments, 0);
                  const totalNewComments = group.accounts.reduce((s, a) => s + a.newComments, 0);
                  const hasActive = group.accounts.some((a) => a.monitoringEnabled && a.status !== 'blocked' && a.status !== 'login_required' && a.status !== 'risk_control');
                  const hasBlocked = group.accounts.some((a) => a.status === 'blocked');
                  const hasLoginRequired = group.accounts.some((a) => a.status === 'login_required');
                  const hasRiskControl = group.accounts.some((a) => a.status === 'risk_control');

                  const sameOperatorAsPrev = groupIdx > 0
                    && groupedByUser[groupIdx - 1].operatorId === group.operatorId
                    && group.operatorId !== null;

                  return (
                    <div
                      key={group.windowId}
                      className={cn(
                        'relative bg-surface border border-outline-variant rounded-2xl overflow-hidden',
                        sameOperatorAsPrev && '-mt-3 pt-3 border-t-dashed border-t-outline-variant',
                      )}
                      style={{ animationDelay: `${groupIdx * 80}ms` }}
                    >
                      {/* 窗口头部信息 */}
                      <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-surface-container-high/80 to-surface-container/40 border-b border-outline-variant/50">
                        <div className="flex items-center gap-4">
                          {/* 窗口图标 */}
                          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                            <MaterialIcon icon="window" size="lg" className="text-primary" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <MaterialIcon icon="window" size="sm" className="text-on-surface-variant" />
                              <h3 className="text-title-md text-on-surface font-bold">
                                {group.windowName}
                              </h3>
                              {hasActive && (
                                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10">
                                  <span className="relative flex h-1.5 w-1.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                                  </span>
                                  <span className="text-[10px] text-emerald-600 font-medium">运行中</span>
                                </span>
                              )}
                              {hasLoginRequired && (
                                <span className="text-[10px] text-orange-500 bg-orange-500/10 px-2 py-0.5 rounded-full font-medium">
                                  需重新登录
                                </span>
                              )}
                              {hasRiskControl && (
                                <span className="text-[10px] text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full font-medium">
                                  风控冷却
                                </span>
                              )}
                              {hasBlocked && (
                                <span className="text-[10px] text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full font-medium">
                                  部分封禁
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-label-sm text-on-surface-variant">
                                {group.operatorName}
                              </span>
                              <span className="text-outline">·</span>
                              <span className="text-label-sm text-on-surface-variant font-mono">
                                {group.wechatUserId}
                              </span>
                              <span className="text-outline">·</span>
                              <span className="text-label-sm text-on-surface-variant">
                                {group.accounts.length} 个平台
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* 用户汇总统计 */}
                        <div className="flex items-center gap-6">
                          <div className="text-right">
                            <p className="text-headline-sm text-on-surface font-bold tabular-nums">{totalVideos}</p>
                            <p className="text-[10px] text-on-surface-variant">总视频</p>
                          </div>
                          <div className="text-right">
                            <p className="text-headline-sm text-on-surface font-bold tabular-nums">{totalComments}</p>
                            <p className="text-[10px] text-on-surface-variant">总评论</p>
                          </div>
                          <div className="text-right">
                            <p className={cn(
                              'text-headline-sm font-bold tabular-nums',
                              totalNewComments > 0 ? 'text-amber-500' : 'text-on-surface-variant',
                            )}>
                              {totalNewComments}
                            </p>
                            <p className="text-[10px] text-on-surface-variant">新评论</p>
                          </div>
                        </div>
                      </div>

                      {/* 用户级操作按钮 */}
                      <div className="px-4 py-2 flex gap-2 border-t border-outline-variant/50">
                        <button
                          onClick={() => restoreAllPlatforms.mutate(group.accounts[0]?.id)}
                          disabled={restoreAllPlatforms.isPending}
                          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                        >
                          {restoreAllPlatforms.isPending ? '恢复中...' : '恢复所有平台'}
                        </button>
                        <button
                          onClick={() => setShowPinnedSettings(group.accounts[0]?.id ?? 0)}
                          className="px-3 py-1.5 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                        >
                          置顶视频设置
                        </button>
                        <button
                          onClick={() => setShowClearConfirm(group.accounts[0]?.id ?? 0)}
                          className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                        >
                          清空所有数据
                        </button>
                      </div>

                      {/* 平台卡片网格 */}
                      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {group.accounts.map((account) => {
                          const pc = MONITOR_PLATFORM_CONFIG[account.platform] || MONITOR_PLATFORM_FALLBACK;
                           const isBlocked = account.status === 'blocked';
                           const isLoginRequired = account.status === 'login_required';
                           const isRiskControl = account.status === 'risk_control';
                           const isCooldown = account.cooldownUntil > Date.now();
                           const isActive = account.monitoringEnabled && !isBlocked && !isLoginRequired && !isRiskControl;

                          return (
                            <div
                              key={account.id}
                              className={cn(
                                'group relative bg-surface-container-low border border-outline-variant/50 rounded-xl overflow-hidden cursor-pointer',
                                'hover:border-primary/40 hover:shadow-md transition-all duration-200',
                                `border-l-3 ${pc.border}`,
                              )}
                              onClick={() => handleEnterDetail(account.id)}
                            >
                              <div className={cn('absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none', pc.gradient)} />

                              <div className="relative p-3.5">
                                {/* 平台头部 */}
                                <div className="flex items-center justify-between mb-2.5">
                                  <div className="flex items-center gap-2.5">
                                    <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs', pc.bg, pc.text)}>
                                      {account.platformName.charAt(0)}
                                    </div>
                                    <div>
                                      <h4 className="text-label-md text-on-surface font-semibold">{account.platformName}</h4>
                                      <p className="text-[10px] text-on-surface-variant">
                                        {account.lastCheckTime ? formatRelativeTime(account.lastCheckTime) : '未检测'}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                     {isActive && (
                                       <span className="w-2 h-2 rounded-full bg-emerald-500" title="运行中" />
                                     )}
                                     {isLoginRequired && (
                                       <span className="w-2 h-2 rounded-full bg-orange-500" title="需重新登录" />
                                     )}
                                     {isRiskControl && (
                                       <span className="w-2 h-2 rounded-full bg-amber-500" title="风控冷却中" />
                                     )}
                                     {isBlocked && (
                                       <span className="w-2 h-2 rounded-full bg-red-500" title="已封禁" />
                                     )}
                                    {isCooldown && !isBlocked && (
                                      <span className="w-2 h-2 rounded-full bg-amber-500" title="冷却中" />
                                    )}
                                    {!account.monitoringEnabled && (
                                      <span className="w-2 h-2 rounded-full bg-gray-400" title="已暂停" />
                                    )}
                                  </div>
                                </div>

                                {/* 统计行 */}
                                <div className="flex items-center gap-4 mb-2.5">
                                  <div>
                                    <p className="text-label-lg text-on-surface font-bold tabular-nums">{account.videoCount}</p>
                                    <p className="text-[9px] text-on-surface-variant">视频</p>
                                  </div>
                                  <div>
                                    <p className="text-label-lg text-on-surface font-bold tabular-nums">{account.totalComments}</p>
                                    <p className="text-[9px] text-on-surface-variant">评论</p>
                                  </div>
                                  <div>
                                    <p className={cn(
                                      'text-label-lg font-bold tabular-nums',
                                      account.newComments > 0 ? 'text-amber-500' : 'text-on-surface-variant',
                                    )}>
                                      {account.newComments}
                                    </p>
                                    <p className="text-[9px] text-on-surface-variant">新增</p>
                                  </div>
                                </div>

                                {/* 下次监控倒计时 */}
                                {isActive && (
                                  <div className="flex items-center gap-1.5 mb-2.5 px-2 py-1 rounded-md bg-indigo-50/50 border border-indigo-100/50">
                                    <span className="text-[10px] text-indigo-400">⏱</span>
                                    <span className="text-[11px] text-indigo-600 font-semibold tabular-nums">
                                      {countdownMap.get(`${account.windowId}_${account.platform}`) || '--'}
                                    </span>
                                  </div>
                                )}

                                {/* 操作按钮 */}
                                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                  <button
                                    onClick={() => handleTrigger(account.id)}
                                    disabled={triggerMonitor.isPending || !account.monitoringEnabled || isBlocked}
                                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                  >
                                    <MaterialIcon icon="sync" size="xs" />
                                    更新
                                  </button>
                                  <button
                                    onClick={() => handleToggle(account.id, account.monitoringEnabled)}
                                    disabled={toggleMonitor.isPending}
                                    className={cn(
                                      'flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-30',
                                      account.monitoringEnabled
                                        ? 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                                        : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20',
                                    )}
                                  >
                                    <MaterialIcon icon={account.monitoringEnabled ? 'pause' : 'play_arrow'} size="xs" />
                                    {account.monitoringEnabled ? '暂停' : '恢复'}
                                  </button>
                                  <button
                                    onClick={async () => {
                                      if (!confirm(`确定清空 ${account.platformName} 的所有视频和评论数据？`)) return;
                                      try {
                                        const res = await clearUserData.mutateAsync(account.id);
                                        addToast((res as any)?.message || '已清空', 'success');
                                      } catch (e: any) {
                                        addToast(e?.response?.data?.error || e?.message || '清空失败', 'error');
                                      }
                                    }}
                                    disabled={clearUserData.isPending}
                                    className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors disabled:opacity-30"
                                    title="清空该用户数据"
                                  >
                                    <MaterialIcon icon="delete" size="xs" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
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
                    <>
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
                      {selectedVideoId === video.id && (
                        <div className="ml-2 border-l-2 border-primary/20 pl-3 pb-1">
                          {/* Tab 切换 */}
                          <div className="flex gap-1 mb-2 pt-2">
                            <button
                              onClick={() => setCommentTab('comments')}
                              className={cn(
                                'px-3 py-1 rounded text-label-sm font-medium transition-colors',
                                commentTab === 'comments'
                                  ? 'bg-primary text-white'
                                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                              )}
                            >
                              评论详情
                            </button>
                            <button
                              onClick={() => setCommentTab('notifications')}
                              className={cn(
                                'px-3 py-1 rounded text-label-sm font-medium transition-colors',
                                commentTab === 'notifications'
                                  ? 'bg-amber-500 text-white'
                                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                              )}
                            >
                              更新通知
                            </button>
                          </div>

                          {/* 内容区域 */}
                          {videoCommentsData ? (
                            commentTab === 'comments' ? (
                              (() => {
                                const realComments = videoCommentsData.filter((c: any) => !c.isLightMode);
                                return realComments.length === 0 ? (
                                  <p className="text-body-sm text-on-surface-variant py-2">暂无评论</p>
                                ) : (
                                  <div className="flex flex-col gap-2">
                                    {realComments.map((root: any) => (
                                      <div key={root.cid} className={`bg-surface-variant/50 rounded-lg p-2.5 ${root.isNew ? 'border-l-4 border-orange-400 bg-orange-50' : 'border-l-2 border-amber-500/40'}`}>
                                        <div className="flex items-start gap-1.5">
                                          <span className="text-label-xs font-medium text-on-surface">{root.userNickname || '匿名'}</span>
                                          {root.isNew && (
                                            <span className="ml-2 px-1.5 py-0.5 text-xs font-medium rounded bg-orange-100 text-orange-700">新</span>
                                          )}
                                          {root.isAuthor && (
                                            <span className="ml-1 px-1.5 py-0.5 text-xs font-medium rounded bg-primary/10 text-primary flex items-center gap-0.5">
                                              <MaterialIcon icon="person" size="xs" />
                                              作者
                                            </span>
                                          )}
                                        </div>
                                        <p className="text-body-sm text-on-surface mt-0.5 leading-relaxed">{root.text}</p>
                                        <span className="text-[10px] text-on-surface-variant/60">{formatRelativeTime(root.createTime)}</span>
                                        <AiReplyCard
                                          commentId={typeof root.id === 'number' ? root.id : parseInt(root.id)}
                                          suggestionStatus={root.suggestionStatus || 'none'}
                                          suggestedReply={root.suggestedReply}
                                          suggestionModel={root.suggestionModel}
                                          suggestionLatencyMs={root.suggestionLatencyMs}
                                          replyStatus={root.replyStatus || 'none'}
                                          isNew={root.isNew}
                                        />
                                        {root.replies?.length > 0 && (
                                          <div className="ml-3 mt-1.5 border-l border-outline-variant pl-2.5 flex flex-col gap-1.5">
                                            {root.replies.map((sub: any) => (
                                              <div key={sub.cid} className={`py-0.5 ${sub.isNew ? 'border-l-4 border-orange-400 bg-orange-50 pl-1.5 rounded' : ''}`}>
                                                <div className="flex items-start gap-1.5">
                                                  <span className="text-label-xs font-medium text-on-surface">{sub.userNickname || '匿名'}</span>
                                                  {sub.isNew && (
                                                    <span className="ml-2 px-1.5 py-0.5 text-xs font-medium rounded bg-orange-100 text-orange-700">新</span>
                                                  )}
                                                  {sub.isAuthor && (
                                                    <span className="ml-1 px-1.5 py-0.5 text-xs font-medium rounded bg-primary/10 text-primary flex items-center gap-0.5">
                                                      <MaterialIcon icon="person" size="xs" />
                                                      作者
                                                    </span>
                                                  )}
                                                  {sub.replyToName && <span className="text-[10px] text-primary/70">@ {sub.replyToName}</span>}
                                                </div>
                                                <p className="text-body-sm text-on-surface-variant/80 mt-0.5">{sub.text}</p>
                                                <AiReplyCard
                                                  commentId={typeof sub.id === 'number' ? sub.id : parseInt(sub.id)}
                                                  suggestionStatus={sub.suggestionStatus || 'none'}
                                                  suggestedReply={sub.suggestedReply}
                                                  suggestionModel={sub.suggestionModel}
                                                  suggestionLatencyMs={sub.suggestionLatencyMs}
                                                  replyStatus={sub.replyStatus || 'none'}
                                                  isNew={sub.isNew}
                                                  isSub
                                                />
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                );
                              })()
                            ) : (
                              (() => {
                                const notifications = videoCommentsData.filter((c: any) => c.isLightMode);
                                return notifications.length > 0 ? (
                                  <div className="flex flex-col gap-2">
                                    {notifications.map((n: any) => (
                                      <div key={n.cid} className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                                        <div className="flex items-center gap-2">
                                          <MaterialIcon icon="notifications" size="sm" className="text-amber-500" />
                                          <span className="text-label-sm text-amber-700 font-medium">增量通知</span>
                                          <span className="text-[10px] text-amber-500">{formatRelativeTime(n.createTime)}</span>
                                        </div>
                                        <p className="text-body-sm text-amber-900 mt-1">{n.text}</p>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-body-sm text-on-surface-variant py-2">暂无更新通知</p>
                                );
                              })()
                            )
                          ) : (
                            <p className="text-body-sm text-on-surface-variant py-2">加载中...</p>
                          )}
                        </div>
                      )}
                    </>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
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
                const isLoginRequired = detail.status === 'login_required';
                const isRiskControl = detail.status === 'risk_control';
                const isActive = detail.monitoringEnabled && !isBlocked && !isRiskControl;

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
                                {detail.windowId}
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
                              {isLoginRequired && (
                                <span className="text-[11px] text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full">需重新登录</span>
                              )}
                              {isRiskControl && (
                                <span className="text-[11px] text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">风控冷却中</span>
                              )}
                              {isRiskControl && (
                                <span className="text-[11px] text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">风控冷却中</span>
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
                          <button
                            onClick={async () => {
                              if (!confirm(`确定清空 ${detail.platformName} 的所有视频和评论数据？`)) return;
                              try {
                                const res = await clearUserData.mutateAsync(detail.id);
                                addToast((res as any)?.message || '已清空', 'success');
                                handleBack(); // 清空后返回列表
                              } catch (e: any) {
                                addToast(e?.response?.data?.error || e?.message || '清空失败', 'error');
                              }
                            }}
                            disabled={clearUserData.isPending}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg text-label-md font-medium border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-30"
                          >
                            <MaterialIcon icon="delete" size="sm" />
                            清空数据
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
                        <>
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
                                  {video.isPinned && <span className="text-yellow-500 mr-1">📌</span>}
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
                                  {/* 播放量 - 视频号使用 readCount */}
                                  {video.metrics && (video.metrics.viewCount ?? video.metrics.readCount) != null && (
                                    <span className="flex items-center gap-1 text-label-sm text-on-surface-variant">
                                      <MaterialIcon icon="visibility" size="xs" />
                                      {formatNumber(video.metrics.viewCount ?? video.metrics.readCount)} 播放
                                    </span>
                                  )}
                                  {/* 点赞数 */}
                                  {video.metrics?.likeCount != null && video.metrics.likeCount > 0 && (
                                    <span className="flex items-center gap-1 text-label-sm text-on-surface-variant">
                                      <MaterialIcon icon="thumb_up" size="xs" />
                                      {formatNumber(video.metrics.likeCount)} 点赞
                                    </span>
                                  )}
                                  {/* 收藏/推荐数 - 视频号特有 */}
                                  {video.metrics?.favCount != null && video.metrics.favCount > 0 && (
                                    <span className="flex items-center gap-1 text-label-sm text-on-surface-variant">
                                      <MaterialIcon icon="bookmark" size="xs" />
                                      {formatNumber(video.metrics.favCount)} 推荐
                                    </span>
                                  )}
                                  {/* 分享数 */}
                                  {video.metrics?.forwardCount != null && video.metrics.forwardCount > 0 && (
                                    <span className="flex items-center gap-1 text-label-sm text-on-surface-variant">
                                      <MaterialIcon icon="send" size="xs" />
                                      {formatNumber(video.metrics.forwardCount)} 分享
                                    </span>
                                  )}
                                  <span className="text-[11px] text-outline">
                                    更新于 {formatRelativeTime(video.updatedAt)}
                                  </span>
                                </div>
                              </div>

                              <button
                                onClick={() => handleTrigger(detail.id)}
                                disabled={triggerMonitor.isPending || !detail.monitoringEnabled || detail.status === 'blocked' || detail.status === 'login_required' || detail.status === 'risk_control'}
                                className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg text-label-md text-primary bg-primary/10 hover:bg-primary/20 transition-colors disabled:opacity-30"
                                title="更新此用户的评论"
                              >
                                <MaterialIcon icon="refresh" size="xs" />
                                更新
                              </button>
                            </div>
                          </div>
                          {selectedVideoId === video.id && (
                            <div className="ml-4 border-l-2 border-primary/30 pl-3 pb-2 mt-2">
                              {videoCommentsData ? (
                                videoCommentsData.length === 0 ? (
                                  <p className="text-body-sm text-on-surface-variant py-2">暂无评论</p>
                                ) : (
                                  <div className="flex flex-col gap-2 pt-1">
                                    {videoCommentsData.map((root: any) => (
                                      <div key={root.cid} className={`bg-surface-variant/50 rounded-lg p-2.5 ${root.isNew ? 'border-l-4 border-orange-400 bg-orange-50' : 'border-l-2 border-amber-500/40'}`}>
                                        <div className="flex items-start gap-1.5">
                                          <span className="text-label-xs font-medium text-on-surface">{root.userNickname || '匿名'}</span>
                                          {root.isNew && (
                                            <span className="ml-2 px-1.5 py-0.5 text-xs font-medium rounded bg-orange-100 text-orange-700">新</span>
                                          )}
                                          {root.isAuthor && (
                                            <span className="ml-1 px-1.5 py-0.5 text-xs font-medium rounded bg-primary/10 text-primary flex items-center gap-0.5">
                                              <MaterialIcon icon="person" size="xs" />
                                              作者
                                            </span>
                                          )}
                                        </div>
                                        <p className="text-body-sm text-on-surface mt-0.5 leading-relaxed">{root.text}</p>
                                        <AiReplyCard
                                          commentId={typeof root.id === 'number' ? root.id : parseInt(root.id)}
                                          suggestionStatus={root.suggestionStatus || 'none'}
                                          suggestedReply={root.suggestedReply}
                                          suggestionModel={root.suggestionModel}
                                          suggestionLatencyMs={root.suggestionLatencyMs}
                                          replyStatus={root.replyStatus || 'none'}
                                          isNew={root.isNew}
                                        />
                                        {root.replies?.length > 0 && (
                                          <div className="ml-3 mt-1.5 border-l border-outline-variant pl-2.5 flex flex-col gap-1.5">
                                            {root.replies.map((sub: any) => (
                                              <div key={sub.cid} className={`py-0.5 ${sub.isNew ? 'border-l-4 border-orange-400 bg-orange-50 pl-1.5 rounded' : ''}`}>
                                                <div className="flex items-start gap-1.5">
                                                  <span className="text-label-xs font-medium text-on-surface">{sub.userNickname || '匿名'}</span>
                                                  {sub.isNew && (
                                                    <span className="ml-2 px-1.5 py-0.5 text-xs font-medium rounded bg-orange-100 text-orange-700">新</span>
                                                  )}
                                                  {sub.isAuthor && (
                                                    <span className="ml-1 px-1.5 py-0.5 text-xs font-medium rounded bg-primary/10 text-primary flex items-center gap-0.5">
                                                      <MaterialIcon icon="person" size="xs" />
                                                      作者
                                                    </span>
                                                  )}
                                                  {sub.replyToName && <span className="text-[10px] text-primary/70">@ {sub.replyToName}</span>}
                                                </div>
                                                <p className="text-body-sm text-on-surface-variant/80 mt-0.5">{sub.text}</p>
                                                <AiReplyCard
                                                  commentId={typeof sub.id === 'number' ? sub.id : parseInt(sub.id)}
                                                  suggestionStatus={sub.suggestionStatus || 'none'}
                                                  suggestedReply={sub.suggestedReply}
                                                  suggestionModel={sub.suggestionModel}
                                                  suggestionLatencyMs={sub.suggestionLatencyMs}
                                                  replyStatus={sub.replyStatus || 'none'}
                                                  isNew={sub.isNew}
                                                  isSub
                                                />
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
                        </>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 置顶视频设置面板 ── */}
      {showPinnedSettings !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-bold mb-4">置顶视频采集设置</h3>
            <p className="mb-4 text-gray-600">控制是否跳过置顶视频的评论采集</p>

            {['douyin', 'kuaishou', 'xiaohongshu', 'tencent'].map(platform => (
              <div key={platform} className="flex items-center justify-between mb-3">
                <span>{PLATFORM_LABELS[platform] || platform}</span>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={pinnedSettings[platform] !== false}
                    onChange={(e) => setPinnedSettings(prev => ({
                      ...prev,
                      [platform]: e.target.checked,
                    }))}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm">跳过置顶</span>
                </label>
              </div>
            ))}

            <div className="flex gap-4 mt-4">
              <button
                onClick={() => savePinnedSettings()}
                disabled={updateSkipPinned.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors flex-1"
              >
                {updateSkipPinned.isPending ? '保存中...' : '保存设置'}
              </button>
              <button
                onClick={() => setShowPinnedSettings(null)}
                className="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors flex-1"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 清空数据确认对话框 ── */}
      {showClearConfirm !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-bold mb-4 text-on-surface">确认清空数据</h3>
            <p className="mb-4 text-on-surface-variant">确定要清空该用户的所有数据吗？此操作将删除：</p>
            <ul className="list-disc list-inside mb-4 text-gray-600 space-y-1">
              <li>所有视频记录</li>
              <li>所有评论记录</li>
              <li>监控状态</li>
            </ul>
            <p className="mb-4 text-red-600 font-semibold">此操作不可撤销！</p>
            <div className="flex gap-4">
              <button
                onClick={() => {
                  clearAllUserData.mutate(showClearConfirm, {
                    onSuccess: () => setShowClearConfirm(null),
                  });
                }}
                disabled={clearAllUserData.isPending || clearCountdown > 0}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors flex-1"
              >
                {clearCountdown > 0 ? `确认清空 (${clearCountdown}s)` : '确认清空'}
              </button>
              <button
                onClick={() => { setShowClearConfirm(null); setClearCountdown(0); }}
                className="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors flex-1"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
