// @ts-api-gateway/routes/config-media.ts — 板块四: 智能创作与媒体渲染
import { Router, Request, Response } from 'express';
import { getSection, saveSection } from '../lib/settingsStore';

const router = Router();

const mediaDefaults = {
  ffmpeg: { res_width: 1080, res_height: 1920, fps: 30, pixel_format: 'yuv420p', video_codec: 'libx264', audio_codec: 'aac' },
  media: { tts_provider: 'indextts2', max_clips_per_video: 8, min_material_score: 21 },
};

const MEDIA = getSection('media', mediaDefaults);

/** GET /api/v1/config-media */
router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: MEDIA, meta: { carrier: 'data/settings-overrides.json', strategy: 'hot' } });
});

/** PUT /api/v1/config-media */
router.put('/', (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ success: false, error: '请求体必须是对象' });
  }
  // 浅合并: 顶层的 ffmpeg / media 各自合并
  if (req.body.ffmpeg) Object.assign(MEDIA.ffmpeg, req.body.ffmpeg);
  if (req.body.media) Object.assign(MEDIA.media, req.body.media);
  saveSection('media', MEDIA);
  res.json({ success: true, data: MEDIA, message: '配置已保存, 下一个渲染任务出队时生效' });
});

export default router;
