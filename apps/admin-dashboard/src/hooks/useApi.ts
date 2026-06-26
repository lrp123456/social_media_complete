import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';

// ============================================================
// 类型定义
// ============================================================

type Platform = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'bilibili' | 'baijiahao' | 'tencent' | 'tiktok';

type PublishVideoParams = {
  platform: Platform;
  accountId: string;
  windowId: string;
  credentials: { username: string; cookies?: Record<string, string>; phone?: string };
  video: { ossUrl: string; filename: string; size: number; duration?: number };
  metadata: { title: string; description?: string; tags?: string[]; coverUrl?: string; scheduleTime?: string; isOriginal?: boolean; category?: string };
};

type ComposeVideoParams = {
  mode: 'no_narration' | 'with_narration';
  strategy: 'random' | 'style_fixed' | 'user_uploaded';
  count: number;
  style?: string;
  platform?: string;
  bgm_oss_url?: string;
  user_segments?: Array<{ name: string; oss_url: string }>;
  narration_config?: { voice?: string; tone?: string };
};

type MaterialItem = {
  id: string;
  thumbnail: string;
  title: string;
  style: string;
  room: string;
  quality: 'S' | 'A' | 'B' | 'C';
  source: string;
  sourceLabel: string;
  date: string;
  likes: number;
  saves: number;
  ossUrl?: string;
};

type MaterialStats = {
  total: number;
  byStyle: Record<string, number>;
  byRoom: Record<string, number>;
  byQuality: Record<string, number>;
  bySource: Record<string, number>;
  recentCollections: Array<{
    taskId: string;
    date: string;
    count: number;
    query: string;
  }>;
};

// ============================================================
// 配置管理
// ============================================================

export function usePlatformConfigs(platform: string) {
  return useQuery({
    queryKey: ['configs', platform],
    queryFn: () => api.get(`/config/${platform}`).then((r) => r.data.configs),
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { platform: string; configKey: string; configValue: string }) =>
      api.post('/config', data).then((r) => r.data),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ['configs', vars.platform] }),
  });
}

// ============================================================
// 发布任务
// ============================================================

export function usePublishVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PublishVideoParams) =>
      api.post('/matrix/publish', {
        platform: data.platform,
        accountId: data.accountId,
        windowId: data.windowId,
        credentials: data.credentials,
        video: data.video,
        metadata: data.metadata,
      }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publish'] }),
  });
}

export function usePublishStatus(taskId: string, refetchInterval?: number) {
  return useQuery({
    queryKey: ['publish', 'status', taskId],
    queryFn: () => api.get(`/matrix/publish/tasks/${taskId}`).then((r) => r.data),
    refetchInterval: refetchInterval ?? 5000,
    enabled: !!taskId,
  });
}

// ============================================================
// Pinterest 采集
// ============================================================

export function usePinterestScrape() {
  return useMutation({
    mutationFn: (data: { query: string; maxPins: number; windowId: string }) =>
      api.post('/materials/collect', data).then((r) => r.data),
  });
}

export function usePinterestStatus(taskId: string, refetchInterval?: number) {
  return useQuery({
    queryKey: ['pinterest', 'status', taskId],
    queryFn: () => api.get(`/materials/collect/status/${taskId}`).then((r) => r.data),
    refetchInterval: refetchInterval ?? 5000,
    enabled: !!taskId,
  });
}

// ============================================================
// 视频合成
// ============================================================

