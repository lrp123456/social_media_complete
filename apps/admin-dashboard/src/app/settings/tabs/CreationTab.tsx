'use client';

import { useState, useEffect, useRef } from 'react';
import { useMediaConfig, useUpdateMediaConfig } from '@/hooks/useApi';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { HeaderStrip, AccentBar } from '@/components/ui/Bento';
import { FFMPEG_FIELDS } from '../shared/constants';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { StrategyBadge } from '../shared/StrategyBadge';

export default function CreationTab() {
  const mediaQuery = useMediaConfig();
  const updateMedia = useUpdateMediaConfig();
  const [mediaForm, setMediaForm] = useState({
    ffmpeg: { res_width: 1920, res_height: 1080, fps: 30, pixel_format: 'yuv420p', video_codec: 'libx264', audio_codec: 'aac' },
    media: { tts_provider: 'indextts2', max_clips_per_video: 10, min_material_score: 60 },
  });
  const mediaInitRef = useRef(false);

  useEffect(() => {
    if (mediaQuery.data && !mediaInitRef.current) {
      const d = mediaQuery.data;
      setMediaForm({
        ffmpeg: { res_width: 1920, res_height: 1080, fps: 30, pixel_format: 'yuv420p', video_codec: 'libx264', audio_codec: 'aac', ...(d.ffmpeg || {}) },
        media: { tts_provider: 'indextts2', max_clips_per_video: 10, min_material_score: 60, ...(d.media || {}) },
      });
      mediaInitRef.current = true;
    }
  }, [mediaQuery.data]);

  const handleSaveMedia = () => updateMedia.mutate(mediaForm);

  return (
    <div className="space-y-6 p-6">
      <section id="panel-media" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
        <AccentBar color="success" />
        <HeaderStrip>
          <div>
            <h3 className="text-headline-md text-headline-md text-on-surface">智能创作与媒体渲染</h3>
            <p className="font-body text-body-sm text-on-surface-variant mt-0.5">FFmpeg 重编码参数与媒体引擎配置。</p>
          </div>
          <div className="flex items-center gap-3">
            <StrategyBadge strategy="cold" carrier="PostgreSQL config_entries" />
            <button onClick={handleSaveMedia} disabled={updateMedia.isPending} className="btn-secondary flex items-center gap-1.5 text-sm">
              <MaterialIcon icon="save" size="sm" />
              {updateMedia.isPending ? '保存中…' : '保存配置'}
            </button>
          </div>
        </HeaderStrip>
        <div className="p-inner-component-padding space-y-6">
          <div>
            <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">FFmpeg 重编码参数</h4>
            {mediaQuery.isLoading ? <PanelSkeleton rows={2} /> : mediaQuery.isError ? <QueryError /> : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {FFMPEG_FIELDS.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <label className="text-label-md text-label-md text-on-surface-variant">{field.label}</label>
                    <input
                      type={field.type}
                      className="form-input font-mono text-sm"
                      value={(mediaForm.ffmpeg as any)[field.key] || ''}
                      onChange={(e) => setMediaForm((prev) => ({ ...prev, ffmpeg: { ...prev.ffmpeg, [field.key]: field.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value } }))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-outline-variant" />
          <div>
            <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">媒体引擎参数</h4>
            {mediaQuery.isLoading ? <PanelSkeleton rows={2} /> : mediaQuery.isError ? <QueryError /> : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-label-md text-label-md text-on-surface-variant">TTS 提供商</label>
                  <select className="form-input font-mono text-sm" value={mediaForm.media.tts_provider} onChange={(e) => setMediaForm((prev) => ({ ...prev, media: { ...prev.media, tts_provider: e.target.value } }))}>
                    <option value="indextts2">indextts2</option>
                    <option value="qwen3">qwen3</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-label-md text-label-md text-on-surface-variant">单视频最大片段数 (2-20)</label>
                  <input type="number" min={2} max={20} className="form-input font-mono text-sm" value={mediaForm.media.max_clips_per_video} onChange={(e) => setMediaForm((prev) => ({ ...prev, media: { ...prev.media, max_clips_per_video: parseInt(e.target.value) || 2 } }))} />
                </div>
                <div className="space-y-1">
                  <label className="text-label-md text-label-md text-on-surface-variant">素材最低质量分 (0-100)</label>
                  <input type="number" min={0} max={100} className="form-input font-mono text-sm" value={mediaForm.media.min_material_score} onChange={(e) => setMediaForm((prev) => ({ ...prev, media: { ...prev.media, min_material_score: parseInt(e.target.value) || 0 } }))} />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
