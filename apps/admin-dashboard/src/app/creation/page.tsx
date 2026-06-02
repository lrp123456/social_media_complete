'use client';

import { useState } from 'react';
import { Wand2, Play } from 'lucide-react';

export default function CreationPage() {
  const [prompt, setPrompt] = useState('');

  return (
    <div>
      <h2 className="text-headline-lg mb-1">智能创作</h2>
      <p className="text-sm text-on-surface-variant mb-8">AI 视频合成 · 风格识别 · 口播生成</p>

      {/* AI Prompt */}
      <div className="bg-white rounded-lg border border-surface-high p-6 mb-6">
        <label className="block text-sm font-medium mb-3">创作指令</label>
        <textarea
          rows={5}
          className="w-full px-4 py-3 border rounded-lg text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none resize-none"
          placeholder="描述你想创作的内容，AI 将为你生成脚本和视频方案..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
          <Wand2 size={16} />
          生成脚本
        </button>
      </div>

      {/* Pipeline Status */}
      <div className="bg-white rounded-lg border border-surface-high p-6">
        <h3 className="font-semibold mb-4">创作流水线</h3>
        {[
          { step: '素材分析', status: 'completed', time: '2分钟前' },
          { step: '脚本生成', status: 'running', time: '进行中...' },
          { step: 'TTS 语音合成', status: 'pending', time: '等待中' },
          { step: '视频渲染', status: 'pending', time: '等待中' },
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
