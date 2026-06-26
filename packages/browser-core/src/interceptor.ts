import { Page, CDPSession } from 'patchright';
import { rootLogger } from '../logger';
import { MaintenanceProbe } from './maintenanceProbe';
const logger = rootLogger.child({ name: 'interceptor' });

export interface InterceptedResponse {
  url: string;
  status: number;
  body: any;
  timestamp: number;
  hasMore?: boolean;
  cursor?: string;
  requestBody?: any;
}

export interface ValidationRejection {
  timestamp: number;
  requestUrl: string;
  pageUrl: string;
  pattern: string;
  reason: 'wrong_page' | 'no_items' | 'missing_fields' | 'empty_body' | 'parse_error' | 'wrong_params';
  detail: string;
}

export interface ValidationConfig {
  expectedPageUrls: string[];
  requiredItemFields: string[];
  minItems?: number;
  requiredUrlParams?: string[];
}

function extractHasMore(body: any): boolean | undefined {
  if (body === null || body === undefined) return undefined;
  // 抖音：has_more 是 number（0=无更多，非0=有更多）
  if (typeof body.has_more === 'number') return body.has_more !== 0;
  if (typeof body.has_more === 'boolean') return body.has_more;
  if (body.data && typeof body.data.has_more === 'number') return body.data.has_more !== 0;
  if (body.data && typeof body.data.has_more === 'boolean') return body.data.has_more;
  if (body.pagination && typeof body.pagination.has_more === 'boolean') return body.pagination.has_more;
  if (body.cursor_info && typeof body.cursor_info.has_more === 'boolean') return body.cursor_info.has_more;
  if (body.data && typeof body.data.page === 'number') {
    if (body.data.page === -1) return false;
    if (body.data.page > 0) return true;
  }
  // 快手：pcursor 存在则有更多
  if (body.data && body.data.pcursor !== undefined && body.data.pcursor !== null && body.data.pcursor !== '') return true;
  // 视频号：downContinueFlag (0=无更多, 非0=有更多)
  if (body.data && typeof body.data.downContinueFlag === 'number') return body.data.downContinueFlag !== 0;
  // 视频号：continueFlag (布尔值)
  if (body.data && typeof body.data.continueFlag === 'boolean') return body.data.continueFlag;
  return undefined;
}

function extractCursor(body: any): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (body.cursor !== undefined) {
    if (typeof body.cursor === 'string') return body.cursor;
    if (typeof body.cursor === 'object' && body.cursor.max !== undefined) return String(body.cursor.max);
    return String(body.cursor);
  }
  if (body.data?.cursor !== undefined) return String(body.data.cursor);
  if (body.pagination?.cursor !== undefined) return String(body.pagination.cursor);
  // 腾讯视频号: lastBuff (分页游标)
  if (body.data?.lastBuff !== undefined) return String(body.data.lastBuff);
  return undefined;
}

function extractItems(body: any): any[] {
  if (!body || typeof body !== 'object') return [];
  const items = body.items;
  if (Array.isArray(items)) return items;
  const videoList = body.video_list;
  if (Array.isArray(videoList)) return videoList;
  const dataItems = body.data?.items;
  if (Array.isArray(dataItems)) return dataItems;
  const dataList = body.data?.list;
  if (Array.isArray(dataList)) return dataList;
  const dataVideoList = body.data?.videoList;
  if (Array.isArray(dataVideoList)) return dataVideoList;
  const photoItems = body.data?.photoList?.photoItems;
  if (Array.isArray(photoItems)) return photoItems;
  // 快手作品分析API可能的其他路径
  const photoList = body.data?.photoList;
  if (Array.isArray(photoList)) return photoList;
  const analysisList = body.data?.analysisList;
  if (Array.isArray(analysisList)) return analysisList;
  const worksList = body.data?.worksList;
  if (Array.isArray(worksList)) return worksList;
  // 小红书笔记列表 API
  const dataNotes = body.data?.notes;
  if (Array.isArray(dataNotes)) return dataNotes;
  const noteInfos = body.data?.note_infos;
  if (Array.isArray(noteInfos)) return noteInfos;
  // 小红书可能的其他嵌套路径
  const xhsNotes = body.data?.note_list;
  if (Array.isArray(xhsNotes)) return xhsNotes;
  const xhsItems = body.data?.data?.items;
  if (Array.isArray(xhsItems)) return xhsItems;
  // 抖音评论管理页面
  const douyinComments = body.comments;
  if (Array.isArray(douyinComments)) return douyinComments;
  // 小红书评论
  const xhsComments = body.data?.comments;
  if (Array.isArray(xhsComments)) return xhsComments;
  // 视频号评论
  const tencentComments = body.data?.comment;
  if (Array.isArray(tencentComments)) return tencentComments;
  return [];
}

