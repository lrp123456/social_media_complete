'use client';

import { useState } from 'react';
import { usePublishVideo } from '@/hooks/useApi';
import { Upload, Send, Check } from 'lucide-react';

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent'];

export default function PublishPage() {
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const publishVideo = usePublishVideo();

  const togglePlatform = (p: string) => {
    setSelected((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  };

  const handlePublish = () => {
    if (selected.length === 0) return;
    // TODO: 实际对接 File Upload + TS API
    publishVideo.mutate({ platforms: selected, title, description: desc });
  };

  return (
    <div>
      <h2 className="text-headline-lg mb-1">一键发布</h2>
      <p className="text-sm text-on-surface-variant mb-8">多平台分发 · 账号托管</p>

      {/* Upload Area */}
      <div className="bg-white rounded-lg border-2 border-dashed border-surface-high p-12 mb-6 text-center hover:border-primary/50 transition-colors cursor-pointer">
        <Upload size={36} className="mx-auto text-on-surface-variant mb-3" />
        <p className="text-sm text-on-surface-variant">拖拽视频到此或点击上传</p>
        <p className="text-xs text-on-surface-variant mt-1">支持 MP4, 最大 2GB</p>
      </div>

      {/* Metadata */}
      <div className="bg-white rounded-lg border border-surface-high p-6 mb-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">标题</label>
          <input
            type="text"
            className="w-full px-3 py-2 border rounded-md text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">描述</label>
          <textarea
            rows={3}
            className="w-full px-3 py-2 border rounded-md text-sm focus:border-primary outline-none"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
      </div>

      {/* Platform Selection */}
      <div className="bg-white rounded-lg border border-surface-high p-6 mb-8">
        <label className="block text-sm font-medium mb-3">目标平台</label>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => togglePlatform(p)}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                selected.includes(p)
                  ? 'bg-primary/10 border-primary text-primary'
                  : 'bg-white border-surface-high text-on-surface-variant hover:bg-surface'
              }`}
            >
              {selected.includes(p) && <Check size={14} />}
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Publish Button */}
      <button
        onClick={handlePublish}
        disabled={selected.length === 0 || !title}
        className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
      >
        <Send size={18} />
        发布到 {selected.length} 个平台
      </button>
    </div>
  );
}
