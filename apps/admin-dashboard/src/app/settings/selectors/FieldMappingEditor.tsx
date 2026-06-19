'use client';

import { useState } from 'react';

export function FieldMappingEditor({
  mappings,
  onChange,
}: {
  mappings: Record<string, string[]>;
  onChange: (m: Record<string, string[]>) => void;
}) {
  const [newField, setNewField] = useState('');

  const addField = () => {
    if (!newField.trim()) return;
    onChange({ ...mappings, [newField.trim()]: [''] });
    setNewField('');
  };

  const removeField = (field: string) => {
    const next = { ...mappings };
    delete next[field];
    onChange(next);
  };

  const addPath = (field: string) => {
    onChange({ ...mappings, [field]: [...(mappings[field] || []), ''] });
  };

  const removePath = (field: string, index: number) => {
    const paths = [...(mappings[field] || [])];
    paths.splice(index, 1);
    if (paths.length === 0) {
      removeField(field);
    } else {
      onChange({ ...mappings, [field]: paths });
    }
  };

  const updatePath = (field: string, index: number, value: string) => {
    const paths = [...(mappings[field] || [])];
    paths[index] = value;
    onChange({ ...mappings, [field]: paths });
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500 mb-1">字段映射（字段名 ← 候选 JSON 路径）</div>

      {Object.entries(mappings).map(([field, paths]) => (
        <div key={field} className="flex items-start gap-2 border rounded p-2 bg-gray-50">
          <span className="w-32 text-sm font-medium pt-1">{field}</span>
          <span className="text-gray-400 pt-1">←</span>
          <div className="flex-1 flex flex-wrap gap-1">
            {paths.map((path, i) => (
              <span key={i} className="flex items-center gap-1 px-2 py-0.5 bg-white border rounded text-xs">
                <input
                  value={path}
                  onChange={(e) => updatePath(field, i, e.target.value)}
                  className="w-28 bg-transparent outline-none font-mono"
                  placeholder="json.path"
                />
                <button
                  onClick={() => removePath(field, i)}
                  className="text-red-400 hover:text-red-600 ml-1"
                >
                  ×
                </button>
              </span>
            ))}
            <button
              onClick={() => addPath(field)}
              className="px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 rounded"
            >
              + 路径
            </button>
          </div>
          <button
            onClick={() => removeField(field)}
            className="text-red-400 hover:text-red-600 text-sm pt-0.5"
            title="删除字段"
          >
            🗑
          </button>
        </div>
      ))}

      <div className="flex gap-2 mt-2">
        <input
          value={newField}
          onChange={(e) => setNewField(e.target.value)}
          placeholder="新字段名（如 aweme_id）"
          className="px-2 py-1 border rounded text-sm"
          onKeyDown={(e) => { if (e.key === 'Enter') addField(); }}
        />
        <button
          onClick={addField}
          className="px-3 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600"
        >
          添加字段
        </button>
      </div>
    </div>
  );
}
