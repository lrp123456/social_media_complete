import type { PrismaClient } from '@prisma/client';

export async function getMonitorAccountCommentStats(
  prisma: PrismaClient,
  userId: number,
): Promise<{ totalComments: number; newComments: number }> {
  const [totalCommentSum, newComments] = await Promise.all([
    prisma.video.aggregate({
      where: { userId },
      _sum: { commentCount: true },
    }),
    prisma.comment.count({
      where: { video: { userId }, isNew: 1 },
    }),
  ]);

  return {
    totalComments: totalCommentSum._sum.commentCount ?? 0,
    newComments,
  };
}
