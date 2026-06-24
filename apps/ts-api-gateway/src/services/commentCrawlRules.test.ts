import {
  getCommentCrawlDecision,
  getRootCidSetForIncremental,
  shouldCompareReplyCounts,
} from './commentCrawlRules';

describe('getCommentCrawlDecision', () => {
  it('queues a new video with comments as first crawl', () => {
    expect(getCommentCrawlDecision({ currentCount: 3, storedCount: null })).toEqual({
      shouldQueue: true,
      isFirstCrawl: true,
      reason: 'new_video_with_comments',
    });
  });

  it('does not queue a new video with zero comments', () => {
    expect(getCommentCrawlDecision({ currentCount: 0, storedCount: null })).toEqual({
      shouldQueue: false,
      isFirstCrawl: false,
      reason: 'new_video_without_comments',
    });
  });

  it('queues an existing video when comment count increases', () => {
    expect(getCommentCrawlDecision({ currentCount: 8, storedCount: 5 })).toEqual({
      shouldQueue: true,
      isFirstCrawl: false,
      reason: 'comment_count_changed',
    });
  });

  it('queues an existing video when comment count decreases', () => {
    expect(getCommentCrawlDecision({ currentCount: 2, storedCount: 5 })).toEqual({
      shouldQueue: true,
      isFirstCrawl: false,
      reason: 'comment_count_changed',
    });
  });

  it('does not queue an existing video when comment count is unchanged', () => {
    expect(getCommentCrawlDecision({ currentCount: 5, storedCount: 5 })).toEqual({
      shouldQueue: false,
      isFirstCrawl: false,
      reason: 'comment_count_unchanged',
    });
  });
});

describe('snapshot fallback helpers', () => {
  it('uses last snapshot cids when snapshots exist', () => {
    const lastSnapshots = new Map<string, number>([
      ['root-a', 0],
      ['root-b', 2],
    ]);
    const dbAllCids = new Set<string>(['root-a', 'root-c']);
    const currentSnapshots = [{ cid: 'root-a' }, { cid: 'root-b' }, { cid: 'root-c' }];

    expect([...getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots)].sort()).toEqual(['root-a', 'root-b']);
    expect(shouldCompareReplyCounts(lastSnapshots)).toBe(true);
  });

  it('falls back to local comment cids when snapshots are missing', () => {
    const lastSnapshots = new Map<string, number>();
    const dbAllCids = new Set<string>(['root-a', 'old-sub-reply']);
    const currentSnapshots = [{ cid: 'root-a' }, { cid: 'root-b' }];

    expect([...getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots)].sort()).toEqual(['root-a']);
    expect(shouldCompareReplyCounts(lastSnapshots)).toBe(false);
  });
});