export function useComposeVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ComposeVideoParams) =>
      api.post('/compose', data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

// ============================================================
// 运营看板
// ============================================================

export function useSystemOverview() {
  return useQuery({
    queryKey: ['system', 'overview'],
    queryFn: () => api.get('/system/overview').then((r) => r.data),
  });
}

// ============================================================
// 矩阵监控
// ============================================================

export function useMonitorTargets() {
  return useQuery({
    queryKey: ['monitor', 'targets'],
    queryFn: () =>       api.get('/matrix/monitor/users').then((r) => r.data),
  });
}

export function useMonitorVideos(platform?: string, search?: string) {
  return useQuery({
    queryKey: ['monitor', 'videos', platform, search],
    queryFn: () => {
      const params = new URLSearchParams();
      if (platform) params.set('platform', platform);
      if (search) params.set('search', search);
      return api.get(`/matrix/monitor/videos?${params.toString()}`).then((r) => r.data);
    },
  });
}

export function useVideoComments(videoId: string) {
  return useQuery({
    queryKey: ['monitor', 'videos', videoId, 'comments'],
    queryFn: () => api.get(`/matrix/monitor/videos/${encodeURIComponent(videoId)}/comments`).then((r) => r.data),
    enabled: !!videoId,
  });
}

// ============================================================
// 账号托管
// ============================================================

export function useHostedAccounts() {
  return useQuery({
    queryKey: ['accounts', 'hosted'],
    queryFn: () => api.get('/matrix/accounts').then((r) => r.data),
  });
}

// ============================================================
// 创作任务
// ============================================================

export function useCreationTasks() {
  return useQuery({
    queryKey: ['tasks', 'creation'],
    queryFn: () => api.get('/tasks/creation').then((r) => r.data),
  });
}

// ============================================================
// 审计日志
// ============================================================

export function useAuditLogs(limit?: number) {
  return useQuery({
    queryKey: ['audit', 'logs', limit],
    queryFn: () => api.get('/audit/logs', { params: { limit } }).then((r) => r.data),
  });
}

// ============================================================
// LLM Provider 管理
// ============================================================

export function useLLMProviders() {
  return useQuery({
    queryKey: ['llm', 'providers'],
    queryFn: () => api.get('/llm/providers').then((r) => r.data),
  });
}

export function useTestLLMKey(provider: string) {
  return useMutation({
    mutationFn: () => api.post(`/llm/providers/${provider}/test`).then((r) => r.data),
  });
}

// ============================================================
// 视频上传(OSS multipart upload)
// ============================================================

export type UploadResult = {
  ossUrl: string;
  filename: string;
  size: number;
  duration?: number;
  width?: number;
  height?: number;
};

export function useUploadVideo() {
  return useMutation({
    mutationFn: async (file: File): Promise<UploadResult> => {
      const form = new FormData();
      form.append('file', file);
      // 不手动设置 Content-Type，让 axios 自动带 boundary
      const res = await api.post('/upload', form, {
        timeout: 300_000, // 5 分钟(大文件)
      });
      return res.data;
    },
  });
}

// ============================================================
// 批量发布调度(按 windowId 分组:同组串行,异组并行)
// 一个用户一个窗口,同窗口多平台必须顺序操作;跨窗口可并行
// ============================================================

export type BatchPublishAccount = {
  accountId: string;
  windowId: string;
  platform: Platform;
  credentials: PublishVideoParams['credentials'];
};

export type BatchPublishInput = {
  video: PublishVideoParams['video'];
  metadata: PublishVideoParams['metadata'];
  accounts: BatchPublishAccount[];
};

export type BatchPublishResult = {
  total: number;
  succeeded: number;
  failed: number;
  groups: Array<{
    windowId: string;
    results: Array<{
      accountId: string;
      platform: Platform;
      taskId?: string;
      success: boolean;
      error?: string;
    }>;
  }>;
};

export function useBatchPublish() {
  const mutation = usePublishVideo();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: BatchPublishInput): Promise<BatchPublishResult> => {
      // 1. 按 windowId 分组(同窗口多账号必须串行)
      const byWindow = new Map<string, BatchPublishAccount[]>();
      for (const acc of input.accounts) {
        const arr = byWindow.get(acc.windowId) || [];
        arr.push(acc);
        byWindow.set(acc.windowId, arr);
      }

      // 2. 每组串行,组间并行
      const groupResults = await Promise.all(
        Array.from(byWindow.entries()).map(async ([windowId, accounts]) => {
          const results: BatchPublishResult['groups'][number]['results'] = [];
          for (const acc of accounts) {
            try {
              const res = await mutation.mutateAsync({
                platform: acc.platform,
                accountId: acc.accountId,
                windowId: acc.windowId,
                credentials: acc.credentials,
                video: input.video,
                metadata: input.metadata,
              });
              results.push({ accountId: acc.accountId, platform: acc.platform, taskId: res.taskId, success: true });
            } catch (err: any) {
              results.push({
                accountId: acc.accountId,
                platform: acc.platform,
                success: false,
                error: err?.response?.data?.error || err?.message || '发布失败',
              });
            }
          }
          return { windowId, results };
        }),
      );

      const result: BatchPublishResult = {
        total: input.accounts.length,
        succeeded: groupResults.reduce((s, g) => s + g.results.filter((r) => r.success).length, 0),
        failed: groupResults.reduce((s, g) => s + g.results.filter((r) => !r.success).length, 0),
        groups: groupResults,
      };
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publish'] }),
  });
}

// ============================================================
// 任务执行状态轮询
// ============================================================

export type TaskStatus = {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  platform: string;
  userName: string;
  error?: string;
};

export function useTaskStatuses(taskIds: string[]) {
  const idsKey = taskIds.filter(Boolean).join(',');
  return useQuery({
    queryKey: ['taskStatus', idsKey],
    queryFn: async (): Promise<TaskStatus[]> => {
      if (!idsKey) return [];
      const res = await api.get('/matrix/publish/tasks/batch-status', { params: { ids: idsKey } });
      // 注意：response interceptor 已自动解包 { success: true, data: [...] } → [...]
      // 因此 res.data 直接就是数组，不需要再 .data
      return (Array.isArray(res.data) ? res.data : []) as TaskStatus[];
    },
    refetchInterval: idsKey ? 3000 : false, // 每 3 秒轮询
    enabled: idsKey.length > 0,
  });
}

// ============================================================
// 评论操作
// ============================================================

export function useMarkCommentRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string | number) =>
      api.post(`/matrix/monitor/comments/${commentId}/read`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor'] });
    },
  });
}

export function useMarkAllCommentsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { videoId?: string } = {}) =>
      api.post('/matrix/monitor/comments/read-all', input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor'] }),
  });
}

export function useReplyComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { commentId: string | number; text: string; viaWechatWork?: boolean }) =>
      api.post(`/matrix/monitor/comments/${input.commentId}/reply`, {
        text: input.text,
        viaWechatWork: input.viaWechatWork ?? false,
      }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor'] }),
  });
}

// ============================================================
// AI 客服回复建议
// ============================================================

export function useGenerateAiReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { commentId: number; serviceType?: 'simple' | 'intelligent' }) =>
      api.post('/llm/reply/generate', input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor'] }),
  });
}

export function useRegenerateAiReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { commentId: number; previousReply: string; feedback?: string; serviceType?: 'simple' | 'intelligent' }) =>
      api.post('/llm/reply/regenerate', input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor'] }),
  });
}

export function useAcceptAiReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { commentId: number; text: string }) =>
      api.post(`/matrix/monitor/comments/${input.commentId}/accept-reply`, { text: input.text }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['monitor'] }),
  });
}

// ============================================================
// 监控账户管理（新增）
// ============================================================

export type MonitorAccount = {
  id: number;
  platform: string;
  platformName: string;
  windowId: string;
  windowName: string;
  operatorId: number | null;
  operatorName: string;
  wechatUserId: string;
  status: string;
  monitoringEnabled: boolean;
  videoCount: number;
  totalComments: number;
  newComments: number;
  lastCheckTime: string | null;
  cooldownUntil: number;
  createdAt: string;
};

