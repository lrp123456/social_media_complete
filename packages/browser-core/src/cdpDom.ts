import { CDPClient, ViewportRect } from './cdpClient';
import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'cdpDom' });

export interface ElementLocation {
  nodeId: number;
  rect: ViewportRect;
  center: { x: number; y: number };
}

export class CDPDomNavigator {
  private cdp: CDPClient;

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
  }

  async findElement(selector: string, options?: { timeout?: number; visible?: boolean }): Promise<ElementLocation | null> {
    const timeout = options?.timeout ?? 10000;
    const visible = options?.visible ?? true;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const nodeId = await this.cdp.querySelector(selector);
      if (nodeId && nodeId > 0) {
        const location = await this.getElementLocation(nodeId);
        if (location) {
          if (!visible || this.isRectVisible(location.rect)) {
            return location;
          }
        }
      }
      await this.sleep(500);
    }

    logger.warn({ selector, timeout }, 'Element not found within timeout');
    return null;
  }

  async findElementNow(selector: string): Promise<ElementLocation | null> {
    const nodeId = await this.cdp.querySelector(selector);
    if (!nodeId || nodeId <= 0) return null;

    return this.getElementLocation(nodeId);
  }

  async waitForElement(selector: string, timeout: number = 10000): Promise<ElementLocation | null> {
    return this.findElement(selector, { timeout, visible: true });
  }

  async waitForElementGone(selector: string, timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const nodeId = await this.cdp.querySelector(selector);
      if (!nodeId || nodeId <= 0) return true;

      const location = await this.getElementLocation(nodeId);
      if (!location || !this.isRectVisible(location.rect)) return true;

      await this.sleep(300);
    }
    return false;
  }

  async getElementLocation(nodeId: number): Promise<ElementLocation | null> {
    const boxModel = await this.cdp.getBoxModel(nodeId);
    if (!boxModel) {
      return this.fallbackGetLocation(nodeId);
    }

    const contentRect = CDPClient.quadToRect(boxModel.content);
    if (contentRect.width <= 0 || contentRect.height <= 0) {
      const borderRect = CDPClient.quadToRect(boxModel.border);
      if (borderRect.width <= 0 || borderRect.height <= 0) {
        return this.fallbackGetLocation(nodeId);
      }
      return {
        nodeId,
        rect: borderRect,
        center: CDPClient.rectCenter(borderRect),
      };
    }

    return {
      nodeId,
      rect: contentRect,
      center: CDPClient.rectCenter(contentRect),
    };
  }

  async findChildElement(parentNodeId: number, selector: string): Promise<ElementLocation | null> {
    const nodeId = await this.cdp.querySelector(selector, parentNodeId);
    if (!nodeId || nodeId <= 0) return null;

    return this.getElementLocation(nodeId);
  }

  async findScrollableContainer(selector: string): Promise<ElementLocation | null> {
    const nodeId = await this.cdp.querySelector(selector);
    if (!nodeId || nodeId <= 0) return null;

    const location = await this.getElementLocation(nodeId);
    return location;
  }

  async findIframeContainer(iframeSelector: string): Promise<ElementLocation | null> {
    const nodeId = await this.cdp.querySelector(iframeSelector);
    if (!nodeId || nodeId <= 0) return null;

    const location = await this.getElementLocation(nodeId);
    return location;
  }

  async refreshDocument(): Promise<void> {
    await this.cdp.refreshDocument();
  }

  async isElementVisible(selector: string): Promise<boolean> {
    const nodeId = await this.cdp.querySelector(selector);
    if (!nodeId || nodeId <= 0) return false;

    const computedStyle = await this.cdp.getComputedStyle(nodeId);
    if (computedStyle) {
      if (computedStyle['display'] === 'none') return false;
      if (computedStyle['visibility'] === 'hidden' || computedStyle['visibility'] === 'collapse') return false;
      const opacity = parseFloat(computedStyle['opacity'] || '1');
      if (opacity < 0.1) return false;
    }

    const location = await this.getElementLocation(nodeId);
    return location !== null && this.isRectVisible(location.rect);
  }

  async getElementAttributes(selector: string): Promise<Record<string, string> | null> {
    const nodeId = await this.cdp.querySelector(selector);
    if (!nodeId || nodeId <= 0) return null;

    return this.cdp.getAttributes(nodeId);
  }

  async scrollNodeIntoView(nodeId: number): Promise<void> {
    await this.cdp.scrollIntoViewIfNeeded(nodeId);
  }

  private async fallbackGetLocation(nodeId: number): Promise<ElementLocation | null> {
    const quads = await this.cdp.getContentQuads(nodeId);
    if (!quads || quads.length === 0) return null;

    const rect = CDPClient.quadToRect(quads[0]);
    if (rect.width <= 0 || rect.height <= 0) return null;

    return {
      nodeId,
      rect,
      center: CDPClient.rectCenter(rect),
    };
  }

  private isRectVisible(rect: ViewportRect): boolean {
    return rect.width > 0
      && rect.height > 0
      && rect.x > -rect.width
      && rect.y > -rect.height;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
