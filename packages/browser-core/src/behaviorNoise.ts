import { CDPClient } from './cdpClient';
import { CDPHumanMouse } from './cdpMouse';
import { CDPDomNavigator } from './cdpDom';
import { CDPScroller, ScrollOptions } from './cdpScroller';
import { TrajectoryGenerator } from './trajectory';
import { rootLogger } from '../logger';

const logger = rootLogger.child({ name: 'behaviorNoise' });

export class BehaviorNoise {
  private cdp: CDPClient;
  private dom: CDPDomNavigator;
  private mouse: CDPHumanMouse;
  private scroller: CDPScroller;

  constructor(cdp: CDPClient, dom: CDPDomNavigator, mouse: CDPHumanMouse, scroller: CDPScroller) {
    this.cdp = cdp;
    this.dom = dom;
    this.mouse = mouse;
    this.scroller = scroller;
  }

  async pageLoadBehavior(): Promise<void> {
    const viewport = await this.cdp.getLayoutViewport();
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;

    const wanderPoints = TrajectoryGenerator.generateWanderPath(
      { x: centerX, y: centerY },
      40,
      3 + Math.floor(Math.random() * 3)
    );

    for (const point of wanderPoints) {
      await this.mouse.moveTo({ x: point.x, y: point.y }, { skipTrajectory: true });
      await this.sleep(point.delay);
    }

    if (Math.random() < 0.6) {
      await this.scroller.scrollPage({
        direction: 'down',
        totalAmount: 50 + Math.random() * 100,
        segmentSize: { min: 30, max: 60 },
        segmentCount: { min: 1, max: 2 },
        pauseBetween: { min: 200, max: 500 },
      });
      await this.sleep(300 + Math.random() * 500);

      if (Math.random() < 0.4) {
        await this.scroller.scrollPage({
          direction: 'up',
          totalAmount: 20 + Math.random() * 50,
          segmentSize: { min: 20, max: 40 },
          segmentCount: { min: 1, max: 2 },
          pauseBetween: { min: 200, max: 400 },
        });
      }
    }

    await this.sleep(500 + Math.random() * 1000);
  }

  async randomHoverOnPath(targetSelector: string): Promise<void> {
    if (Math.random() > 0.3) return;

    const viewport = await this.cdp.getLayoutViewport();
    const randomX = 50 + Math.random() * (viewport.clientWidth - 100);
    const randomY = 50 + Math.random() * (viewport.clientHeight - 100);

    await this.mouse.moveTo({ x: randomX, y: randomY });
    await this.sleep(300 + Math.random() * 700);
  }

  async randomBlankAction(): Promise<void> {
    const roll = Math.random();

    if (roll < 0.3) {
      await this.randomBlankClick();
    } else if (roll < 0.6) {
      await this.randomMicroScroll();
    } else {
      await this.randomWander();
    }
  }

  async thinkingPause(minMs: number = 500, maxMs: number = 2000): Promise<void> {
    const pause = minMs + Math.random() * (maxMs - minMs);
    await this.sleep(pause);
  }

  async betweenActionsPause(): Promise<void> {
    const pause = 200 + Math.random() * 800;
    await this.sleep(pause);
  }

  private async randomBlankClick(): Promise<void> {
    const viewport = await this.cdp.getLayoutViewport();
    const x = 50 + Math.random() * (viewport.clientWidth - 100);
    const y = 100 + Math.random() * (viewport.clientHeight - 200);

    await this.mouse.moveTo({ x, y });
    await this.sleep(100 + Math.random() * 300);

    await this.cdp.dispatchMouseEvent({
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.sleep(20 + Math.random() * 50);
    await this.cdp.dispatchMouseEvent({
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });

    logger.debug({ x: Math.round(x), y: Math.round(y) }, 'Random blank click');
  }

  private async randomMicroScroll(): Promise<void> {
    const direction = Math.random() < 0.5 ? 'down' : 'up';
    await this.scroller.scrollPage({
      direction: direction as 'down' | 'up',
      totalAmount: 20 + Math.random() * 60,
      segmentSize: { min: 15, max: 30 },
      segmentCount: { min: 1, max: 2 },
      pauseBetween: { min: 100, max: 300 },
    });
  }

  private async randomWander(): Promise<void> {
    const viewport = await this.cdp.getLayoutViewport();
    const current = this.mouse.getState();

    const wanderPoints = BehaviorNoise.generateWanderPoint(
      { x: current.x, y: current.y },
      viewport.clientWidth,
      viewport.clientHeight
    );

    for (const point of wanderPoints) {
      await this.mouse.moveTo(point, { skipTrajectory: true });
      await this.sleep(30 + Math.random() * 50);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export namespace BehaviorNoise {
  export function generateWanderPoint(
    current: { x: number; y: number },
    maxW: number,
    maxH: number
  ): Array<{ x: number; y: number }> {
    const points: Array<{ x: number; y: number }> = [];
    const count = 2 + Math.floor(Math.random() * 4);

    for (let i = 0; i < count; i++) {
      const x = Math.max(20, Math.min(maxW - 20, current.x + (Math.random() - 0.5) * 100));
      const y = Math.max(20, Math.min(maxH - 20, current.y + (Math.random() - 0.5) * 100));
      points.push({ x: Math.round(x), y: Math.round(y) });
      current = { x, y };
    }

    return points;
  }
}
