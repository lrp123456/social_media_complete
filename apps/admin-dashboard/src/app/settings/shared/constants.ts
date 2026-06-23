export const INFRA_KEYS = ['DB_HOST', 'DATABASE_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'LITELLM_MASTER_KEY', 'LITELLM_BASE_URL', 'WEB_PORT', 'DATA_DIR', 'LOG_LEVEL', 'ROXY_BROWSER_URL', 'BIT_BROWSER_URL'];
export const GROUP_ORDER = ['video', 'image', 'text'];
export const FFMPEG_FIELDS = [
  { key: 'res_width', label: '分辨率宽度', type: 'number' },
  { key: 'res_height', label: '分辨率高度', type: 'number' },
  { key: 'fps', label: '帧率', type: 'number' },
  { key: 'pixel_format', label: '像素格式', type: 'text' },
  { key: 'video_codec', label: '视频编码器', type: 'text' },
  { key: 'audio_codec', label: '音频编码器', type: 'text' },
];
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i));
export const MONITOR_FIELDS = [
  { key: 'interval_active_min', label: '高频周期最小值 (秒)', type: 'number' },
  { key: 'interval_active_max', label: '高频周期最大值 (秒)', type: 'number' },
  { key: 'interval_idle_min', label: '空闲周期最小值 (秒)', type: 'number' },
  { key: 'interval_idle_max', label: '空闲周期最大值 (秒)', type: 'number' },
  { key: 'idle_threshold', label: '空闲阈值', type: 'number' },
  { key: 'sleep_start_hour', label: '休眠开始时间 (时)', type: 'select' },
  { key: 'sleep_end_hour', label: '休眠结束时间 (时)', type: 'select' },
];
export const BROWSER_FIELDS = [
  { key: 'max_tab_reuse', label: '最大标签复用次数', type: 'number' },
  { key: 'enable_warmup', label: '启用预热', type: 'toggle' },
];
export const RAPIDAPI_PRESEED = ['xiaohongshu', 'tiktok', 'instagram'];
export const HOSTS_PRESEED = ['xiaohongshu', 'tiktok'];
