import { Page, CDPSession } from 'patchright';
import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'interceptor' });

export interface InterceptedResponse {
  url: string;
  status: number;
  body: any;
  timestamp: number;
  hasMore?: boolean;
  cursor?: string;
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
  if (typeof body.has_more === 'boolean') return body.has_more;
  if (body.data && typeof body.data.has_more === 'boolean') return body.data.has_more;
  if (body.pagination && typeof body.pagination.has_more === 'boolean') return body.pagination.has_more;
  if (body.cursor_info && typeof body.cursor_info.has_more === 'boolean') return body.cursor_info.has_more;
  if (body.data && typeof body.data.page === 'number') {
    if (body.data.page === -1) return false;
    if (body.data.page > 0) return true;
  }
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
  const dataNotes = body.data?.notes;
  if (Array.isArray(dataNotes)) return dataNotes;
  const noteInfos = body.data?.note_infos;
  if (Array.isArray(noteInfos)) return noteInfos;
  return [];
}

export function parseVideoItem(item: any): { aweme_id: string; description: string; create_time: number; comment_count: number; metrics: Record<string, any> } | null {
  if (!item || typeof item !== 'object') return null;

  const awemeId = item.aweme_id || item.id || item.item_id || item.video_id || item.workId || item.photoId || '';
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
  const metrics = item.metrics || item.stat || item.stats || item.interactInfo || {};
  const rawCommentCount = item.comment_count
    || item.comments_count
    || item.commentCount
    || metrics?.comment_count
    || metrics?.commentCount
    || item.stat?.commentCount
    || item.stat?.comment_count
    || item.stats?.commentCount
    || item.stats?.comment_count
    || item.interactInfo?.commentCount
    || item.interactInfo?.comment_count
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

  setValidationConfig(pattern: string, config: ValidationConfig): void {
    this.validationConfigs.set(pattern, config);
    logger.info({ pattern, expectedPages: config.expectedPageUrls, requiredFields: config.requiredItemFields }, 'Validation config set');
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

        this.storeResponse(matchedPattern, requestUrl, status, body);
      }).catch((err: any) => {
        logger.debug({ pattern: matchedPattern, requestId, err: String(err)?.substring(0, 100) }, 'CDP getResponseBody failed');
      });
    };

    const pageHandler = async (response: any) => {
      const requestUrl: string = response.url();
      const status: number = response.status();

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

      this.storeResponse(matchedPattern, requestUrl, status, body);
    };

    cdp.on('Network.responseReceived', cdpHandler);
    page.on('response', pageHandler);

    this.activeListeners.set(pageId, { cdp, cdpHandler, page, pageHandler });

    logger.info({ pageId, patterns: urlPatterns }, 'Passive listener registered (CDP + page.on)');

    return pageId;
  }

  private storeResponse(pattern: string, url: string, status: number, body: any): void {
    let urlSet = this.capturedUrls.get(pattern);
    if (!urlSet) {
      urlSet = new Set();
      this.capturedUrls.set(pattern, urlSet);
    }
    if (urlSet.has(url)) return;
    urlSet.add(url);

    const intercepted: InterceptedResponse = {
      url,
      status,
      body,
      timestamp: Date.now(),
      hasMore: extractHasMore(body),
      cursor: extractCursor(body),
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
    timeoutMs: number = 15000,
    predicate?: (response: InterceptedResponse) => boolean
  ): Promise<InterceptedResponse | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const responses = this.getResponses(pattern);
      if (responses.length > 0) {
        for (let i = responses.length - 1; i >= 0; i--) {
          const r = responses[i];
          if (!predicate || predicate(r)) {
            return r;
          }
        }
      }
      if (Date.now() - startTime > 5000 && responses.length === 0) {
        logger.debug({ pattern, elapsed: Date.now() - startTime, rejectionCount: this.rejectionLog.length }, 'Still waiting for validated response');
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    logger.debug({ pattern, timeoutMs, dataKeys: [...this.interceptedData.keys()], rejectionCount: this.rejectionLog.length }, 'waitForResponse timed out');
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
