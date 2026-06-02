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
    try {
      const result = await this.send('DOM.querySelector', {
        nodeId: rootId,
        selector,
      });
      return result.nodeId || null;
    } catch {
      return null;
    }
  }

  async querySelectorAll(selector: string, parentNodeId?: number): Promise<number[]> {
    const rootId = parentNodeId ?? this.documentNodeId;
    try {
      const result = await this.send('DOM.querySelectorAll', {
        nodeId: rootId,
        selector,
      });
      return result.nodeIds || [];
    } catch {
      return [];
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