export function parseVideoItem(item: any): { aweme_id: string; description: string; create_time: number; comment_count: number; metrics: Record<string, any> } | null {
  if (!item || typeof item !== 'object') return null;

  const awemeId = item.aweme_id || item.id || item.item_id || item.video_id || item.workId || item.photoId || item.note_id || item.noteId || '';
  if (!awemeId) return null;

  const desc = item.description || item.display_title || item.title || item.desc || item.caption || '';

  let createTime = item.create_time || item.publish_time || item.published_at || item.createTime || item.timestamp || item.uploadTime || item.publishTime || item.post_time || 0;
  if (typeof createTime === 'string') {
    const parsed = Date.parse(createTime);
    if (!isNaN(parsed)) {
      createTime = Math.floor(parsed / 1000);
    } else {
      createTime = parseInt(createTime, 10);
    }
  }
  if (createTime > 1e12) createTime = Math.floor(createTime / 1000);
  if (isNaN(createTime)) createTime = 0;

  // 合并 metrics/stat/stats/interactInfo 对象，兼容各平台 API 响应
  // 小红书使用 interact_info（蛇形），其他平台使用 interactInfo（驼峰）
  const metrics = item.metrics || item.stat || item.stats || item.interactInfo || item.interact_info || {};
  const rawCommentCount = item.comment_count
    || item.comments_count
    || item.commentCount
    || metrics?.comment_count
    || metrics?.commentCount
    || item.stat?.comment_count
    || item.stat?.commentCount
    || item.stats?.comment_count
    || item.stats?.commentCount
    || item.interactInfo?.comment_count
    || item.interactInfo?.commentCount
    || item.interact_info?.comment_count
    || item.interact_info?.commentCount
    || 0;
  const commentCount = typeof rawCommentCount === 'string'
    ? parseInt(rawCommentCount, 10) || 0
    : Number(rawCommentCount) || 0;

  // 诊断：首条视频打印字段快照，帮助调试 comment_count=0 问题
  if (commentCount === 0 && awemeId && typeof item === 'object') {
    const itemKeys = Object.keys(item).slice(0, 15);
    const nestedKeys = Object.keys(metrics).slice(0, 10);
    const commentFields = {
      'item.comment_count': item.comment_count,
      'item.comments_count': item.comments_count,
      'item.commentCount': item.commentCount,
      'metrics.comment_count': metrics?.comment_count,
      'metrics.commentCount': metrics?.commentCount,
      'stat.comment_count': item.stat?.comment_count,
      'stat.commentCount': item.stat?.commentCount,
      'stats.comment_count': item.stats?.comment_count,
      'stats.commentCount': item.stats?.commentCount,
      'interactInfo.comment_count': item.interactInfo?.comment_count,
      'interactInfo.commentCount': item.interactInfo?.commentCount,
      'interact_info.comment_count': item.interact_info?.comment_count,
      'interact_info.commentCount': item.interact_info?.commentCount,
    };
    logger.warn({ awemeId, itemKeys, nestedKeys, commentFields },
      'parseVideoItem: comment_count=0 — item field scan for debugging');
  }

  return {
    aweme_id: String(awemeId),
    description: String(desc),
    create_time: Number(createTime),
    comment_count: commentCount,
    metrics,
  };
}

function validatePageContext(requestUrl: string, expectedUrls: string[]): boolean {
  for (const expected of expectedUrls) {
    if (requestUrl.includes(expected)) return true;
  }
  return false;
}

