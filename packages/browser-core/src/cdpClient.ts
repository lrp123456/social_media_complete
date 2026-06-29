import { CDPSession } from 'patchright';
import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'cdpClient' });

const DEFAULT_CDP_TIMEOUT = 15000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP operation timeout: ${operationName} (${timeoutMs}ms)`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export interface DOMNode {
  nodeId: number;
  backendNodeId?: number;
  nodeName?: string;
  localName?: string;
  nodeValue?: string;
  childNodeCount?: number;
  children?: DOMNode[];
  attributes?: string[];
  documentURL?: string;
}

export interface BoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CDPClient {
  private session: CDPSession;
  private documentNodeId: number = -1;

  constructor(session: CDPSession) {
    this.session = session;
  }

  async init(): Promise<void> {
    await withTimeout(this.send('DOM.enable', {}), DEFAULT_CDP_TIMEOUT, 'DOM.enable');
    const doc = await withTimeout(this.send('DOM.getDocument', { depth: 0 }), DEFAULT_CDP_TIMEOUT, 'DOM.getDocument');
    this.documentNodeId = doc.root.nodeId;
    logger.info({ documentNodeId: this.documentNodeId }, 'CDPClient initialized');
  }

  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    try {
      return await withTimeout(this.session.send(method as any, params as any), DEFAULT_CDP_TIMEOUT, method);
    } catch (error: any) {
      logger.debug({ method, error: error.message }, 'CDP command failed');
      throw error;
    }
  }

  async querySelector(selector: string, parentNodeId?: number): Promise<number | null> {
    const rootId = parentNodeId ?? this.documentNodeId;
    if (rootId < 0) {
      throw new Error('CDPClient not initialized - call init() first');
    }

    // 1. xpath= 前缀: 用 document.evaluate
    if (selector.startsWith('xpath=')) {
      return this.querySelectorByXpath(selector.slice(6));
    }

    // 2. getByRole / getByText / getByPlaceholder: Playwright 链式定位, JS 翻译后用 Runtime.evaluate
    if (selector.startsWith('getByRole(') || selector.startsWith('getByText(') || selector.startsWith('getByPlaceholder(')) {
      return this.querySelectorByPlaywrightSyntax(selector);
    }

    // 3. 拆 :visible 后缀: raw CDP DOM.querySelector 不支持
    let cssSel = selector;
    let requireVisible = false;
    if (cssSel.endsWith(':visible')) {
      cssSel = cssSel.slice(0, -':visible'.length).trimEnd();
      requireVisible = true;
    }

    // 3.5. 处理 :has-text("X") 扩展: 转成 JS 表达式 (CSS 原生不支持)
    const hasTextExtraction = this.extractHasText(cssSel);
    if (hasTextExtraction.hasText) {
      return this.querySelectorByHasText(hasTextExtraction.baseSel, hasTextExtraction.hasText, requireVisible);
    }

    // 4. 主线: DOM.querySelector
    let nodeId: number | null = null;
    try {
      const result = await this.send('DOM.querySelector', {
        nodeId: rootId,
        selector: cssSel,
      });
      nodeId = result.nodeId || null;
    } catch {
      nodeId = null;
    }

    // 5. 回退: DOM.querySelector 拒绝了"奇怪"选择器时, 用 Runtime.evaluate 走 document.querySelector
    if (!nodeId || nodeId <= 0) {
      const fallbackNodeId = await this.querySelectorByJS(cssSel);
      if (fallbackNodeId) nodeId = fallbackNodeId;
    }

    if (!nodeId || nodeId <= 0) return null;

    // 6. :visible 后置检查: 模仿 Playwright 的可见性语义
    if (requireVisible) {
      const visible = await this.checkNodeVisible(nodeId);
      if (!visible) return null;
    }

    return nodeId;
  }

  async querySelectorAll(selector: string, parentNodeId?: number): Promise<number[]> {
    const rootId = parentNodeId ?? this.documentNodeId;

    if (selector.startsWith('xpath=')) {
      return this.querySelectorAllByXpath(selector.slice(6));
    }
    if (selector.startsWith('getByRole(') || selector.startsWith('getByText(') || selector.startsWith('getByPlaceholder(')) {
      return this.querySelectorAllByPlaywrightSyntax(selector);
    }

    let cssSel = selector;
    let requireVisible = false;
    if (cssSel.endsWith(':visible')) {
      cssSel = cssSel.slice(0, -':visible'.length).trimEnd();
      requireVisible = true;
    }

    // :has-text 扩展
    const hasTextExtraction = this.extractHasText(cssSel);
    if (hasTextExtraction.hasText) {
      return this.querySelectorAllByHasText(hasTextExtraction.baseSel, hasTextExtraction.hasText, requireVisible);
    }

    let nodeIds: number[] = [];
    try {
      const result = await this.send('DOM.querySelectorAll', {
        nodeId: rootId,
        selector: cssSel,
      });
      nodeIds = result.nodeIds || [];
    } catch {
      nodeIds = [];
    }

    if (nodeIds.length === 0) {
      const fallbackIds = await this.querySelectorAllByJS(cssSel);
      if (fallbackIds.length > 0) nodeIds = fallbackIds;
    }

    if (requireVisible && nodeIds.length > 0) {
      const checks = await Promise.all(nodeIds.map((id) => this.checkNodeVisible(id)));
      nodeIds = nodeIds.filter((_, i) => checks[i]);
    }

    return nodeIds;
  }

  // ============================================================
  // Playwright 扩展语法支持: 走 Runtime.evaluate 拿到 JS 对象,
  // 再用 DOM.requestNode 把对象转成 CDP nodeId, 后续走标准流程
  // ============================================================

  /**
   * 把 `:has-text("X")` 从选择器中抽出来, 剩下 baseSel 用 CSS,
   * hasText 在 JS 里做内容匹配。X 必须是双引号或单引号包围的字符串。
   * 例: `div.semi-modal-content:has-text("未添加自主声明")` →
   *      baseSel = `div.semi-modal-content`, hasText = `未添加自主声明`
   */
  private extractHasText(selector: string): { baseSel: string; hasText: string | null } {
    const m = selector.match(/^(.*?):has-text\(\s*(["'])([^"']+)\2\s*\)\s*$/);
    if (!m) return { baseSel: selector, hasText: null };
    return { baseSel: m[1].trim(), hasText: m[3] };
  }

  private async querySelectorByHasText(baseSel: string, hasText: string, requireVisible: boolean): Promise<number | null> {
    const visExpr = requireVisible ? this.jsVisibleFilter() : '() => true';
    const escBase = JSON.stringify(baseSel);
    const escText = JSON.stringify(hasText);
    const expression = `(() => {
      try {
        const els = Array.from(document.querySelectorAll(${escBase}));
        const fn = ${visExpr};
        return els.find((el) => {
          if (el.children.length > 0 && el.textContent && el.textContent.includes(${escText})) {
            return fn(el);
          }
          return false;
        }) || null;
      } catch { return null; }
    })()`;
    return this.evalAndRequestNode(expression);
  }

  private async querySelectorAllByHasText(baseSel: string, hasText: string, requireVisible: boolean): Promise<number[]> {
    const visExpr = requireVisible ? this.jsVisibleFilter() : '() => true';
    const escBase = JSON.stringify(baseSel);
    const escText = JSON.stringify(hasText);
    const expression = `(() => {
      try {
        const els = Array.from(document.querySelectorAll(${escBase}));
        const fn = ${visExpr};
        return els.filter((el) => {
          if (el.children.length > 0 && el.textContent && el.textContent.includes(${escText})) {
            return fn(el);
          }
          return false;
        });
      } catch { return []; }
    })()`;
    return this.evalArrayAndRequestNodes(expression);
  }

  private jsVisibleFilter(): string {
    return `(el) => {
      // 修复: 原代码用 && 应该是 || — 否则 offsetWidth=0 但 offsetHeight>0 的元素会被判为"可见"
      if (!(el.offsetWidth > 0) || !(el.offsetHeight > 0)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const op = parseFloat(style.opacity || '1');
      if (!isNaN(op) && op < 0.1) return false;
      return true;
    }`;
  }

  private async querySelectorByJS(selector: string): Promise<number | null> {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression: `(() => { try { return document.querySelector(${JSON.stringify(selector)}); } catch { return null; } })()`,
        returnByValue: false,
      });
      const objectId = result.result?.objectId;
      if (!objectId) return null;
      const nodeResult = await this.send('DOM.requestNode', { objectId });
      return nodeResult.nodeId || null;
    } catch {
      return null;
    }
  }

  private async querySelectorAllByJS(selector: string): Promise<number[]> {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression: `(() => { try { return Array.from(document.querySelectorAll(${JSON.stringify(selector)})); } catch { return []; } })()`,
        returnByValue: false,
      });
      const objectId = result.result?.objectId;
      if (!objectId) return [];
      const listResult = await this.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() { return this.map(() => null); }`,
        returnByValue: true,
      });
      // 用 callFunctionOn 把数组里的每个元素分别 requestNode
      const protoResult = await this.send('Runtime.getProperties', { objectId });
      const props = protoResult.result || [];
      const nodeIds: number[] = [];
      for (const prop of props) {
        if (typeof prop.name === 'string' && /^\d+$/.test(prop.name)) {
          const elemObjectId = prop.value?.objectId;
          if (!elemObjectId) continue;
          try {
            const nr = await this.send('DOM.requestNode', { objectId: elemObjectId });
            if (nr.nodeId) nodeIds.push(nr.nodeId);
          } catch { /* skip */ }
        }
      }
      return nodeIds;
    } catch {
      return [];
    }
  }

  private async querySelectorByXpath(xpath: string): Promise<number | null> {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression: `(() => {
          try {
            const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return r.singleNodeValue;
          } catch { return null; }
        })()`,
        returnByValue: false,
      });
      const objectId = result.result?.objectId;
      if (!objectId) return null;
      const nodeResult = await this.send('DOM.requestNode', { objectId });
      return nodeResult.nodeId || null;
    } catch {
      return null;
    }
  }

  private async querySelectorAllByXpath(xpath: string): Promise<number[]> {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression: `(() => {
          try {
            const r = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            const out = [];
            for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
            return out;
          } catch { return []; }
        })()`,
        returnByValue: false,
      });
      const objectId = result.result?.objectId;
      if (!objectId) return [];
      const props = await this.send('Runtime.getProperties', { objectId });
      const nodeIds: number[] = [];
      for (const prop of props.result || []) {
        if (typeof prop.name === 'string' && /^\d+$/.test(prop.name) && prop.value?.objectId) {
          try {
            const nr = await this.send('DOM.requestNode', { objectId: prop.value.objectId });
            if (nr.nodeId) nodeIds.push(nr.nodeId);
          } catch { /* skip */ }
        }
      }
      return nodeIds;
    } catch {
      return [];
    }
  }

  /**
   * 翻译 getByRole / getByText 成 JS 表达式, 用 Runtime.evaluate 找节点。
   * 简化版 Playwright 语义, 同时支持简写语法 (selectors.json 里实际写法):
   *   - getByRole("X")                            → [role="X"]
   *   - getByRole("X", name="Y")                  → 简写, 无花括号
   *   - getByRole("X", { name: "Y" })             → 标准 Playwright
   *   - getByRole("X", name="Y", exact=True)      → 简写 + 精确
   *   - getByText("Y")                            → 包含 "Y"
   *   - getByText("Y", exact=True)                → 简写 + 精确
   *   - getByText("Y", { exact: true })           → 标准
   */
  private async querySelectorByPlaywrightSyntax(selector: string): Promise<number | null> {
    const expression = this.translatePlaywrightSelector(selector, false);
    if (!expression) {
      logger.warn({ selector }, 'Failed to translate Playwright syntax selector');
      return null;
    }
    return this.evalAndRequestNode(expression);
  }

  private async querySelectorAllByPlaywrightSyntax(selector: string): Promise<number[]> {
    const expression = this.translatePlaywrightSelector(selector, true);
    if (!expression) {
      logger.warn({ selector }, 'Failed to translate Playwright syntax selector');
      return [];
    }
    return this.evalArrayAndRequestNodes(expression);
  }

  private translatePlaywrightSelector(selector: string, multi: boolean): string | null {
    // 标准语法: getByRole("X", { name: "Y" })   或   getByRole("X", { name: "Y", exact: true })
    // 简写语法: getByRole("X", name="Y")        或   getByRole("X", name="Y", exact=True)
    // 第一参数必需, 其余键值对在 () 内、, 分隔
    const roleMatch = selector.match(/^getByRole\(\s*["']([^"']+)["']([\s\S]*)\)$/);
    if (roleMatch) {
      const role = roleMatch[1];
      const rest = roleMatch[2];
      // 提取所有 key=value 形式, 兼容 name="X" / name: "X" / exact=True / exact: true
      const kvMatches = rest.matchAll(/(?:(\w+)\s*[=:]\s*["']([^"']*)["']|(\w+)\s*[=:]\s*(true|false|null|\d+))/g);
      const opts: Record<string, string> = {};
      for (const m of kvMatches) {
        opts[m[1] || m[3]] = m[2] !== undefined ? m[2] : m[4];
      }
      const name = opts.name;
      const exact = opts.exact === 'true';
      if (name) {
        const escName = JSON.stringify(name);
        const escRole = JSON.stringify(role);
        const cmp = exact ? '===' : '.includes';
        if (multi) {
          return `(() => {
            const els = Array.from(document.querySelectorAll('[role=${escRole}]'));
            return els.filter((el) => {
              const al = el.getAttribute('aria-label') || '';
              const tx = (el.textContent || '').trim();
              return al ${cmp}(${escName}) || tx ${cmp}(${escName});
            });
          })()`;
        }
        return `(() => {
          const els = Array.from(document.querySelectorAll('[role=${escRole}]'));
          return els.find((el) => {
            const al = el.getAttribute('aria-label') || '';
            const tx = (el.textContent || '').trim();
            return al ${cmp}(${escName}) || tx ${cmp}(${escName});
          }) || null;
        })()`;
      }
      // 无 name: 直接 [role="X"]
      return multi
        ? `Array.from(document.querySelectorAll('[role=${JSON.stringify(role)}]'))`
        : `document.querySelector('[role=${JSON.stringify(role)}"]')`;
    }

    // getByText
    const textMatch = selector.match(/^getByText\(\s*["']([^"']+)["']([\s\S]*)\)$/);
    if (textMatch) {
      const text = textMatch[1];
      const rest = textMatch[2];
      const kvMatches = rest.matchAll(/(?:(\w+)\s*[=:]\s*["']([^"']*)["']|(\w+)\s*[=:]\s*(true|false|null|\d+))/g);
      let exact = false;
      for (const m of kvMatches) {
        const k = m[1] || m[3];
        const v = m[2] !== undefined ? m[2] : m[4];
        if (k === 'exact' && v === 'true') exact = true;
      }
      const escText = JSON.stringify(text);
      const cmp = exact ? '===' : '.includes';
      if (multi) {
        return `(() => {
          const out = [];
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          let n;
          while ((n = walk.nextNode())) {
            const own = Array.from(n.childNodes).filter(c => c.nodeType === 3);
            const ownText = own.map(c => c.textContent).join('').trim();
            if (ownText ${cmp}(${escText})) out.push(n);
          }
          return out;
        })()`;
      }
      return `(() => {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = walk.nextNode())) {
          const own = Array.from(n.childNodes).filter(c => c.nodeType === 3);
          const ownText = own.map(c => c.textContent).join('').trim();
          if (ownText ${cmp}(${escText})) return n;
        }
        return null;
      })()`;
    }

    // getByPlaceholder("X")  →  [placeholder="X"]
    const placeholderMatch = selector.match(/^getByPlaceholder\(\s*["']([^"']+)["']\s*\)$/);
    if (placeholderMatch) {
      const text = placeholderMatch[1];
      const escText = JSON.stringify(text);
      return multi
        ? `Array.from(document.querySelectorAll('[placeholder=${escText}]'))`
        : `document.querySelector('[placeholder=${escText}]')`;
    }
    return null;
  }

  private async evalAndRequestNode(expression: string): Promise<number | null> {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: false,
      });
      const objectId = result.result?.objectId;
      if (!objectId || result.result.subtype === 'null') return null;
      const nr = await this.send('DOM.requestNode', { objectId });
      return nr.nodeId || null;
    } catch {
      return null;
    }
  }

  private async evalArrayAndRequestNodes(expression: string): Promise<number[]> {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: false,
      });
      const objectId = result.result?.objectId;
      if (!objectId) return [];
      const props = await this.send('Runtime.getProperties', { objectId });
      const nodeIds: number[] = [];
      for (const prop of props.result || []) {
        if (typeof prop.name === 'string' && /^\d+$/.test(prop.name) && prop.value?.objectId) {
          try {
            const nr = await this.send('DOM.requestNode', { objectId: prop.value.objectId });
            if (nr.nodeId) nodeIds.push(nr.nodeId);
          } catch { /* skip */ }
        }
      }
      return nodeIds;
    } catch {
      return [];
    }
  }

  /**
   * :visible 后置检查: width/height>0 + display/visibility/opacity 都在正常范围
   * 跟 cdpDom.isElementVisible 行为对齐, 但多了一个 viewport 内裁剪
   */
  private async checkNodeVisible(nodeId: number): Promise<boolean> {
    try {
      const box = await this.getBoxModel(nodeId);
      const rect = box ? CDPClient.quadToRect(box.content) : null;
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      // viewport 内
      const viewport = await this.getLayoutViewport();
      if (rect.x + rect.width < 0 || rect.y + rect.height < 0) return false;
      if (rect.x > viewport.clientWidth || rect.y > viewport.clientHeight) return false;
      // 计算样式
      const style = await this.getComputedStyle(nodeId);
      if (style) {
        if (style['display'] === 'none') return false;
        if (style['visibility'] === 'hidden' || style['visibility'] === 'collapse') return false;
        const opacity = parseFloat(style['opacity'] || '1');
        if (!isNaN(opacity) && opacity < 0.1) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async getBoxModel(nodeId: number): Promise<BoxModel | null> {
    try {
      const result = await this.send('DOM.getBoxModel', { nodeId });
      return result.model || null;
    } catch {
      return null;
    }
  }

  async getContentQuads(nodeId: number): Promise<number[][] | null> {
    try {
      const result = await this.send('DOM.getContentQuads', { nodeId });
      return result.quads || null;
    } catch {
      return null;
    }
  }

  async performSearch(query: string, includeUserAgentShadowDOM: boolean = true): Promise<{ searchId: string; resultCount: number } | null> {
    try {
      const result = await this.send('DOM.performSearch', { query, includeUserAgentShadowDOM });
      return { searchId: result.searchId, resultCount: result.resultCount };
    } catch {
      return null;
    }
  }

  async getSearchResults(searchId: string, fromIndex: number, toIndex: number): Promise<number[]> {
    try {
      const result = await this.send('DOM.getSearchResults', { searchId, fromIndex, toIndex });
      return result.nodeIds || [];
    } catch {
      return [];
    }
  }

  async discardSearchResults(searchId: string): Promise<void> {
    try {
      await this.send('DOM.discardSearchResults', { searchId });
    } catch {}
  }

  async resolveNode(nodeId: number): Promise<number | null> {
    try {
      const result = await this.send('DOM.resolveNode', { nodeId });
      return result.object?.objectId ? nodeId : null;
    } catch {
      return null;
    }
  }

  async getNodeForLocation(x: number, y: number): Promise<number | null> {
    try {
      const result = await this.send('DOM.getNodeForLocation', { x, y });
      return result.nodeId || null;
    } catch {
      return null;
    }
  }

  async describeNode(nodeId: number, depth: number = 0): Promise<DOMNode | null> {
    try {
      const result = await this.send('DOM.describeNode', { nodeId, depth });
      return result.node || null;
    } catch {
      return null;
    }
  }

  async getAttributes(nodeId: number): Promise<Record<string, string> | null> {
    try {
      const result = await this.send('DOM.getAttributes', { nodeId });
      if (!result.attributes) return null;
      const attrs: Record<string, string> = {};
      for (let i = 0; i < result.attributes.length; i += 2) {
        attrs[result.attributes[i]] = result.attributes[i + 1];
      }
      return attrs;
    } catch {
      return null;
    }
  }

  async getComputedStyle(nodeId: number): Promise<Record<string, string> | null> {
    try {
      const result = await this.send('CSS.getComputedStyleForNode', { nodeId });
      if (!result.computedStyle) return null;
      const style: Record<string, string> = {};
      for (const prop of result.computedStyle) {
        style[prop.name] = prop.value;
      }
      return style;
    } catch {
      return null;
    }
  }

  async focusNode(nodeId: number): Promise<void> {
    try {
      await this.send('DOM.focus', { nodeId });
    } catch {
      logger.debug({ nodeId }, 'Failed to focus node');
    }
  }

  async scrollIntoViewIfNeeded(nodeId: number): Promise<void> {
    try {
      await this.send('DOM.scrollIntoViewIfNeeded', { nodeId });
    } catch {
      logger.debug({ nodeId }, 'scrollIntoViewIfNeeded failed or not needed');
    }
  }

  async dispatchMouseEvent(params: {
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
    x: number;
    y: number;
    button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';
    buttons?: number;
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    timestamp?: number;
  }): Promise<void> {
    await this.send('Input.dispatchMouseEvent', params);
  }

  async dispatchKeyEvent(params: {
    type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
    key?: string;
    code?: string;
    windowsVirtualKeyCode?: number;
    nativeVirtualKeyCode?: number;
    modifiers?: number;
    text?: string;
  }): Promise<void> {
    await this.send('Input.dispatchKeyEvent', params);
  }

  async refreshDocument(): Promise<void> {
    const doc = await this.send('DOM.getDocument', { depth: 0 });
    this.documentNodeId = doc.root.nodeId;
  }

  async getLayoutViewport(): Promise<{ pageX: number; pageY: number; clientWidth: number; clientHeight: number }> {
    const result = await this.send('Page.getLayoutMetrics', {});
    return result.layoutViewport;
  }

  async getLayoutMetrics(): Promise<{
    layoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
    contentSize: { x: number; y: number; width: number; height: number };
  }> {
    const result = await this.send('Page.getLayoutMetrics', {});
    return {
      layoutViewport: result.layoutViewport,
      contentSize: result.contentSize,
    };
  }

  static quadToRect(quad: number[]): ViewportRect {
    const x1 = quad[0];
    const y1 = quad[1];
    const x2 = quad[2];
    const y2 = quad[3];
    const x3 = quad[4];
    const y3 = quad[5];
    const x4 = quad[6];
    const y4 = quad[7];

    const minX = Math.min(x1, x2, x3, x4);
    const maxX = Math.max(x1, x2, x3, x4);
    const minY = Math.min(y1, y2, y3, y4);
    const maxY = Math.max(y1, y2, y3, y4);

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  static rectCenter(rect: ViewportRect): { x: number; y: number } {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  }
}
