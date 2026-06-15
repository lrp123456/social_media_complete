'use client';

import { useState } from 'react';
import { useGenerateAiReply, useRegenerateAiReply, useAcceptAiReply } from '@/hooks/useApi';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { cn } from '@/lib/utils';

type AiReplyCardProps = {
  commentId: number;
  commentText?: string;
  suggestionStatus: string;
  suggestedReply: string | null;
  suggestionModel: string | null;
  suggestionLatencyMs: number | null;
  replyStatus: string;
  isNew?: boolean;
  /** Nested under a sub-comment (level 2) */
  isSub?: boolean;
};

export default function AiReplyCard({
  commentId,
  commentText,
  suggestionStatus,
  suggestedReply,
  suggestionModel,
  suggestionLatencyMs,
  replyStatus,
  isNew,
  isSub,
}: AiReplyCardProps) {
  const [editedText, setEditedText] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  const generate = useGenerateAiReply();
  const regenerate = useRegenerateAiReply();
  const accept = useAcceptAiReply();

  const displayText = editedText ?? suggestedReply ?? '';
  const isPending = suggestionStatus === 'pending' || generate.isPending || regenerate.isPending;
  const isSent = replyStatus === 'sent';
  const isAccepted = suggestionStatus === 'accepted';
  const isError = suggestionStatus === 'error';
  const isReady = suggestionStatus === 'ready';
  const canGenerate = suggestionStatus === 'none' || suggestionStatus === 'error';

  // ── Reply sent confirmation ──
  if (isSent) {
    return (
      <div className="mt-1.5 rounded-lg bg-emerald-50 border border-emerald-200/50 p-2.5">
        <div className="flex items-center gap-1.5 text-emerald-600 text-[11px] font-medium">
          <MaterialIcon icon="check_circle" size="xs" />
          已回复
          {suggestionModel && (
            <span className="ml-auto text-[10px] text-emerald-500/60 font-normal">{suggestionModel}</span>
          )}
        </div>
        {displayText && (
          <p className="text-[10px] text-on-surface-variant/70 mt-1">{displayText}</p>
        )}
        <button
          onClick={() => generate.mutate({ commentId })}
          disabled={generate.isPending}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-700 font-medium disabled:opacity-40"
        >
          <MaterialIcon icon="auto_awesome" size="xs" />
          {generate.isPending ? '生成中…' : '生成新 AI 回复'}
        </button>
      </div>
    );
  }

  // ── Accepted but reply pending ──
  if (isAccepted && replyStatus === 'pending') {
    return (
      <div className="mt-1.5 rounded-lg bg-blue-50 border border-blue-200/50 p-2.5">
        <div className="flex items-center gap-1.5 text-blue-600 text-[11px] font-medium">
          <MaterialIcon icon="schedule" size="xs" />
          回复排队中…
        </div>
        {displayText && (
          <p className="text-[10px] text-on-surface-variant/70 mt-1">{displayText}</p>
        )}
        <button
          onClick={() => {
            regenerate.mutate({ commentId, previousReply: displayText });
            setEditedText(null);
            setIsEditing(false);
          }}
          disabled={regenerate.isPending}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 font-medium disabled:opacity-40"
        >
          <MaterialIcon icon="sync" size="xs" />
          {regenerate.isPending ? '生成中…' : '重新生成 AI 回复'}
        </button>
      </div>
    );
  }

  // ── Accepted but reply failed ──
  if (isAccepted && replyStatus === 'failed') {
    return (
      <div className="mt-1.5 rounded-lg bg-red-50 border border-red-200/50 p-2.5">
        <div className="flex items-center gap-1.5 text-[11px] text-red-500 font-medium">
          <MaterialIcon icon="error" size="xs" />
          回复执行失败
        </div>
        <p className="text-[10px] text-on-surface-variant/70 mt-1">{displayText}</p>
        <button
          onClick={() => {
            accept.mutate({ commentId, text: displayText });
          }}
          disabled={accept.isPending}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-red-600 hover:text-red-700 font-medium disabled:opacity-40"
        >
          <MaterialIcon icon="refresh" size="xs" />
          {accept.isPending ? '提交中…' : '重新提交回复'}
        </button>
      </div>
    );
  }

  // ── Pending: skeleton ──
  if (isPending) {
    return (
      <div className="mt-1.5 rounded-lg bg-blue-50/60 border border-blue-200/50 p-2.5 space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-blue-500 font-medium">
          <MaterialIcon icon="auto_awesome" size="xs" />
          AI 生成中…
        </div>
        <div className="space-y-1">
          <div className="h-3 bg-blue-200/40 rounded animate-pulse w-4/5" />
          <div className="h-3 bg-blue-200/40 rounded animate-pulse w-3/5" />
        </div>
      </div>
    );
  }

  // ── Error ──
  if (isError) {
    return (
      <div className="mt-1.5 rounded-lg bg-red-50 border border-red-200/50 p-2.5">
        <div className="flex items-center gap-1.5 text-[11px] text-red-500 font-medium">
          <MaterialIcon icon="error" size="xs" />
          AI 生成失败
        </div>
        <button
          onClick={() => generate.mutate({ commentId })}
          disabled={generate.isPending}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-red-600 hover:text-red-700 font-medium disabled:opacity-40"
        >
          <MaterialIcon icon="refresh" size="xs" />
          重试
        </button>
      </div>
    );
  }

  // ── None (new comment, no suggestion yet) ──
  if (canGenerate && !suggestedReply) {
    return (
      <div className="mt-1.5">
        <button
          onClick={() => generate.mutate({ commentId })}
          disabled={generate.isPending}
          className={cn(
            'flex items-center gap-1.5 text-[11px] font-medium rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-40',
            'bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200/50',
          )}
        >
          <MaterialIcon icon="auto_awesome" size="xs" />
          生成 AI 回复
        </button>
      </div>
    );
  }

  // ── Ready: show suggestion ──
  if (isReady || isAccepted) {
    return (
      <div className="mt-1.5 rounded-lg bg-blue-50/70 border border-blue-200/60 p-2.5">
        {/* Header */}
        <div className="flex items-center gap-1.5 text-[11px] text-blue-600 font-medium mb-1.5">
          <MaterialIcon icon="auto_awesome" size="xs" />
          AI 建议回复
          {suggestionModel && (
            <span className="ml-auto text-[10px] text-blue-400 font-normal">
              {suggestionModel}
              {suggestionLatencyMs ? `, ${suggestionLatencyMs}ms` : ''}
            </span>
          )}
        </div>

        {/* Editable text */}
        {isEditing ? (
          <textarea
            value={displayText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={3}
            className="w-full text-body-sm text-on-surface bg-white border border-blue-300 rounded-lg p-2 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        ) : (
          <p className="text-body-sm text-on-surface leading-relaxed">{displayText}</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => {
              const text = editedText ?? displayText;
              accept.mutate({ commentId, text });
            }}
            disabled={accept.isPending || !displayText}
            className={cn(
              'flex items-center gap-1 text-[11px] font-medium rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-40',
              'bg-blue-600 text-white hover:bg-blue-700',
            )}
          >
            <MaterialIcon icon="send" size="xs" />
            {accept.isPending ? '提交中…' : '采纳回复'}
          </button>

          <button
            onClick={() => {
              regenerate.mutate({
                commentId,
                previousReply: displayText,
              });
              setEditedText(null);
              setIsEditing(false);
            }}
            disabled={regenerate.isPending}
            className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 font-medium rounded-lg px-2 py-1.5 hover:bg-blue-100 transition-colors disabled:opacity-40"
          >
            <MaterialIcon icon="sync" size="xs" />
            重新生成
          </button>

          <button
            onClick={() => {
              if (isEditing) {
                setIsEditing(false);
              } else {
                setEditedText(displayText);
                setIsEditing(true);
              }
            }}
            className="flex items-center gap-1 text-[11px] text-on-surface-variant hover:text-on-surface font-medium rounded-lg px-2 py-1.5 hover:bg-surface-container transition-colors ml-auto"
          >
            <MaterialIcon icon={isEditing ? 'close' : 'edit'} size="xs" />
            {isEditing ? '取消' : '编辑'}
          </button>
        </div>

        {accept.isError && (
          <p className="mt-1 text-[10px] text-red-500">回复提交失败，请重试</p>
        )}
      </div>
    );
  }

  // Fallback: nothing to show
  return null;
}