function validateResponseStructure(body: any, requiredFields: string[], minItems: number = 0): { valid: boolean; reason?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'empty_body' };
  }

  const items = extractItems(body);
  if (!Array.isArray(items)) {
    return { valid: false, reason: 'no_items' };
  }

  if (items.length < minItems) {
    return { valid: false, reason: `too_few_items: got ${items.length}, min ${minItems}` };
  }

  if (requiredFields.length > 0 && items.length > 0) {
    const sample = items[0];
    const missing = requiredFields.filter(f => {
      if (f.includes('.')) {
        const parts = f.split('.');
        let current: any = sample;
        for (const part of parts) {
          if (current === null || current === undefined || typeof current !== 'object') return true;
          current = current[part];
        }
        return current === undefined;
      }
      return !(f in sample) && sample[f] === undefined;
    });
    if (missing.length > 0) {
      return { valid: false, reason: `missing_fields: ${missing.join(', ')} in first item` };
    }
  }

  return { valid: true };
}

export class RequestInterceptor {
  private interceptedData: Map<string, InterceptedResponse[]> = new Map();
  private validationConfigs: Map<string, ValidationConfig> = new Map();
  private rejectionLog: ValidationRejection[] = [];
  private activeListeners: Map<string, { cdp: CDPSession; cdpHandler: (params: any) => void; page: Page; pageHandler: (response: any) => void }> = new Map();
  private capturedUrls: Map<string, Set<string>> = new Map();
  private pageIdCounter = 0;
  private waitForResponseCount = 0;
  private antiDetectionMetrics = { interceptorOnlySuccess: 0, interceptorOnlyFailure: 0, fallbackToDom: 0 };

  setValidationConfig(pattern: string, config: ValidationConfig): void {
    this.validationConfigs.set(pattern, config);
    logger.info({ pattern, expectedPages: config.expectedPageUrls, requiredFields: config.requiredItemFields }, 'Validation config set');
  }

  async attachByConfig(page: Page, platform: string, keys: string[], config: Record<string, any>): Promise<string[]> {
    // 收集所有不重复的 URL pattern
    const allPatterns: string[] = [];
    for (const key of keys) {
      const entry = config[key];
      if (entry?.url_patterns) {
        for (const pat of entry.url_patterns) {
          if (!allPatterns.includes(pat)) {
            allPatterns.push(pat);
          }
        }
      }
    }

    // 一次性注册所有 pattern
    const pageId = await this.register(page, allPatterns);

    // 为每个 pattern 设置独立验证配置
    for (const key of keys) {
      const entry = config[key];
      if (entry?.url_patterns && entry?.validation) {
        const validationConfig: ValidationConfig = {
          expectedPageUrls: entry.validation.expected_page_urls || [],
          requiredItemFields: entry.validation.required_body_fields || [],
          minItems: entry.validation.min_items,
          requiredUrlParams: entry.validation.required_url_params,
        };
        // requiredBodyFields 别名（供 attachByConfig 调用方使用）
        (validationConfig as any).requiredBodyFields = entry.validation.required_body_fields || [];
        for (const pat of entry.url_patterns) {
          this.setValidationConfig(pat, validationConfig);
        }
      }
    }

    return [pageId];
  }

  hotReloadRules(config: Record<string, any>): void {
    for (const key of Object.keys(config)) {
      const entry = config[key];
      if (entry?.url_patterns && entry?.validation) {
        const validationConfig: ValidationConfig = {
          expectedPageUrls: entry.validation.expected_page_urls || [],
          requiredItemFields: entry.validation.required_body_fields || [],
          minItems: entry.validation.min_items,
          requiredUrlParams: entry.validation.required_url_params,
        };
        // requiredBodyFields 别名（供 hotReloadRules 调用方使用）
        (validationConfig as any).requiredBodyFields = entry.validation.required_body_fields || [];
        for (const pat of entry.url_patterns) {
          this.setValidationConfig(pat, validationConfig);
        }
      }
    }
  }

  getRejectionLog(limit: number = 50): ValidationRejection[] {
    return this.rejectionLog.slice(-limit);
  }

  clearRejectionLog(): void {
    this.rejectionLog = [];
  }