export function useMonitorAccounts() {
  return useQuery({
    queryKey: ['monitor', 'accounts'],
    queryFn: () => api.get('/matrix/monitor/accounts').then((r) => r.data),
    refetchInterval: 30000,
  });
}

export type MonitorVideoDetail = {
  id: string;
  description: string;
  createTime: number;
  commentCount: number;
  newCommentCount: number;
  metrics: Record<string, number> | null;
  updatedAt: string;
  isPinned: boolean;
};

export type MonitorAccountDetail = {
  id: number;
  platform: string;
  platformName: string;
  windowId: string;
  status: string;
  monitoringEnabled: boolean;
  cooldownUntil: number;
  lastCheckTime: string | null;
  lastVideoCount: number;
  lastCommentCount: number;
  videos: MonitorVideoDetail[];
};

export function useMonitorAccountDetail(userId: number | null) {
  return useQuery({
    queryKey: ['monitor', 'accounts', userId],
    queryFn: () => api.get(`/matrix/monitor/accounts/${userId}`).then((r) => r.data),
    enabled: !!userId,
    refetchInterval: 30000,
  });
}

export function useTriggerMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) =>
      api.post(`/matrix/monitor/accounts/${userId}/trigger`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor'] });
    },
  });
}

export function useToggleMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: number; enabled: boolean }) =>
      api.put(`/matrix/monitor/accounts/${input.userId}/toggle`, { enabled: input.enabled }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor'] });
    },
  });
}

export function useClearUserData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) =>
      api.post(`/matrix/monitor/accounts/${userId}/clear`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor'] });
    },
  });
}

/** 一键恢复所有用户 */
export function useEnableAllUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/matrix/monitor/accounts/enable-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}

/** 恢复用户所有平台 */
export function useRestoreAllPlatforms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.post(`/matrix/monitor/accounts/${userId}/restore-all`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}

/** 清空用户所有数据 */
export function useClearAllUserData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => api.post(`/matrix/monitor/accounts/${userId}/clear-all`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}

/** 更新置顶视频跳过设置 */
export function useUpdateSkipPinnedVideos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, skipPinnedVideos }: { userId: number; skipPinnedVideos: Record<string, boolean> }) =>
      api.patch(`/matrix/monitor/accounts/${userId}/skip-pinned`, { skipPinnedVideos }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-accounts'] });
    },
  });
}

export type NewCommentVideo = {
  id: string;
  description: string;
  platform: string;
  platformName: string;
  userId: number;
  totalComments: number;
  newCommentCount: number;
  updatedAt: string;
};

export function useNewCommentsOverview() {
  return useQuery({
    queryKey: ['monitor', 'new-comments'],
    queryFn: () => api.get('/matrix/monitor/new-comments').then((r) => r.data),
    refetchInterval: 30000,
  });
}

// ============================================================
// 监控任务状态追踪
// ============================================================

export type MonitorTaskStatus = {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  platform: string;
  userId: number;
  error?: string;
  details?: Record<string, any>;
  progress?: {
    phase: string;
    step: string;
    percent: number;
    detail?: string;
  } | null;
};

export function useMonitorTaskStatuses(taskIds: string[]) {
  return useQuery({
    queryKey: ['monitor', 'task-statuses', taskIds],
    queryFn: () =>
      api
        .get(`/matrix/monitor/tasks/batch-status?ids=${taskIds.join(',')}`)
        .then((r) => r.data.data as MonitorTaskStatus[]),
    enabled: taskIds.length > 0,
    refetchInterval: (query) => {
      // 轮询直到所有任务完成/失败
      const data = query.state.data;
      if (!data) return 3000;
      const allDone = data.every(
        (s: MonitorTaskStatus) => s.status === 'completed' || s.status === 'failed',
      );
      return allDone ? false : 3000;
    },
  });
}

// ============================================================
// 活跃监控任务（常驻队列 — 所有窗口并行展示）
// ============================================================

export type ActiveWindowTasks = {
  windowId: string;
  tasks: MonitorTaskStatus[];
};

export type ActiveTasksData = {
  total: number;
  running: number;
  queued: number;
  windows: ActiveWindowTasks[];
};

export function useActiveMonitorTasks() {
  return useQuery({
    queryKey: ['monitor', 'active-tasks'],
    queryFn: () =>
      api.get('/matrix/monitor/active-tasks').then((r) => r.data as ActiveTasksData),
    refetchInterval: 2000, // 每2秒轮询，快速反映任务进度
    retry: 2,
    staleTime: 1000,
  });
}

export function useCancelMonitorTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      api.post(`/matrix/monitor/tasks/${taskId}/cancel`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor', 'active-tasks'] });
      qc.invalidateQueries({ queryKey: ['queue', 'active'] });
    },
  });
}

export function useCancelAllMonitorTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post('/matrix/monitor/active-tasks/cancel-all').then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor', 'active-tasks'] });
      qc.invalidateQueries({ queryKey: ['queue', 'active'] });
    },
  });
}

// ============================================================
// 调度器状态（每 (窗口, 平台) 独立倒计时）
// ============================================================

export type PlatformSchedulerStatus = {
  windowId: string;
  platform: string;
  intervalMs: number;
  lastRunAt: number;
  nextRunAt: number;
  remainingMs: number;
  mode: 'active' | 'idle';
  consecutiveNoUpdates: number;
};

export type SchedulerStatusResponse = {
  statuses: PlatformSchedulerStatus[];
};

export function useSchedulerStatus() {
  return useQuery({
    queryKey: ['monitor', 'scheduler-status'],
    queryFn: () =>
      api.get('/matrix/monitor/scheduler-status').then((r) => {
        // interceptor 已自动解包 { success, data } → data
        return r.data as SchedulerStatusResponse;
      }),
    refetchInterval: 10000, // 每10秒同步一次
    retry: 2,
    staleTime: 8000,
  });
}

