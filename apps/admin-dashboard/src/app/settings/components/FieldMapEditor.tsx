'use client';

import type { FieldMap, TargetField } from '@/types/material';

const TARGET_FIELDS: TargetField[] = [
  'videoId',
  'title',
  'likeCount',
  'commentCount',
  'videoUrl',
  'cover',
  'author',
  'publishTime',
];

const PLACEHOLDERS: Record<TargetField, string> = {
  videoId: 'data.videos[*].id',
  title: 'data.videos[*].title',
  likeCount: 'data.videos[*].statistics.like_count',
  commentCount: 'data.videos[*].statistics.comment_count',
  videoUrl: 'data.videos[*].video_url',
  cover: 'data.videos[*].cover',
  author: 'data.videos[*].author.nickname',
  publishTime: 'data.videos[*].create_time',
};

export function FieldMapEditor({
  value,
  onChange,
}: {
  value: FieldMap;
  onChange: (v: FieldMap) => void;
}) {
  const updateField = (field: TargetField, path: string) => {
    onChange({ ...value, [field]: path });
  };

  return (
    <div className="space-y-2">
      {TARGET_FIELDS.map((field) => (
        <div
          key={field}
          className="flex flex-col md:flex-row md:items-center gap-1 md:gap-3"
        >
          <label className="text-xs font-medium text-on-surface-variant md:w-24 shrink-0">
            {field}
          </label>
          <input
            className="form-input flex-1 text-sm font-mono"
            value={value[field] || ''}
            onChange={(e) => updateField(field, e.target.value)}
            placeholder={`点路径，如 ${PLACEHOLDERS[field]}`}
          />
        </div>
      ))}
    </div>
  );
}
