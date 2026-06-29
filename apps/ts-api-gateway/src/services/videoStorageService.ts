// videoStorageService.ts — 视频文件下载、归档、清理
// 流式下载：Node http/https 模块 + fs.createWriteStream，避免大视频撑爆内存
// 安全：videoId 白名单校验 + path.resolve 二次验证，防止路径遍历攻击
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { logger } from '../lib/logger';

// ============================================================
// 公开 API
// ============================================================

/**
 * 下载视频文件到 _pending 目录。
 * @param videoUrl 视频源 URL（公开 URL，不支持鉴权）
 * @param rootPath 存储根路径（如 /data/videos）
 * @param platformId 平台 ID（仅字母数字下划线短横线）
 * @param videoId 视频 ID（仅字母数字下划线短横线，长度 ≤ 64）
 * @returns 相对路径（如 `tiktok/_pending/2026-06-29/abc123.mp4`）
 * @throws 下载失败或路径遍历检测时抛错
 */
export async function downloadVideo(
  videoUrl: string,
  rootPath: string,
  platformId: string,
  videoId: string,
): Promise<string> {
  // B2 安全修复：videoId 白名单校验，防止路径遍历攻击
  const safeVideoId = sanitizeVideoId(videoId);
  const safePlatformId = sanitizeVideoId(platformId);

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(rootPath, safePlatformId, '_pending', date);
  await fs.promises.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${safeVideoId}.mp4`);
  const relativePath = path.join(safePlatformId, '_pending', date, `${safeVideoId}.mp4`);

  // 二次验证：确保路径未逃逸根目录
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootPath);
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error(`路径遍历检测：${videoId} 导致路径逃逸 ${rootPath}`);
  }

  await downloadWithRetry(videoUrl, filePath, 2);
  return relativePath;
}

/**
 * 将文件从 _pending 目录移动到正式归档目录。
 * @param pendingPath 相对路径（如 `tiktok/_pending/2026-06-29/abc123.mp4`）
 * @param rootPath 存储根路径
 * @param platformId 平台 ID
 * @param styleDir 风格目录（如 `口播`）
 * @returns 新相对路径
 */
export async function archiveVideo(
  pendingPath: string,
  rootPath: string,
  platformId: string,
  styleDir: string,
): Promise<string> {
  const safePlatformId = sanitizeVideoId(platformId);
  const safeStyleDir = sanitizeStyleDir(styleDir);

  const date = new Date().toISOString().slice(0, 10);
  const destDir = path.join(rootPath, safePlatformId, safeStyleDir, date);
  await fs.promises.mkdir(destDir, { recursive: true });

  const fileName = path.basename(pendingPath);
  const srcPath = path.join(rootPath, pendingPath);
  const destPath = path.join(destDir, fileName);
  const relativePath = path.join(safePlatformId, safeStyleDir, date, fileName);

  // 二次验证
  const resolvedDest = path.resolve(destPath);
  const resolvedRoot = path.resolve(rootPath);
  if (!resolvedDest.startsWith(resolvedRoot)) {
    throw new Error(`路径遍历检测：归档路径逃逸 ${rootPath}`);
  }

  await fs.promises.rename(srcPath, destPath);
  logger.info(`[videoStorage] 归档: ${pendingPath} → ${relativePath}`);
  return relativePath;
}

/**
 * 删除 pending 文件。
 */
export async function deletePending(pendingPath: string, rootPath: string): Promise<void> {
  const filePath = path.join(rootPath, pendingPath);
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootPath);
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error(`路径遍历检测：删除路径逃逸 ${rootPath}`);
  }

  try {
    await fs.promises.unlink(filePath);
    logger.info(`[videoStorage] 删除 pending 文件: ${pendingPath}`);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      logger.warn(`[videoStorage] 文件已不存在: ${pendingPath}`);
      return;
    }
    throw err;
  }
}

/**
 * 获取磁盘使用量（按 rootPath 统计）。
 */
export async function getDiskUsage(rootPath: string): Promise<{ usedBytes: number; usedHuman: string }> {
  const resolvedRoot = path.resolve(rootPath);
  let totalSize = 0;

  try {
    await fs.promises.access(resolvedRoot);
  } catch {
    return { usedBytes: 0, usedHuman: '0B' };
  }

  async function walkDir(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          totalSize += stat.size;
        } catch {
          // 跳过无法读取的文件
        }
      }
    }
  }

  await walkDir(resolvedRoot);
  return { usedBytes: totalSize, usedHuman: formatBytes(totalSize) };
}

// ============================================================
// 内部辅助
// ============================================================

/** 重试下载：失败重试 maxRetries 次，间隔 1s，最终失败抛错 */
async function downloadWithRetry(url: string, dest: string, maxRetries: number): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await streamDownload(url, dest);
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        logger.error(`[videoStorage] 下载失败已重试 ${maxRetries} 次: ${url} - ${err}`);
        throw err;
      }
      logger.warn(`[videoStorage] 下载失败(第${attempt + 1}次): ${url} - ${err}，1s 后重试`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

/** 流式下载（支持 302 重定向跟随） */
function streamDownload(url: string, dest: string, maxRedirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);

    file.on('error', (err) => {
      reject(err);
    });

    client.get(url, (response) => {
      // 处理 301/302/307/308 重定向（视频 CDN 常用）
      if ([301, 302, 307, 308].includes(response.statusCode!) && response.headers.location) {
        response.resume(); // 释放当前响应
        file.close();
        fs.unlink(dest, () => {
          if (maxRedirects <= 0) {
            reject(new Error('重定向次数过多'));
            return;
          }
          streamDownload(response.headers.location!, dest, maxRedirects - 1).then(resolve).catch(reject);
        });
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        file.close();
        fs.unlink(dest, () => {
          reject(new Error(`HTTP ${response.statusCode}`));
        });
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });

      response.on('error', (err) => {
        file.close();
        fs.unlink(dest, () => {
          reject(err);
        });
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {
        reject(err);
      });
    });
  });
}

/** videoId/platformId 白名单校验：仅允许字母、数字、下划线、短横线，长度 ≤ 64 */
export function sanitizeVideoId(id: string): string {
  if (!id || id.length > 64) {
    throw new Error(`无效 ID: 长度超限或为空`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`无效 ID: 包含非法字符: ${id}`);
  }
  return id;
}

/** styleDir 白名单校验：仅允许字母、数字、中文、下划线、短横线 */
function sanitizeStyleDir(dir: string): string {
  if (!dir || dir.length > 64) {
    throw new Error(`无效风格目录: 长度超限或为空`);
  }
  // 允许中文字符、字母、数字、下划线、短横线
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_-]+$/.test(dir)) {
    throw new Error(`无效风格目录: 包含非法字符: ${dir}`);
  }
  return dir;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)}${units[i]}`;
}
