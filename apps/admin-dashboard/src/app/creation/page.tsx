'use client';

import { useState } from 'react';
import { usePinterestScrape, useMaterialUpdate } from '@/hooks/useApi';
import { Wand2, Image, Search, Download } from 'lucide-react';

export default function CreationPage() {
  const [prompt, setPrompt] = useState('');
  const [pinterestQuery, setPinterestQuery] = useState('');
  const [maxPins, setMaxPins] = useState(50);
  const pinterestScrape = usePinterestScrape();
  const materialUpdate = useMaterialUpdate();

  return (
    <div>
      <h2 className="text-headline-lg mb-1">智能创作</h2>
      <p className="text-sm text-on-surface-variant mb-8">AI 脚本生成 · Pinterest 素材采集 · 素材更新</p>

      {/* Pinterest 采集 */}
      <div className="bg-white rounded-lg border border-surface-high p-6 mb-6">
        <h3 className="font-semibold mb-3 flex items-center gap-2">
          <Image size={18} /> Pinterest 素材采集
        </h3>
        <div className="flex gap-3 mb-3">
          <input
            type="text"
            className="flex-1 px-3 py-2 border rounded-md text-sm focus:border-primary outline-none"
            placeholder="搜索关键词..."
            value={pinterestQuery}
            onChange={(e) => setPinterestQuery(e.target.value)}
          />
          <select
            className="px-3 py-2 border rounded-md text-sm"
            value={maxPins}
            onChange={(e) => setMaxPins(Number(e.target.value))}
          >
            <option value={20}>20 pins</option>
            <option value={50}>50 pins</option>
            <option value={100}>100 pins</option>
          </select>
        </div>
        <button
          onClick={() => pinterestScrape.mutate({ query: pinterestQuery, maxPins, windowId: 'default' })}
          disabled={!pinterestQuery || pinterestScrape.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
        >
          <Search size={16} />
          {pinterestScrape.isPending ? '采集中...' : '开始采集'}
        </button>
        {pinterestScrape.isSuccess && (
          <p className="text-sm text-green-600 mt-2">✅ 采集任务已启动: {pinterestScrape.data.taskId}</p>
        )}
      </div>

      {/* AI 脚本生成 */}
      <div className="bg-white rounded-lg border border-surface-high p-6 mb-6">
        <label className="block text-sm font-medium mb-3">创作指令</label>
        <textarea
          rows={4}
          className="w-full px-4 py-3 border rounded-lg text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none resize-none"
          placeholder="描述你想创作的内容..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
          <Wand2 size={16} />
          生成脚本
        </button>
      </div>

      {/* 素材更新 */}
      <div className="bg-white rounded-lg border border-surface-high p-6 mb-6">
        <h3 className="font-semibold mb-3 flex items-center gap-2">
          <Download size={18} /> 素材更新（切分/评级/归档）
        </h3>
        <p className="text-sm text-on-surface-variant mb-3">
          触发后端素材更新流水线：FFmpeg 场景切分 → 抽帧 → LLM 风格评级 → 分类落盘
        </p>
        <button
          onClick={() => materialUpdate.mutate({
            oss_urls: ['https://img.naite.cc/uploads/sample.mp4'],
            platform: 'douyin',
          })}
          disabled={materialUpdate.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 bg-surface border border-surface-high rounded-md text-sm font-medium hover:bg-surface-high disabled:opacity-40 transition-colors"
        >
          {materialUpdate.isPending ? '处理中...' : '触发素材更新'}
        </button>
      </div>

      {/* 创作流水线 */}
      <div className="bg-white rounded-lg border border-surface-high p-6">
        <h3 className="font-semibold mb-4">创作流水线</h3>
        {[
          { step: '素材采集 (Pinterest/平台)', status: 'completed', time: '10分钟前' },
          { step: '素材更新 (切分/抽帧/评级)', status: 'completed', time: '5分钟前' },
          { step: 'LLM 脚本生成', status: 'running', time: '进行中...' },
          { step: 'TTS 语音合成', status: 'pending', time: '等待中' },
          { step: '视频渲染 + BGM', status: 'pending', time: '等待中' },
        ].map((pipeline) => (
          <div key={pipeline.step} className="flex items-center gap-4 py-3 border-t border-surface-high first:border-0">
            <div className={`w-2.5 h-2.5 rounded-full ${
              pipeline.status === 'completed' ? 'bg-green-500' :
              pipeline.status === 'running' ? 'bg-primary animate-pulse' : 'bg-surface'
            }`} />
            <span className="flex-1 text-sm font-medium">{pipeline.step}</span>
            <span className="text-xs text-on-surface-variant">{pipeline.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