// ============================================================
// 统一触发所有平台监控
// ============================================================

export function useTriggerAllMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post('/matrix/monitor/trigger-all').then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor'] });
    },
  });
}

// ============================================================
// 爬虫设置与平台能力
// ============================================================

export type CrawlSetting = {
  platform: string;
  platformName: string;
  mode: 'deep' | 'light';
  enabled: boolean;
  updatedAt: string | null;
};

export function useCrawlSettings() {
  return useQuery({
    queryKey: ['monitor', 'crawl-settings'],
    queryFn: () => api.get('/matrix/monitor/crawl-settings').then((r) => r.data),
  });
}

export function useUpdateCrawlSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; mode: 'deep' | 'light'; enabled?: boolean }) =>
      api.put(`/matrix/monitor/crawl-settings/${input.platform}`, {
        mode: input.mode,
        enabled: input.enabled,
      }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor', 'crawl-settings'] });
    },
  });
}

export type PlatformCapability = {
  platform: string;
  platformName: string;
  canPublish: boolean;
  canMonitor: boolean;
  canDeepCrawl: boolean;
  canLightNotify: boolean;
};

export function usePlatformCapabilities() {
  return useQuery({
    queryKey: ['platforms', 'capabilities'],
    queryFn: () => api.get('/matrix/platforms/capabilities').then((r) => {
      console.log('[DEBUG] capabilities API response:', r.data);
      return r.data;
    }),
  });
}

// ============================================================
// RBAC
// ============================================================

export type RbacUser = {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  status: 'active' | 'disabled';
  lastLoginAt?: string;
  createdAt: string;
};

export function useRbacUsers() {
  return useQuery({
    queryKey: ['rbac', 'users'],
    queryFn: () => api.get('/rbac/users').then((r) => r.data),
  });
}

export function useCreateRbacUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<RbacUser, 'id' | 'createdAt' | 'lastLoginAt'>) =>
      api.post('/rbac/users', input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac'] }),
  });
}

export function useUpdateRbacUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<RbacUser> & { id: number }) =>
      api.put(`/rbac/users/${input.id}`, input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac'] }),
  });
}

export function useDeleteRbacUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/rbac/users/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rbac'] }),
  });
}

// ============================================================
// 通知路由
// ============================================================

export type NotificationChannel = {
  id: string;
  name: string;
  type: 'wechat_work' | 'webhook' | 'email' | 'sms';
  enabled: boolean;
  config: Record<string, string>;
  testStatus?: 'ok' | 'failed' | 'untested';
};

export type NotificationRule = {
  id: string;
  name: string;
  event: 'publish_success' | 'publish_failed' | 'risk_detected' | 'monitor_anomaly' | 'quota_exceeded';
  channelIds: string[];
  threshold?: { count?: number; windowMinutes?: number };
  enabled: boolean;
};

export function useNotificationChannels() {
  return useQuery({
    queryKey: ['notifications', 'channels'],
    queryFn: () => api.get('/notifications/channels').then((r) => r.data),
  });
}

export function useUpdateNotificationChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<NotificationChannel> & { id: string }) =>
      api.put(`/notifications/channels/${input.id}`, input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useNotificationRules() {
  return useQuery({
    queryKey: ['notifications', 'rules'],
    queryFn: () => api.get('/notifications/rules').then((r) => r.data),
  });
}

export function useUpdateNotificationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<NotificationRule> & { id: string }) =>
      api.put(`/notifications/rules/${input.id}`, input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

// ============================================================
// 系统状态（保持原有）
// ============================================================

export function useSystemStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => api.get('/health').then((r) => r.data),
    refetchInterval: 30000,
  });
}

// ============================================================
// 板块一: 基础设施变量 (config-infra)
// ============================================================

export function useInfraConfig() {
  return useQuery({
    queryKey: ['config-infra'],
    queryFn: () => api.get('/config-infra').then((r) => r.data),
  });
}

export function useUpdateInfraConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, string | number>) =>
      api.put('/config-infra', updates).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-infra'] }),
  });
}

// ============================================================
// 板块二+三: LLM 工作组 + 提示词
// ============================================================

export type LLMGroupConfig = { default_model: string; temperature: number; max_tokens: number };
export type LLMPromptTemplate = { name: string; content: string; updatedAt: string };

export function useLLMGroups() {
  return useQuery({
    queryKey: ['llm', 'groups'],
    queryFn: () => api.get('/llm/groups').then((r) => r.data),
  });
}

export function useUpdateLLMGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string } & Partial<LLMGroupConfig>) =>
      api.put(`/llm/groups/${input.name}`, input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llm', 'groups'] }),
  });
}

export function usePrompts() {
  return useQuery({
    queryKey: ['llm', 'prompts'],
    queryFn: () => api.get('/llm/prompts').then((r) => r.data),
  });
}

export function useUpdatePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; content: string }) =>
      api.put(`/llm/prompts/${input.name}`, input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llm', 'prompts'] }),
  });
}

// ============================================================
// 板块四: 智能创作与媒体渲染 (config-media)
// ============================================================

export function useMediaConfig() {
  return useQuery({
    queryKey: ['config-media'],
    queryFn: () => api.get('/config-media').then((r) => r.data),
  });
}

export function useUpdateMediaConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, any>) =>
      api.put('/config-media', updates).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-media'] }),
  });
}

// ============================================================
// 板块五: 自动化矩阵核心 (config-automation)
// ============================================================

// 与后端 `GET /api/v1/config-automation/selectors` 真实返回对齐
// (apps/ts-api-gateway/src/routes/config-automation.ts:67-83)
// 写入侧仍用合并串 categoryKey = `${category}:${name}` 走 URL 路径
export type CustomSelector = {
  platform: string;
  category: string;
  name: string;
  primary: string;
  fallbacks: string[];
  purposes: string[];
  selectorType: string;
  description: string;
  enabled: boolean;
  updatedAt: string;
};

