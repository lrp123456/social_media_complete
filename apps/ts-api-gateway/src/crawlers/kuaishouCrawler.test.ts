import { KuaishouCrawler } from './kuaishouCrawler';

describe('KuaishouCrawler drawer click targeting', () => {
  it('chooses a safe click point outside thumbnail and title regions', () => {
    const crawler = new KuaishouCrawler();
    const point = (crawler as any).pickSafeDrawerClickPoint({
      item: { left: 100, top: 200, right: 500, bottom: 300, width: 400, height: 100 },
      cover: { left: 112, top: 210, right: 192, bottom: 290, width: 80, height: 80 },
      title: { left: 210, top: 210, right: 470, bottom: 232, width: 260, height: 22 },
      date: { left: 210, top: 242, right: 350, bottom: 260, width: 140, height: 18 },
      detail: { left: 210, top: 270, right: 390, bottom: 290, width: 180, height: 20 },
    });

    expect(point).toMatchObject({ target: 'date' });
    expect(point.x).toBeGreaterThan(192);
    expect(point.y).toBeGreaterThan(232);
  });
});

describe('KuaishouCrawler comment parsing', () => {
  it('parses root snapshots using common Kuaishou reply-count fallback fields', () => {
    const crawler = new KuaishouCrawler();
    const snapshots = (crawler as any).parseRootCommentSnapshots({
      data: {
        list: [
          {
            commentId: 'root-1',
            content: 'root comment',
            reply_to: 0,
            sub_comment_count: 3,
            timestamp: 1710000000000,
            userId: 'u1',
            userName: 'Alice',
          },
          {
            commentId: 'child-1',
            content: 'child comment',
            reply_to: 'root-1',
            sub_comment_count: 0,
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
});
