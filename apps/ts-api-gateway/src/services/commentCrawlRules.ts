export type CommentCrawlDecisionReason =
  | 'new_video_with_comments'
  | 'new_video_without_comments'
  | 'comment_count_changed'
  | 'comment_count_unchanged';

export interface CommentCrawlDecision {
  shouldQueue: boolean;
  isFirstCrawl: boolean;
  reason: CommentCrawlDecisionReason;
}

export function getCommentCrawlDecision(input: {
  currentCount: number;
  storedCount: number | null | undefined;
}): CommentCrawlDecision {
  const currentCount = Number(input.currentCount || 0);
  const storedCount = input.storedCount;

  if (storedCount === null || storedCount === undefined) {
    if (currentCount > 0) {
      return { shouldQueue: true, isFirstCrawl: true, reason: 'new_video_with_comments' };
    }
    return { shouldQueue: false, isFirstCrawl: false, reason: 'new_video_without_comments' };
  }

  if (currentCount !== storedCount) {
    return { shouldQueue: true, isFirstCrawl: false, reason: 'comment_count_changed' };
  }

  return { shouldQueue: false, isFirstCrawl: false, reason: 'comment_count_unchanged' };
}

export function shouldCompareReplyCounts(lastSnapshots: Map<string, number>): boolean {
  return lastSnapshots.size > 0;
}

export function getRootCidSetForIncremental(
  lastSnapshots: Map<string, number>,
  dbAllCids: Set<string>,
  currentSnapshots: Array<{ cid: string }>,
): Set<string> {
  if (lastSnapshots.size > 0) {
    return new Set(lastSnapshots.keys());
  }

  const currentRootCids = new Set(currentSnapshots.map((s) => s.cid));
  return new Set([...dbAllCids].filter((cid) => currentRootCids.has(cid)));
}
