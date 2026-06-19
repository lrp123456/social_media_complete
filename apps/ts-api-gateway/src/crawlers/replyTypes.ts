/**
 * 共享回复目标接口 — 对多多平台评论回复操作
 * 各平台 crawler 统一引用此接口
 */

export interface ReplyTarget {
  /** ★ XHS 强主键：评论 cid（用于定位） */
  cid?: string;
  /** 评论正文（仅用于日志和最终可视确认） */
  text: string;
  /** 评论层级：1=根评论，2=子评论 */
  level: 1 | 2;
  /** ★ 要回复的那条评论的作者昵称（匹配主键之一） */
  username: string;
  /** ★ 仅 level=1：根评论的子评论数 */
  subReplyCount?: number;
  /** ★ 仅 level=2：所属根评论的正文 */
  rootText?: string;
  /** ★ 仅 level=2：所属根评论的作者昵称 */
  rootUsername?: string;
  /** ★ 仅 level=2：所属根评论的子评论数 */
  rootSubReplyCount?: number;
  /** 保留：用于日志 */
  createTime?: number;
}