  async register(page: Page, urlPatterns: string[]): Promise<string> {
    const pageId = `page_${++this.pageIdCounter}_${Date.now()}`;

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');

    const cdpHandler = (params: any) => {
      const requestUrl: string = params.response?.url || '';
      const status: number = params.response?.status || 0;

      const matchedPattern = urlPatterns.find(pattern => requestUrl.includes(pattern));
      if (!matchedPattern) return;

      logger.info(`[CDP] Matched: url=${requestUrl.substring(0, 150)} pattern=${matchedPattern} status=${status}`);

      const validationConfig = this.validationConfigs.get(matchedPattern);

      if (validationConfig?.requiredUrlParams) {
        const hasRequiredParams = validationConfig.requiredUrlParams.every(
          param => requestUrl.includes(param)
        );
        if (!hasRequiredParams) {
          logger.warn({ pattern: matchedPattern, url: requestUrl.substring(0, 200), requiredParams: validationConfig.requiredUrlParams }, 'REJECTED: URL missing required params — response will NOT be stored');
          return;
        }
      }

      const requestId = params.requestId;

      // 获取 POST 请求体（用于关联子评论到根评论）
      const getRequestBody = cdp.send('Network.getRequestPostData', { requestId }).then((postData: any) => {
        if (postData?.postData) return JSON.parse(postData.postData);
        return undefined;
      }).catch(() => undefined);

      getRequestBody.then((requestBody: any) => {
      cdp.send('Network.getResponseBody', { requestId }).then(async (bodyResult: any) => {
        const bodyStr = bodyResult?.body || '';
        let body: any = null;

        try {
          body = JSON.parse(bodyStr);
        } catch {
          this.logRejection(matchedPattern, requestUrl, '(unknown)', 'parse_error', 'Failed to parse JSON response body');
          return;
        }

        if (validationConfig) {
          const pageUrl = await this.getPageUrl(page).catch(() => '(unavailable)');

          const pageValid = validatePageContext(pageUrl, validationConfig.expectedPageUrls);
          if (!pageValid) {
            this.logRejection(matchedPattern, requestUrl, pageUrl, 'wrong_page',
              `Page URL "${pageUrl}" does not match expected patterns: ${validationConfig.expectedPageUrls.join(', ')}`);
            return;
          }

          const structureValid = validateResponseStructure(body, validationConfig.requiredItemFields, validationConfig.minItems ?? 1);
          if (!structureValid.valid) {
            this.logRejection(matchedPattern, requestUrl, pageUrl, structureValid.reason as ValidationRejection['reason'],
              `Response structure invalid: ${structureValid.reason}. Page: ${pageUrl}`);
            return;
          }

          logger.info({
            pattern: matchedPattern,
            pageUrl,
            url: requestUrl.substring(0, 120),
            status,
            validated: true,
            source: 'cdp',
          }, 'Response passed validation');
        }

        this.storeResponse(matchedPattern, requestUrl, status, body, requestBody);
      }).catch((err: any) => {
        logger.debug({ pattern: matchedPattern, requestId, err: String(err)?.substring(0, 100) }, 'CDP getResponseBody failed');
      });
      }); // close getRequestBody.then
    };

    const pageHandler = async (response: any) => {
      const requestUrl: string = response.url();
      const status: number = response.status();

      // 诊断日志：捕获所有评论相关的 API 请求（用于调试拦截器模式匹配）
      if (requestUrl.includes('comment') || requestUrl.includes('Comment')) {
        const matched = urlPatterns.filter(p => requestUrl.includes(p));
        logger.info(`[Interceptor] Comment API: url=${requestUrl.substring(0, 150)} status=${status} matched=${matched.join(',')} patterns=${urlPatterns.join(',')}`);
      }

      const matchedPattern = urlPatterns.find(pattern => requestUrl.includes(pattern));
      if (!matchedPattern) return;

      const urlSet = this.capturedUrls.get(matchedPattern);
      if (urlSet && urlSet.has(requestUrl)) return;

      const validationConfig = this.validationConfigs.get(matchedPattern);

      if (validationConfig?.requiredUrlParams) {
        const hasRequiredParams = validationConfig.requiredUrlParams.every(
          param => requestUrl.includes(param)
        );
        if (!hasRequiredParams) return;
      }

      let body: any = null;
      try {
        const bodyStr = await response.text();
        body = JSON.parse(bodyStr);
      } catch {
        return;
      }

      if (validationConfig) {
        const pageUrl = await this.getPageUrl(page).catch(() => '(unavailable)');

        const pageValid = validatePageContext(pageUrl, validationConfig.expectedPageUrls);
        if (!pageValid) {
          this.logRejection(matchedPattern, requestUrl, pageUrl, 'wrong_page',
            `Page URL "${pageUrl}" does not match expected patterns: ${validationConfig.expectedPageUrls.join(', ')}`);
          return;
        }

        const structureValid = validateResponseStructure(body, validationConfig.requiredItemFields, validationConfig.minItems ?? 1);
        if (!structureValid.valid) {
          this.logRejection(matchedPattern, requestUrl, pageUrl, structureValid.reason as ValidationRejection['reason'],
            `Response structure invalid: ${structureValid.reason}. Page: ${pageUrl}`);
          return;
        }

        logger.info({
          pattern: matchedPattern,
          pageUrl,
          url: requestUrl.substring(0, 120),
          status,
          validated: true,
          source: 'page_listener',
        }, 'Response passed validation');
      }

      // 获取 POST 请求体
      let requestBody: any = undefined;
      try {
        const req = response.request();
        const postData = req.postData();
        if (postData) {
          requestBody = JSON.parse(postData);
        }
      } catch {}

      this.storeResponse(matchedPattern, requestUrl, status, body, requestBody);
    };

    cdp.on('Network.responseReceived', cdpHandler);
    page.on('response', pageHandler);

    this.activeListeners.set(pageId, { cdp, cdpHandler, page, pageHandler });

    logger.info({ pageId, patterns: urlPatterns }, 'Passive listener registered (CDP + page.on)');

    return pageId;
  }

