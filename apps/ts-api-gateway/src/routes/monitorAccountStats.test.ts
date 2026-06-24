import { getMonitorAccountCommentStats } from './monitorAccountStats';

describe('getMonitorAccountCommentStats', () => {
  it('uses Video.commentCount sum for totalComments and Comment.isNew for newComments', async () => {
    const prisma = {
      video: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { commentCount: 42 } }),
      },
      comment: {
        count: jest.fn().mockResolvedValue(3),
      },
    } as any;

    await expect(getMonitorAccountCommentStats(prisma, 7)).resolves.toEqual({
      totalComments: 42,
      newComments: 3,
    });

    expect(prisma.video.aggregate).toHaveBeenCalledWith({
      where: { userId: 7 },
      _sum: { commentCount: true },
    });
    expect(prisma.comment.count).toHaveBeenCalledWith({
      where: { video: { userId: 7 }, isNew: 1 },
    });
  });

  it('returns zero totalComments when aggregate sum is null', async () => {
    const prisma = {
      video: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { commentCount: null } }),
      },
      comment: {
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;

    await expect(getMonitorAccountCommentStats(prisma, 8)).resolves.toEqual({
      totalComments: 0,
      newComments: 0,
    });
  });
});
