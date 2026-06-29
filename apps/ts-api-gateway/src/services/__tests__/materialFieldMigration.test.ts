import { migrateFieldsToFieldMap, isFieldMapComplete, getMissingFields } from '../materialFieldMigration';
import type { FieldMap } from '../materialUpdateConfig';

describe('migrateFieldsToFieldMap', () => {
  it('已知字段名正确映射', () => {
    const fields = {
      videoId: 'video_id',
      desc: 'description',
      diggCount: 'stats.diggCount',
      comments: 'stats.commentCount',
      playUrl: 'play_url',
      cover: 'cover.url',
      nickname: 'author.name',
      createTime: 'create_time',
    };
    const result = migrateFieldsToFieldMap(fields);
    expect(result).toEqual({
      videoId: 'video_id',
      title: 'description',
      likeCount: 'stats.diggCount',
      commentCount: 'stats.commentCount',
      videoUrl: 'play_url',
      cover: 'cover.url',
      author: 'author.name',
      publishTime: 'create_time',
    });
  });

  it('未知字段名被忽略，对应 TargetField 留空', () => {
    const fields = {
      videoId: 'id',
      unknown_field: 'some.path',
      someOther: 'another.path',
    };
    const result = migrateFieldsToFieldMap(fields);
    expect(result.videoId).toBe('id');
    expect(result.title).toBe('');
    expect(result.likeCount).toBe('');
    expect(result.commentCount).toBe('');
    expect(result.videoUrl).toBe('');
    expect(result.cover).toBe('');
    expect(result.author).toBe('');
    expect(result.publishTime).toBe('');
  });

  it('空对象返回全部空串的 FieldMap', () => {
    const result = migrateFieldsToFieldMap({});
    expect(result).toEqual({
      videoId: '',
      title: '',
      likeCount: '',
      commentCount: '',
      videoUrl: '',
      cover: '',
      author: '',
      publishTime: '',
    });
  });

  it('null/undefined 返回全部空串的 FieldMap', () => {
    expect(migrateFieldsToFieldMap(null)).toEqual({
      videoId: '',
      title: '',
      likeCount: '',
      commentCount: '',
      videoUrl: '',
      cover: '',
      author: '',
      publishTime: '',
    });
    expect(migrateFieldsToFieldMap(undefined)).toEqual({
      videoId: '',
      title: '',
      likeCount: '',
      commentCount: '',
      videoUrl: '',
      cover: '',
      author: '',
      publishTime: '',
    });
  });

  it('大小写不敏感的字段名匹配', () => {
    const fields = {
      VIDEOID: 'id',
      TiTlE: 'desc',
    };
    const result = migrateFieldsToFieldMap(fields);
    expect(result.videoId).toBe('id');
    expect(result.title).toBe('desc');
  });

  it('已知字段名映射覆盖所有 8 个 TargetField', () => {
    const fields: Record<string, string> = {
      id: 'data.id',
      desc: 'data.desc',
      diggCount: 'data.digg',
      commentCount: 'data.comment',
      playUrl: 'data.url',
      thumbnail: 'data.cover',
      authorName: 'data.author',
      publishTime: 'data.time',
    };
    const result = migrateFieldsToFieldMap(fields);
    expect(result.videoId).toBe('data.id');
    expect(result.title).toBe('data.desc');
    expect(result.likeCount).toBe('data.digg');
    expect(result.commentCount).toBe('data.comment');
    expect(result.videoUrl).toBe('data.url');
    expect(result.cover).toBe('data.cover');
    expect(result.author).toBe('data.author');
    expect(result.publishTime).toBe('data.time');
  });
});

describe('isFieldMapComplete', () => {
  it('完整的 FieldMap 返回 true', () => {
    const map: FieldMap = {
      videoId: 'id',
      title: 'desc',
      likeCount: 'likes',
      commentCount: 'comments',
      videoUrl: 'url',
      cover: 'cover',
      author: 'author',
      publishTime: 'time',
    };
    expect(isFieldMapComplete(map)).toBe(true);
  });

  it('有空字段的 FieldMap 返回 false', () => {
    const map: FieldMap = {
      videoId: 'id',
      title: '',
      likeCount: 'likes',
      commentCount: 'comments',
      videoUrl: 'url',
      cover: 'cover',
      author: 'author',
      publishTime: 'time',
    };
    expect(isFieldMapComplete(map)).toBe(false);
  });
});

describe('getMissingFields', () => {
  it('返回未配置的字段列表', () => {
    const map: FieldMap = {
      videoId: 'id',
      title: '',
      likeCount: '',
      commentCount: 'comments',
      videoUrl: '',
      cover: '',
      author: '',
      publishTime: '',
    };
    const missing = getMissingFields(map);
    expect(missing).toContain('title');
    expect(missing).toContain('likeCount');
    expect(missing).toContain('videoUrl');
    expect(missing).toContain('cover');
    expect(missing).toContain('author');
    expect(missing).toContain('publishTime');
    expect(missing).not.toContain('videoId');
    expect(missing).not.toContain('commentCount');
  });

  it('完整配置返回空数组', () => {
    const map: FieldMap = {
      videoId: 'id',
      title: 'desc',
      likeCount: 'likes',
      commentCount: 'comments',
      videoUrl: 'url',
      cover: 'cover',
      author: 'author',
      publishTime: 'time',
    };
    expect(getMissingFields(map)).toEqual([]);
  });
});