  private storeResponse(pattern: string, url: string, status: number, body: any, requestBody?: any): void {
    let urlSet = this.capturedUrls.get(pattern);
    if (!urlSet) {
      urlSet = new Set();
      this.capturedUrls.set(pattern, urlSet);
    }

    // 去重键：对于 POST 请求（有 requestBody），使用 URL + 请求体摘要
    // 这样同一 URL 但不同分页参数的 POST 请求不会被去重跳过
    let dedupKey = url;
    if (requestBody && typeof requestBody === 'object') {
      // 提取关键分页字段作为去重标识
      const pageKey = requestBody.lastBuff || requestBody.lastBuffer || requestBody.pcursor || requestBody.cursor || '';
      const commentId = requestBody.commentId || '';
      if (pageKey || commentId) {
        dedupKey = `${url}::__page__${pageKey}__comment__${commentId}`;
      }
    }

    if (urlSet.has(dedupKey)) {
      logger.info(`[Interceptor] storeResponse SKIP (already captured): pattern=${pattern} dedupKey=${dedupKey.substring(0, 150)}`);
      return;
    }
    urlSet.add(dedupKey);
    logger.info(`[Interceptor] storeResponse STORE: pattern=${pattern} url=${url.substring(0, 100)} status=${status}`);

    const intercepted: InterceptedResponse = {
      url,
      status,
      body,
      timestamp: Date.now(),
      hasMore: extractHasMore(body),
      cursor: extractCursor(body),
      requestBody,
    };

    const existing = this.interceptedData.get(pattern) || [];
    existing.push(intercepted);
    this.interceptedData.set(pattern, existing);

    const items = extractItems(body);
    // 诊断增强：统计评论数分布 + 嵌套字段检查
    const commentStats = items.length > 0 ? {
      total: items.length,
      zeroCount: items.filter((i: any) => !(i.commentCount ?? i.comment_count ?? i.metrics?.comment_count ?? i.stat?.commentCount)).length,
      nonZeroCount: items.filter((i: any) => (i.commentCount ?? i.comment_count ?? i.metrics?.comment_count ?? i.stat?.commentCount)).length,
    } : null;
    const firstItem = items.length > 0 ? items[0] : null;
    const nestedMetrics = firstItem?.metrics ? Object.keys(firstItem.metrics).slice(0, 10) : [];
    logger.info({
      pattern,
      url: url.substring(0, 120),
      status,
      hasMore: intercepted.hasMore,
      cursor: intercepted.cursor,
      itemCount: items.length,
      commentStats,
      // 诊断：记录第一个item的顶层级字段 + metrics嵌套字段
      sampleItemKeys: firstItem ? Object.keys(firstItem).slice(0, 20) : [],
      sampleMetricsKeys: nestedMetrics,
      sampleCommentField: firstItem ? (
        firstItem.commentCount ?? firstItem.comment_count ?? firstItem.metrics?.comment_count ?? firstItem.stat?.commentCount ?? firstItem.stats?.commentCount ?? 'NOT_FOUND'
      ) : 'NO_ITEMS',
      // 完整打印第一个item的前30个键值对（字符串化以控制日志大小）
      rawFirstItemStr: firstItem ? JSON.stringify(firstItem).substring(0, 800) : 'NO_ITEMS',
    }, 'Response captured and stored');

    // 探针记录：URL 拦截匹配成功
    void MaintenanceProbe.recordUrlIntercept({
      healthKey: pattern,
      urlPattern: pattern,
      actualUrl: url,
      httpStatus: status,
      result: 'matched',
      itemsFound: items.length,
      hasMore: intercepted.hasMore,
      cursorValue: intercepted.cursor,
      durationMs: 0,
      responseSize: JSON.stringify(body).length,
    });
  }

