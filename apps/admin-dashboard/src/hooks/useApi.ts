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