export function useAutomationConfig() {
  return useQuery({
    queryKey: ['config-automation'],
    queryFn: () => api.get('/config-automation').then((r) => r.data),
  });
}

export function useUpdateAutomationConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, any>) =>
      api.put('/config-automation', updates).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-automation'] }),
  });
}

export function useCustomSelectors(platform?: string) {
  return useQuery({
    queryKey: ['config-automation', 'selectors', platform],
    queryFn: () => api.get('/config-automation/selectors' + (platform ? `?platform=${platform}` : '')).then((r) => r.data),
  });
}

// v2.1+ 流程规则 (per-platform) — 含 scopeSelectors / disabled 检测方法 / URL 模式 等
export function useFlowRules() {
  return useQuery({
    queryKey: ['config-automation', 'flow-rules'],
    queryFn: () => api.get('/config-automation/selectors/flow-rules').then((r) => r.data),
  });
}

export function useUpdateFlowRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; flowRules: any }) =>
      api.put('/config-automation/selectors/flow-rules', { platform: input.platform, flowRules: input.flowRules }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'flow-rules'] });
    },
  });
}

export function useResetFlowRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string }) =>
      api.put('/config-automation/selectors/flow-rules', { platform: input.platform, reset: true }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'flow-rules'] });
    },
  });
}

export function useUpsertCustomSelector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; categoryKey: string; selector_value: string; originalPlatform?: string; originalCategoryKey?: string }) =>
      api.put(`/config-automation/selectors/${input.platform}/${input.categoryKey}`, {
        selector_value: input.selector_value,
        ...(input.originalPlatform ? { originalPlatform: input.originalPlatform } : {}),
        ...(input.originalCategoryKey ? { originalCategoryKey: input.originalCategoryKey } : {}),
      }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'selectors'] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useDeleteCustomSelector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; categoryKey: string }) =>
      api.delete(`/config-automation/selectors/${input.platform}/${input.categoryKey}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'selectors'] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

// ============================================================
// URL 监控配置 (v2.4+)
// ============================================================

export function useUrlMonitors() {
  return useQuery({
    queryKey: ['config-automation', 'url-monitors'],
    queryFn: () => api.get('/config-automation/selectors/url-monitors').then((r) => r.data),
  });
}

export function useUpsertUrlMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; name: string; entry: UrlMonitorEntry }) =>
      api.put(`/config-automation/selectors/url-monitors/${input.platform}/${input.name}`, { entry: input.entry }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'url-monitors'] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useDeleteUrlMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; name: string }) =>
      api.delete(`/config-automation/selectors/url-monitors/${input.platform}/${input.name}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'url-monitors'] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useUpdateUrlMonitors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; urlMonitors: Record<string, UrlMonitorEntry> | null; reset?: boolean }) =>
      api.put('/config-automation/selectors/url-monitors', input).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'url-monitors'] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

// ============================================================
// Frameworks (v2.5+)
// ============================================================

export function useFrameworks(platform: string | null) {
  return useQuery({
    queryKey: ['config-automation', 'frameworks', platform],
    queryFn: () => api.get(`/config-automation/frameworks/${platform}`).then((r) => r.data),
    enabled: !!platform,
  });
}

export function useUpsertFramework() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; key: string; entry: FrameworkEntry }) =>
      api.put(`/config-automation/frameworks/${input.platform}/${input.key}`, input.entry).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'frameworks', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useDeleteFramework() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; key: string }) =>
      api.delete(`/config-automation/frameworks/${input.platform}/${input.key}`).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'frameworks', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

// ============================================================
// API Patterns (v2.5+)
// ============================================================

export function useApiPatterns(platform: string | null) {
  return useQuery({
    queryKey: ['config-automation', 'api-patterns', platform],
    queryFn: () => api.get(`/config-automation/api-patterns/${platform}`).then((r) => r.data),
    enabled: !!platform,
  });
}

export function useUpsertApiPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; key: string; entry: ApiPatternEntry }) =>
      api.put(`/config-automation/api-patterns/${input.platform}/${input.key}`, input.entry).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'api-patterns', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useDeleteApiPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; key: string }) =>
      api.delete(`/config-automation/api-patterns/${input.platform}/${input.key}`).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'api-patterns', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

// ============================================================
// Data Sources (v2.5+)
// ============================================================

export function useDataSources(platform: string | null) {
  return useQuery({
    queryKey: ['config-automation', 'data-sources', platform],
    queryFn: () => api.get(`/config-automation/data-sources/${platform}`).then((r) => r.data),
    enabled: !!platform,
  });
}

export function useUpsertDataSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; key: string; entry: DataSourceEntry }) =>
      api.put(`/config-automation/data-sources/${input.platform}/${input.key}`, input.entry).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'data-sources', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useDeleteDataSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; key: string }) =>
      api.delete(`/config-automation/data-sources/${input.platform}/${input.key}`).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'data-sources', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

// ============================================================
// Navigation Flows (v2.5+)
// ============================================================

export function useNavigationFlows(platform: string | null) {
  return useQuery({
    queryKey: ['config-automation', 'navigation-flows', platform],
    queryFn: () => api.get(`/config-automation/navigation-flows/${platform}`).then((r) => r.data),
    enabled: !!platform,
  });
}

export function useUpsertNavigationFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; flowName: string; entry: NavigationFlowEntry }) =>
      api.put(`/config-automation/navigation-flows/${input.platform}/${input.flowName}`, input.entry).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'navigation-flows', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useDeleteNavigationFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { platform: string; flowName: string }) =>
      api.delete(`/config-automation/navigation-flows/${input.platform}/${input.flowName}`).then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['config-automation', 'navigation-flows', variables.platform] });
      qc.invalidateQueries({ queryKey: ['selectors', 'config'] });
    },
  });
}

