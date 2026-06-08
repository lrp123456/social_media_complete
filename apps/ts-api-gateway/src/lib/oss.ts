// @ts-api-gateway/lib/oss.ts - 阿里云 OSS 客户端
// 根目录: oss://naite-mes/workflow/all/
// 使用自定义域名 img.naite.cc 公网访问

import OSS from 'ali-oss';
import { getConfig } from '@social-media/shared-config';
import { createLogger } from './logger';

const logger = createLogger('oss');

// ============================================================
// 业务目录常量（根目录 workflow/all/ 下按业务划分子目录）
// ============================================================

/** OSS 根路径，所有业务文件存储于此下 */
export const OSS_ROOT = 'workflow/all';

/** 业务子目录 */
export const OSS_DIRS = {
  /** 发布视频 */
  videos: `${OSS_ROOT}/videos`,
  /** 素材图片（Pinterest、缩略图等） */
  images: `${OSS_ROOT}/images`,
  /** 截图（验证、风控、调试） */
  screenshots: `${OSS_ROOT}/screenshots`,
  /** 临时文件（上传中转，短期删除） */
  temp: `${OSS_ROOT}/temp`,
} as const;

// ============================================================
// OSS 客户端（单例）
// ============================================================

let ossClient: OSS | null = null;

export function getOSSClient(): OSS {
  if (!ossClient) {
    const config = getConfig();
    ossClient = new OSS({
      region: config.OSS_REGION,
      bucket: config.OSS_BUCKET,
      endpoint: config.OSS_ENDPOINT,
      accessKeyId: config.OSS_ACCESS_KEY_ID,
      accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
      cname: true,           // 自定义域名模式
      authorizationV4: true, // V4 签名（2025年起新用户必选）
    });
    logger.info('OSS 客户端初始化完成 (V4签名 + CNAME)');
  }
  return ossClient;
}

// ============================================================
// 路径工具
// ============================================================

/**
 * 生成 OSS 存储路径（自动按日期分目录）
 * @param dir 业务目录，推荐使用 OSS_DIRS 常量
 * @param filename 文件名
 * @returns 完整 OSS key，如 workflow/all/videos/20260603/video.mp4
 */
export function ossKey(dir: string, filename: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${dir}/${date}/${filename}`;
}

/**
 * 获取 OSS 公网访问 URL
 */
export function ossUrl(key: string): string {
  const config = getConfig();
  return `https://${config.OSS_ENDPOINT}/${key}`;
}

// ============================================================
// 上传 API
// ============================================================

/** 上传结果 */
export interface UploadResult {
  ossUrl: string;
  key: string;
  size?: number;
}

/**
 * 上传本地文件到 OSS
 * @returns 公网访问 URL
 */
export async function uploadToOSS(
  localPath: string,
  ossPath: string,
): Promise<string> {
  const client = getOSSClient();
  await client.put(ossPath, localPath);
  const url = ossUrl(ossPath);
  logger.info({ localPath, ossPath, url }, 'OSS 文件上传成功');
  return url;
}

/**
 * 上传 Buffer 到 OSS
 * @returns 公网访问 URL
 */
export async function uploadBufferToOSS(
  buffer: Buffer,
  ossPath: string,
  options?: { mime?: string },
): Promise<UploadResult> {
  const client = getOSSClient();
  const headers: Record<string, string> = {};
  if (options?.mime) headers['Content-Type'] = options.mime;

  const result = await client.put(ossPath, buffer, { headers });
  const url = ossUrl(ossPath);
  logger.info({ ossPath, url, size: buffer.length }, 'OSS Buffer 上传成功');
  return { ossUrl: url, key: ossPath, size: buffer.length };
}

/**
 * 上传 Base64 字符串到 OSS（自动解码）
 * - 适用于: 截图、缩略图、小文件（节省 HTTP 传输体积 vs 二进制）
 * - 不支持: 大视频（Base64 膨胀 33%，不适合）
 * @param base64Data Base64 编码数据（可带或不带 data:xxx;base64, 前缀）
 * @param ossPath OSS 存储路径
 * @param mime MIME 类型（当 base64Data 不含前缀时必须指定）
 */
export async function uploadBase64ToOSS(
  base64Data: string,
  ossPath: string,
  mime?: string,
): Promise<UploadResult> {
  // 解析 data URL 前缀，如 "data:image/png;base64,xxxxx"
  let decoded: Buffer;
  let detectedMime = mime;

  const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    detectedMime = detectedMime || dataUrlMatch[1];
    decoded = Buffer.from(dataUrlMatch[2], 'base64');
  } else {
    decoded = Buffer.from(base64Data, 'base64');
  }

  return uploadBufferToOSS(decoded, ossPath, { mime: detectedMime });
}

// ============================================================
// 初始化
// ============================================================

// 启动时验证 OSS 连接
getOSSClient();
