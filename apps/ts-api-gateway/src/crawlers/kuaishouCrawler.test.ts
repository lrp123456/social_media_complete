import { KuaishouCrawler } from './kuaishouCrawler';

describe('KuaishouCrawler comment parsing', () => {
  it('parses root comment snapshots filtering out child comments', () => {
    const crawler = new KuaishouCrawler();
    const snapshots = (crawler as any).parseRootCommentSnapshots({
      data: {
        list: [
          {
            commentId: 'root-1',
            content: 'root comment',
            replyTo: 0,
            subCommentCount: 3,
            timestamp: 1710000000000,
            userId: 'u1',
            userName: 'Alice',
          },
          {
            commentId: 'child-1',
            content: 'child comment',
            replyTo: 'root-1',
            subCommentCount: 0,
            timestamp: 1710000001,
            userId: 'u2',
            userName: 'Bob',
          },
        ],
      },
    });

    expect(snapshots).toEqual([
      {
        cid: 'root-1',
        text: 'root comment',
        replyCount: 3,
        createTime: 1710000000,
        userUid: 'u1',
        userNickname: 'Alice',
      },
    ]);
  });

  it('returns empty array when no root comments matched', () => {
    const crawler = new KuaishouCrawler();
    const snapshots = (crawler as any).parseRootCommentSnapshots({
      data: {
        list: [
          {
            commentId: 'c-1',
            content: 'child',
            replyTo: 'root-x',
            subCommentCount: 0,
            timestamp: 1710000000,
          },
        ],
      },
    });
    expect(snapshots).toEqual([]);
  });

  it('handles empty/missing body gracefully', () => {
    const crawler = new KuaishouCrawler();
    expect((crawler as any).parseRootCommentSnapshots({})).toEqual([]);
    expect((crawler as any).parseRootCommentSnapshots(null)).toEqual([]);
  });
});