export function useFlowLastRun(platform: string | null, flowName: string | null) {
  return useQuery({
    queryKey: ['config-automation', 'navigation-flows', platform, flowName, 'last-run'],
    queryFn: () => api.get(`/config-automation/navigation-flows/${platform}/${flowName}/last-run`).then((r) => r.data),
    enabled: !!platform && !!flowName,
  });
}

// ============================================================
// 板块六: 网络路由与物理代理 (config-network)
// ============================================================

export function useNetworkConfig() {
  return useQuery({
    queryKey: ['config-network'],
    queryFn: () => api.get('/config-network').then((r) => r.data),
  });
}

export function useUpdateNetworkConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, any>) =>
      api.put('/config-network', updates).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config-network'] }),
  });
}

// ============================================================
// 板块七: 企业微信通知路由 (notifications/wecom)
// ============================================================

export type WecomConfig = { bot_id: string; bot_secret: string; global_chat_id: string; account_chat_mapping: Record<string, string> };

export function useWecomConfig() {
  return useQuery({
    queryKey: ['notifications', 'wecom'],
    queryFn: () => api.get('/notifications/wecom').then((r) => r.data),
  });
}

export function useUpdateWecomConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: Partial<WecomConfig>) =>
      api.put('/notifications/wecom', updates).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications', 'wecom'] }),
  });
}

// ============================================================
// 板块八: 安全密钥 (security/api-key)
// ============================================================

export function useSecurityApiKey() {
  return useQuery({
    queryKey: ['security', 'api-key'],
    queryFn: () => api.get('/security/api-key').then((r) => r.data),
  });
}

export function useRotateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (newKey: string) =>
      api.put('/security/api-key', { newKey }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['security', 'api-key'] }),
  });
}

// ============================================================
// 素材更新
// ============================================================

export function useMaterials(params?: {
  page?: number;
  pageSize?: number;
  style?: string;
  room?: string;
  quality?: string;
  source?: string;
}) {
  return useQuery({
    queryKey: ['materials', params],
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params?.style) searchParams.set('style', params.style);
      if (params?.room) searchParams.set('room', params.room);
      if (params?.quality) searchParams.set('quality', params.quality);
      if (params?.source) searchParams.set('source', params.source);
      return api.get(`/materials?${searchParams.toString()}`).then((r) => r.data);
    },
  });
}

export function useMaterialStats() {
  return useQuery({
    queryKey: ['materials', 'stats'],
    queryFn: () => api.get('/materials/stats').then((r) => r.data),
  });
}

export function useDeleteMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/materials/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['materials'] }),
  });
}

export function useMatrixBgms() {
  return useQuery({
    queryKey: ['matrix', 'bgm'],
    queryFn: () => api.get('/matrix/bgm').then((r) => r.data),
  });
}

export function useCheckAccountLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      api.post('/matrix/accounts/check-login', { accountId }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matrix', 'accounts'] }),
  });
}

// ============================================================
// 操作员管理 (operators)
// ============================================================

export type Operator = {
  id: number;
  wechatUserId: string;
  displayName: string;
  phone?: string;
  role: 'admin' | 'operator';
  enabled: boolean;
  windows: Array<{
    id: number;
    externalId: string;
    browserVendor: string;
    windowName: string;
    platforms: Array<{ id: number; platform: string; loginStatus: string; lastVerifiedAt?: string; monitoringEnabled: boolean }>;
  }>;
  // 派生字段：所有窗口平台账号的并集，供发布矩阵等"操作员×平台"视图使用。
  // 主从面板等需要按窗口区分的场景请用 windows[].platforms。
  platforms: Array<{ platform: string; loginStatus: string; lastVerifiedAt?: string }>;
  createdAt: string;
};

export type BrowserWindowItem = {
  id: number;
  externalId: string;
  browserVendor: string;
  windowName: string;
  workspaceId?: string;
  status: string;
  boundOperatorId?: number;
  operator?: { id: number; wechatUserId: string; displayName: string };
  syncedAt: string;
};

export function useOperators() {
  return useQuery<Operator[]>({
    queryKey: ['operators'],
    queryFn: () =>
      api.get('/operators').then((r) => {
        // 后端返回 operator→windows[]→platforms[] 三级嵌套（无顶层 platforms）。
        // 派生顶层 platforms（所有窗口平台并集）供发布矩阵等视图使用。
        const ops = r.data?.data ?? r.data ?? [];
        return (Array.isArray(ops) ? ops : []).map((op: any) => ({
          ...op,
          platforms: (op.windows ?? []).flatMap((w: any) => w.platforms ?? []),
        })) as Operator[];
      }),
  });
}

export function useCreateOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { wechatUserId: string; displayName: string; phone?: string }) =>
      api.post('/operators', data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators'] }),
  });
}

export function useUpdateOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: number; wechatUserId?: string; displayName?: string; phone?: string; enabled?: boolean }) =>
      api.put(`/operators/${data.id}`, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators'] }),
  });
}

export function useDeleteOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/operators/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators'] }),
  });
}

export function useBrowserWindows(status?: string) {
  return useQuery({
    queryKey: ['operators', 'windows', status],
    queryFn: () => {
      const params = status && status !== 'all' ? `?status=${status}` : '';
      return api.get(`/operators/windows${params}`).then((r) => r.data) as Promise<{ windows: BrowserWindowItem[]; limits: any }>;
    },
  });
}

export function useSyncWindows() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vendor: string) =>
      api.post('/operators/windows/sync', { vendor }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators', 'windows'] }),
  });
}

export function useCreateWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { vendor: string; name: string; platform?: string; proxy?: any }) =>
      api.post('/operators/windows/create', data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators', 'windows'] }),
  });
}