  private async getPageUrl(page: Page): Promise<string> {
    try {
      return page.url();
    } catch {
      return '(unavailable)';
    }
  }

  private logRejection(pattern: string, requestUrl: string, pageUrl: string, reason: ValidationRejection['reason'], detail: string): void {
    const rejection: ValidationRejection = {
      timestamp: Date.now(),
      requestUrl: requestUrl.substring(0, 200),
      pageUrl,
      pattern,
      reason,
      detail,
    };
    this.rejectionLog.push(rejection);

    if (this.rejectionLog.length > 200) {
      this.rejectionLog = this.rejectionLog.slice(-200);
    }

    logger.warn({
      pattern,
      reason,
      pageUrl,
      requestUrl: requestUrl.substring(0, 120),
      detail,
    }, 'API response rejected by validator');

    // 探针记录：验证失败
    void MaintenanceProbe.recordUrlIntercept({
      healthKey: pattern,
      urlPattern: pattern,
      actualUrl: requestUrl,
      httpStatus: 0,
      result: 'validation_failed',
      validationStep: reason,
      durationMs: 0,
      responseSize: 0,
    });
  }

  unregister(pageId: string): void {
    const listener = this.activeListeners.get(pageId);
    if (listener) {
      try {
        listener.cdp.off('Network.responseReceived', listener.cdpHandler);
        listener.cdp.send('Network.disable').catch(() => {});
        listener.cdp.detach().catch(() => {});
      } catch {}
      try {
        listener.page.off('response', listener.pageHandler);
      } catch {}
      this.activeListeners.delete(pageId);
      logger.info({ pageId }, 'Passive listener unregistered');
    }
  }

  unregisterAll(): void {
    for (const [pageId, listener] of this.activeListeners) {
      try {
        listener.cdp.off('Network.responseReceived', listener.cdpHandler);
        listener.cdp.send('Network.disable').catch(() => {});
        listener.cdp.detach().catch(() => {});
      } catch {}
      try {
        listener.page.off('response', listener.pageHandler);
      } catch {}
    }
    this.activeListeners.clear();
    logger.info('All passive listeners unregistered');
  }

  getResponses(pattern: string): InterceptedResponse[] {
    return this.interceptedData.get(pattern) || [];
  }

  getResponseCount(pattern: string): number {
    return this.getResponses(pattern).length;
  }

  getLatestResponse(pattern: string): InterceptedResponse | null {
    const responses = this.getResponses(pattern);
    return responses.length > 0 ? responses[responses.length - 1] : null;
  }

  async collectResponses(
    pattern: string,
    opts: { until?: (r: InterceptedResponse) => boolean; maxItems: number; pollMs: number; timeoutMs: number },
  ): Promise<InterceptedResponse[]> {
    const collected: InterceptedResponse[] = [];
    const deadline = Date.now() + opts.timeoutMs;
    let seenIndex = 0;
    while (Date.now() < deadline && collected.length < opts.maxItems) {
      const all = this.getResponses(pattern);
      while (seenIndex < all.length && collected.length < opts.maxItems) {
        const r = all[seenIndex++];
        collected.push(r);
        if (opts.until && opts.until(r)) return collected;
      }
      if (collected.length >= opts.maxItems) break;
      await new Promise(resolve => setTimeout(resolve, opts.pollMs));
    }
    return collected;
  }

