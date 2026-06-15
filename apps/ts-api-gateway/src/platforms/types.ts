// @ts-api-gateway/platforms/types.ts - 发布器通用类型

import type { PlatformName } from '@social-media/shared-config';
import type { Page } from 'patchright';

/** 发布任务载荷 */
export interface PublishTask {
  taskId: string;
  traceId: string;
  platform: PlatformName;
  windowId: string;
  accountId: string;
  credentials: AccountCredentials;
  video: VideoPayload;
  metadata: VideoMetadata;
}

/** 账号凭证 */
export interface AccountCredentials {
  username: string;
  cookies?: Record<string, string>;
  phone?: string;
}

/** 视频载荷（OSS URL） */
export interface VideoPayload {
  ossUrl: string;
  filename: string;
  size: number;
  duration?: number;
}

/** 视频元数据 */
export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  coverUrl?: string;
  scheduleTime?: string; // ISO datetime
  isOriginal?: boolean;
  category?: string;
}

/** 发布结果 */
export interface PublishResult {
  success: boolean;
  taskId: string;
  platform: PlatformName;
  videoUrl?: string;
  error?: string;
  duration: number; // ms
}

/** 发布器状态 */
export type PublisherState = 'idle' | 'logging_in' | 'uploading' | 'publishing' | 'completed' | 'error';

/** 平台登录凭据上下文 */
export interface LoginContext {
  page: Page;
  credentials: AccountCredentials;
  windowId: string;
  accountId?: string; // 用户 ID，用于查询企微推送目标
}

/** 平台上传上下文 */
export interface UploadContext {
  page: Page;
  videoPath: string;
  metadata: VideoMetadata;
  videoPayload: VideoPayload;
}