export function useBindWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { windowId: number; operatorId: number }) =>
      api.post(`/operators/windows/${data.windowId}/bind`, { operatorId: data.operatorId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operators', 'windows'] });
      qc.invalidateQueries({ queryKey: ['operators'] });
    },
  });
}

export function useUnbindWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (windowId: number) =>
      api.post(`/operators/windows/${windowId}/unbind`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operators', 'windows'] });
      qc.invalidateQueries({ queryKey: ['operators'] });
    },
  });
}

export function useAddPlatform() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { operatorId: number; platform: string }) =>
      api.post(`/operators/${data.operatorId}/platforms`, { platform: data.platform }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators'] }),
  });
}

export function useRemovePlatform() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { operatorId: number; platform: string }) =>
      api.delete(`/operators/${data.operatorId}/platforms/${data.platform}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators'] }),
  });
}

export function useVerifyLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { operatorId: number; platform: string }) =>
      api.post(`/operators/${data.operatorId}/verify-login`, { platform: data.platform }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operators'] }),
  });
}

// ============================================================
// 企业微信机器人 (wecom-bot)
// ============================================================

export function useWecomBotStatus() {
  return useQuery({
    queryKey: ['wecom-bot', 'status'],
    queryFn: () => api.get('/wecom-bot/status').then((r) => r.data),
    refetchInterval: 10_000,
  });
}

export function useStartWecomBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { botId: string; secret: string }) =>
      api.post('/wecom-bot/start', data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wecom-bot'] }),
  });
}

export function useStopWecomBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/wecom-bot/stop').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wecom-bot'] }),
  });
}

export function useCreateLinkRequest() {
  return useMutation({
    mutationFn: (data: { timeoutMs?: number; sendTo?: string }) =>
      api.post('/wecom-bot/link-request', data).then((r) => r.data),
  });
}

export function usePollLinkResult(code: string, enabled = true) {
  return useQuery({
    queryKey: ['wecom-bot', 'link-result', code],
    queryFn: () => api.get(`/wecom-bot/link-result/${code}`).then((r) => r.data),
    enabled: enabled && !!code,
    refetchInterval: 3_000,
  });
}

export function useSendWecomMessage() {
  return useMutation({
    mutationFn: (data: { userids: string[]; content: string }) =>
      api.post('/wecom-bot/send', data).then((r) => r.data),
  });
}

// ============================================================
// 选择器配置 & 有效性追踪
// ============================================================

export type SelectorEntry = {
  purposes: string[];
  primary: string;
  fallbacks: string[];
  selectorType: string;
  description?: string;
  parent?: string;
  expandCheckCss?: string;
  enabled?: boolean;
  filterTag?: string;
  filterText?: string;
  scopeKey?: string;
};

export type PlatformSelectors = {
  menus: Record<string, SelectorEntry>;
  buttons: Record<string, SelectorEntry>;
  regions: Record<string, SelectorEntry>;
  textboxes: Record<string, SelectorEntry>;
  flowRules?: Record<string, unknown>;
  urlMonitors?: Record<string, UrlMonitorEntry>;
  apiPatterns?: Record<string, any>;
  dataSources?: Record<string, any>;
  navigationFlows?: Record<string, any>;
  frameworks?: Record<string, any>;
};

export type ResponseExtraction = {
  itemsPath: string;
  idField: string;
  fieldMap?: Record<string, string>;
};

export type PaginationRule = {
  hasMorePath?: string;
  hasMoreValue?: unknown;
  hasMoreFalseValue?: unknown;
  cursorPath?: string;
  cursorParamName?: string;
};

export type UrlMonitorEntry = {
  enabled: boolean;
  description?: string;
  tags?: string[];
  urlPatterns: string[];
  method: 'GET' | 'POST';
  extraction: ResponseExtraction;
  pagination?: PaginationRule;
  flowPhase?: string;
  validation?: {
    expectedPageUrls?: string[];
    requiredItemFields?: string[];
    minItems?: number;
    requiredUrlParams?: string[];
  };
};

// ============================================================
// v2.5+ 类型定义
// ============================================================

export type SelectorType = 'css' | 'role' | 'text' | 'xpath';

export type ScopeMode = 'none' | 'framework' | 'custom';

export type ScopedSelector = {
  type: SelectorType;
  value: string;
  scopeMode?: ScopeMode;
  frameworkKey?: string;
  subContainer?: string;
  customContainer?: string;
  filterTag?: string;
  filterText?: string;
};

export type FlowSelectorConfig = {
  primary: ScopedSelector;
  fallbacks: ScopedSelector[];
};

export type StepAction =
  | 'check_url' | 'check_menu_state' | 'click_menu' | 'click_tab'
  | 'click_button' | 'enable_interceptor' | 'disable_interceptor'
  | 'refresh_page' | 'wait_for_response' | 'check_quantity'
  | 'scroll_load' | 'page_turn' | 'close_menu' | 'done';

export type FlowBranch = {
  condition: string;
  target: string;
  description: string;
};

export type SubStepAction =
  | 'resolve_selector' | 'resolve_fallback_selector'
  | 'mouse_move' | 'mouse_click' | 'cdp_click' | 'cdp_click_node'
  | 'wait_for_element' | 'check_element_exists'
  | 'navigate' | 'refresh_page' | 'scroll' | 'wait_for_response'
  | 'check_navigation' | 'check_url' | 'check_login' | 'check_risk';

export type FlowSubStep = {
  id: string;
  action: SubStepAction;
  description: string;
  selector?: FlowSelectorConfig;
};

export type FlowNode = {
  id: string;
  action: StepAction;
  description: string;
  selector?: FlowSelectorConfig;
  apiPatternKey?: string;
  waitFor?: {
    attribute?: { name: string; value: string; timeout: number };
    urlContains?: string;
    apiResponse?: string;
    timeout: number;
  };
  branches?: FlowBranch[];
  next?: string;
  maxVideos?: number;
  scrollConfig?: { maxScrolls: number; scrollDelta: number };
  nextPageBtn?: { css?: string; xpath?: string; text?: string };
  steps?: FlowSubStep[];
};

export type NavigationFlowEntry = {
  label: string;
  steps: FlowNode[];
};

export type FrameworkEntry = {
  label: string;
  key: string;
  selector: string;
  description?: string;
};

export type LastRunStep = {
  stepIndex: number;
  label: string;
  status: string;
  durationMs?: number;
  selectorTries?: any;
  mouseAction?: string;
  extra?: any;
};

export type ApiPatternEntry = {
  pattern: string;
  description?: string;
  responseArrayPath?: string[];
  hasMoreField?: string;
  hasMoreCondition?: string;
  cursorField?: string;
  fieldMappings?: Record<string, string[]>;
};

export type DataSourceEntry = {
  label: string;
  pageUrl: string;
  apiPatternKey: string;
  pagination: { type: 'scroll' | 'page'; [key: string]: any };
  privateFilter?: { enabled: boolean; field: string; condition: string; dynamicRemove?: boolean };
  responseArrayPath?: string[];
  hasMoreField?: string;
  hasMoreCondition?: string;
  cursorField?: string;
};

export type SelectorConfig = {
  version: string;
  updatedAt: string;
  platforms: Record<string, PlatformSelectors>;
};

export type SelectorEffectivenessStats = {
  platform: string;
  category: string;
  name: string;
  strategy: string;
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  lastUsedAt: number;
  lastSuccessAt: number;
  lastFailureAt: number;
};

export function useSelectorConfig() {
  return useQuery({
    queryKey: ['selectors', 'config'],
    queryFn: () =>
      api.get('/config-automation/selectors/full').then((r) => r.data as SelectorConfig),
    staleTime: 30_000,
  });
}

export function useSelectorEffectiveness(platform?: string) {
  return useQuery({
    queryKey: ['selectors', 'effectiveness', platform],
    queryFn: () =>
      api.get('/config-automation/selectors/effectiveness', {
        params: platform ? { platform } : undefined,
      }).then((r) => {
        const d = r.data as { stats: SelectorEffectivenessStats[]; failed: SelectorEffectivenessStats[] };
        return { stats: d.stats, failed: d.failed };
      }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useFailedSelectors(threshold = 0.3, minAttempts = 5) {
  return useQuery({
    queryKey: ['selectors', 'failed', threshold, minAttempts],
    queryFn: () =>
      api.get('/config-automation/selectors/effectiveness', {
        params: { threshold, minAttempts },
      }).then((r) => {
        const d = r.data as { stats: SelectorEffectivenessStats[]; failed: SelectorEffectivenessStats[] };
        return d.failed;
      }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useUpsertSelector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      platform: string;
      category: string;
      name: string;
      entry: SelectorEntry;
    }) => api.put('/config-automation/selectors', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['selectors'] });
      qc.invalidateQueries({ queryKey: ['config-automation', 'selectors'] });
    },
  });
}

export function useDeleteSelector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { platform: string; category: string; name: string }) =>
      api.delete('/config-automation/selectors', { data }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['selectors'] });
      qc.invalidateQueries({ queryKey: ['config-automation', 'selectors'] });
    },
  });
}

// ============================================================
// 调试模式开关
// ============================================================

export function useDebugMode() {
  return useQuery({
    queryKey: ['debug-mode'],
    queryFn: () => api.get('/system/debug-mode').then((r) => r.data),
    refetchInterval: 30000,
  });
}

export function useUpdateDebugMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put('/system/debug-mode', { enabled }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['debug-mode'] }),
  });
}

// ============================================================
// 执行队列
// ============================================================

import type {
  ActiveQueueData,
  HistoryData,
  ExecutionDetail,
} from '../types/queue';

export function useActiveQueueTasks() {
  return useQuery<ActiveQueueData>({
    queryKey: ['queue', 'active'],
    queryFn: () =>
      api.get('/matrix/queue/active').then((r) => r.data as ActiveQueueData),
    refetchInterval: 3000,
    retry: 2,
    staleTime: 1000,
  });
}

export function useQueueHistory(params?: { page?: number; limit?: number; taskType?: string; status?: string; windowId?: string }) {
  return useQuery<HistoryData>({
    queryKey: ['queue', 'history', params],
    queryFn: () =>
      api.get('/matrix/queue/history', { params }).then((r) => r.data as HistoryData),
    retry: 2,
  });
}

export function useExecutionDetail(id: string | null) {
  return useQuery<ExecutionDetail>({
    queryKey: ['queue', 'execution', id],
    queryFn: () =>
      api.get(`/matrix/queue/executions/${id}`).then((r) => r.data as ExecutionDetail),
    enabled: !!id,
    retry: 1,
  });
}

export function useClearQueueHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/matrix/queue/history').then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue', 'history'] });
      qc.invalidateQueries({ queryKey: ['queue', 'active'] });
    },
  });
}

// ============================================================
// AI 回复评论配置
// ============================================================

export function useAiReplyConfig() {
  return useQuery({
    queryKey: ['ai-reply-config'],
    queryFn: async () => {
      const res = await api.get('/api/v1/config-ai-reply');
      return res.data.data as { model: string; systemPrompt: string; temperature: number; maxTokens: number; };
    },
  });
}

export function useUpdateAiReplyConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: Partial<{ model: string; systemPrompt: string; temperature: number; maxTokens: number; }>) => {
      const res = await api.put('/api/v1/config-ai-reply', cfg);
      return res.data.data;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-reply-config'] }); },
  });
}