  async pollStatus(
    pattern: string,
    opts: { predicate: (r: InterceptedResponse) => boolean; pollMs: number; timeoutMs: number },
  ): Promise<InterceptedResponse | null> {
    const deadline = Date.now() + opts.timeoutMs;
    let seenIndex = 0;
    while (Date.now() < deadline) {
      const all = this.getResponses(pattern);
      while (seenIndex < all.length) {
        const r = all[seenIndex++];
        if (opts.predicate(r)) return r;
      }
      await new Promise(resolve => setTimeout(resolve, opts.pollMs));
    }
    return null;
  }

  private shouldSampleNoFallback(): boolean {
    this.waitForResponseCount++;
    return this.waitForResponseCount % 100 === 0; // 每 100 次 1 次
  }

  getAntiDetectionMetrics(): { interceptorOnlySuccess: number; interceptorOnlyFailure: number; fallbackToDom: number } {
    return { ...this.antiDetectionMetrics };
  }

  clear(pattern: string): void {
    this.interceptedData.delete(pattern);
    this.capturedUrls.delete(pattern);
  }

  clearAll(): void {
    this.interceptedData.clear();
    this.capturedUrls.clear();
  }

  async waitForResponse(
    pattern: string,
    timeoutMsOrOpts: number | { timeoutMs: number; predicate?: (response: InterceptedResponse) => boolean; sampleNoFallback?: boolean } = 15000,
    predicate?: (response: InterceptedResponse) => boolean,
  ): Promise<InterceptedResponse | null> {
    // Normalize arguments to support both old (timeoutMs, predicate) and new (opts) signatures
    const opts = typeof timeoutMsOrOpts === 'object'
      ? timeoutMsOrOpts
      : { timeoutMs: timeoutMsOrOpts, predicate };
    const startTime = Date.now();
    const isSampling = opts.sampleNoFallback === true;

    while (Date.now() - startTime < opts.timeoutMs) {
      const responses = this.getResponses(pattern);
      if (responses.length > 0) {
        for (let i = responses.length - 1; i >= 0; i--) {
          const r = responses[i];
          if (!opts.predicate || opts.predicate(r)) {
            if (isSampling) this.antiDetectionMetrics.interceptorOnlySuccess++;
            return r;
          }
        }
      }
      if (Date.now() - startTime > 5000 && responses.length === 0) {
        logger.debug({ pattern, elapsed: Date.now() - startTime, rejectionCount: this.rejectionLog.length }, 'Still waiting for validated response');
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    logger.debug({ pattern, timeoutMs: opts.timeoutMs, dataKeys: [...this.interceptedData.keys()], rejectionCount: this.rejectionLog.length }, 'waitForResponse timed out');
    if (isSampling) this.antiDetectionMetrics.interceptorOnlyFailure++;
    else this.antiDetectionMetrics.fallbackToDom++;
    return null;
  }

  async waitForNewResponse(
    pattern: string,
    previousCount: number,
    timeoutMs: number = 10000
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const currentCount = this.getResponseCount(pattern);
      if (currentCount > previousCount) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return false;
  }

  hasDataExhausted(pattern: string): boolean {
    const latest = this.getLatestResponse(pattern);
    if (!latest) return false;

    if (latest.hasMore === false) return true;

    return false;
  }

  getCollectedCount(pattern: string): number {
    const responses = this.getResponses(pattern);
    let count = 0;
    for (const r of responses) {
      const items = extractItems(r.body);
      count += items.length;
    }
    return count;
  }

  getCollectedItems(pattern: string): any[] {
    const responses = this.getResponses(pattern);
    const allItems: any[] = [];
    const seen = new Set<string>();

    for (const r of responses) {
      const items = extractItems(r.body);
      for (const item of items) {
        const parsed = parseVideoItem(item);
        if (parsed && !seen.has(parsed.aweme_id)) {
          seen.add(parsed.aweme_id);
          allItems.push(parsed);
        }
      }
    }

    return allItems;
  }
}
