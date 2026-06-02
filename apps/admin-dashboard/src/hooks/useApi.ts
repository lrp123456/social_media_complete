import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';

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
    mutationFn: (data: any) => api.post('/publish/video', data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publish'] }),
  });
}

// ============================================================
// Pinterest 采集
// ============================================================

export function usePinterestScrape() {
  return useMutation({
    mutationFn: (data: { query: string; maxPins: number; windowId: string }) =>
      api.post('/pinterest/scrape', data).then((r) => r.data),
  });
}

// ============================================================
// 素材更新
// ============================================================

export function useMaterialUpdate() {
  return useMutation({
    mutationFn: (data: { oss_urls: string[]; platform: string; userId?: string }) =>
      api.post('/tasks/material-update', {
        task_id: `mat_${Date.now()}`,
        oss_urls: data.oss_urls,
        platform: data.platform,
        user_id: data.userId,
      }).then((r) => r.data),
  });
}

// ============================================================
// 系统状态
// ============================================================

export function useSystemStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => api.get('/health').then((r) => r.data),
    refetchInterval: 30000,
  });
}
