// @ts-api-gateway/lib/oss.ts - 阿里云 OSS 客户端

import OSS from 'ali-oss';
import { getConfig } from '@social-media/shared-config';
import { createLogger } from './logger';

const logger = createLogger('oss');

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
    });
  }
  return ossClient;
}

/**
 * 生成 OSS 上传路径
 */
export function ossKey(prefix: string, filename: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}/${date}/${filename}`;
}

/**
 * 获取 OSS 公开访问 URL
 */
export function ossUrl(key: string): string {
  const config = getConfig();
  return `https://${config.OSS_ENDPOINT}/${key}`;
}

/**
 * 上传本地文件到 OSS
 */
export async function uploadToOSS(
  localPath: string,
  ossPath: string,
): Promise<string> {
  const client = getOSSClient();
  const result = await client.put(ossPath, localPath);
  const url = ossUrl(ossPath);
  logger.info(`OSS 上传成功: ${localPath} → ${url}`);
  return url;
}
