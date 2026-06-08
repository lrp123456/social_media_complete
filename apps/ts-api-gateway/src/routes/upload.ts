// @ts-api-gateway/routes/upload.ts - 文件上传 API (OSS)
// 接收 video/mp4, video/quicktime, video/x-msvideo 等视频格式

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { getOSSClient, ossKey, ossUrl, OSS_DIRS } from '../lib/oss';
import { createLogger } from '../lib/logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const router = Router();
const logger = createLogger('routes:upload');

// ============================================================
// Multer 配置 — 内存存储，单文件 500MB，视频 MIME 白名单
// ============================================================

// 视频 MIME 白名单（小写存储，比对时忽略大小写）
const ALLOWED_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-ms-wmv',
  'video/x-flv',
  'video/webm',
  'video/ogg',
  'video/3gpp',
  'video/mpeg',
  'video/av1',
  'video/x-matroska',    // .mkv
  'video/x-m4v',         // .m4v (iOS / iTunes)
  'video/mp2t',          // .ts (MPEG-TS)
  'video/x-ms-asf',      // .asf
  'video/3gpp2',         // .3g2
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (_req, file, cb) => {
    // 忽略大小写比对（部分浏览器/OS 会上报 VIDEO/MP4 等大写）
    if (!ALLOWED_MIMES.has(file.mimetype.toLowerCase())) {
      logger.warn({ mimetype: file.mimetype, originalname: file.originalname }, '拒绝不支持的视频格式');
      return cb(new Error(`不支持的视频格式: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ============================================================
// 辅助：用 ffprobe 探测视频时长/分辨率（可选，失败则跳过）
// ============================================================

interface VideoProbeResult {
  duration?: number;
  width?: number;
  height?: number;
}

async function probeVideo(buffer: Buffer): Promise<VideoProbeResult> {
  try {
    // 将 buffer 写入临时文件供 ffprobe 读取
    const tmpFile = `/tmp/upload_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
    const { writeFile, unlink } = await import('fs/promises');
    await writeFile(tmpFile, buffer);

    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${tmpFile}"`,
      { timeout: 15000 },
    );

    await unlink(tmpFile).catch(() => {});

    const info = JSON.parse(stdout);
    const stream = info.streams?.find((s: any) => s.codec_type === 'video');

    return {
      duration: info.format?.duration ? parseFloat(info.format.duration) : undefined,
      width: stream?.width ?? undefined,
      height: stream?.height ?? undefined,
    };
  } catch {
    logger.warn('ffprobe 探测失败（已跳过），请确认系统已安装 ffmpeg');
    return {};
  }
}

// ============================================================
// POST /api/v1/upload — 上传视频到 OSS（大文件走 OSS 公网 URL，不 base64）
// 交互原则: 视频/大文件走 OSS URL，截图/缩略图/配置等小数据优先 base64 节省成本
// ============================================================

router.post('/', (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err) => {
    try {
      // Multer 错误处理（文件大小/类型）
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, error: '文件大小超过 500MB 限制' });
          }
          return res.status(400).json({ success: false, error: err.message });
        }
        return res.status(400).json({ success: false, error: err.message });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: '请选择要上传的文件（字段名: file）' });
      }

      // 生成 OSS 路径（按业务目录 + 日期分目录）
      const key = ossKey(OSS_DIRS.videos, file.originalname);

      // 上传到 OSS（带进度日志）
      const client = getOSSClient();
      let lastProgress = 0;
      await client.put(key, file.buffer, {
        progress: (p: number) => {
          const pct = Math.floor(p * 100);
          if (pct - lastProgress >= 10) {
            // 每 10% 记录一次，避免日志过多
            logger.debug({ filename: file.originalname, progress: pct }, 'OSS 上传进度');
            lastProgress = pct;
          }
        },
      });

      // 可选：用 ffprobe 探测视频元信息
      const probe = await probeVideo(file.buffer);

      const result = {
        ossUrl: ossUrl(key),
        filename: file.originalname,
        size: file.size,
        ...(probe.duration !== undefined && { duration: probe.duration }),
        ...(probe.width !== undefined && { width: probe.width }),
        ...(probe.height !== undefined && { height: probe.height }),
      };

      logger.info({ filename: file.originalname, size: file.size, key }, '上传成功');

      res.json({ success: true, data: result });
    } catch (e: any) {
      logger.error({ err: e.message }, 'OSS 上传失败');
      res.status(500).json({ success: false, error: `OSS 上传失败: ${e.message}` });
    }
  });
});

export default router;
