export interface Point {
  x: number;
  y: number;
}

export interface TrajectoryPoint extends Point {
  delay: number;
}

export class TrajectoryGenerator {
  private static readonly OVERSHOOT_PROBABILITY = 0.07;
  private static readonly OVERSHOOT_PIXELS_MIN = 3;
  private static readonly OVERSHOOT_PIXELS_MAX = 12;
  private static readonly JITTER_AMPLITUDE = 1.5;
  private static readonly MIN_STEPS = 25;
  private static readonly MAX_STEPS = 60;

  static generateBezierPath(
    start: Point,
    end: Point,
    steps?: number
  ): TrajectoryPoint[] {
    const distance = Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
    const actualSteps = steps ?? TrajectoryGenerator.calcSteps(distance);

    const cp1 = TrajectoryGenerator.randomControlPoint(start, end, 0.25, 0.1);
    const cp2 = TrajectoryGenerator.randomControlPoint(start, end, 0.75, 0.9);

    const baseTime = TrajectoryGenerator.calcFittsTime(distance);
    const rawPoints: Point[] = [];

    for (let i = 0; i <= actualSteps; i++) {
      const t = i / actualSteps;
      const mt = 1 - t;
      const x = mt * mt * mt * start.x
        + 3 * mt * mt * t * cp1.x
        + 3 * mt * t * t * cp2.x
        + t * t * t * end.x;
      const y = mt * mt * mt * start.y
        + 3 * mt * mt * t * cp1.y
        + 3 * mt * t * t * cp2.y
        + t * t * t * end.y;
      rawPoints.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    }

    const withOvershoot = TrajectoryGenerator.maybeAddOvershoot(rawPoints, end);

    return TrajectoryGenerator.applyFittsTiming(withOvershoot, baseTime);
  }

  static generateHoverPath(start: Point, end: Point): TrajectoryPoint[] {
    return TrajectoryGenerator.generateBezierPath(start, end, 20);
  }

  static generateWanderPath(center: Point, radius: number = 30, points: number = 5): TrajectoryPoint[] {
    const result: TrajectoryPoint[] = [];
    let current = { ...center };

    for (let i = 0; i < points; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * radius;
      const target = {
        x: center.x + Math.cos(angle) * dist,
        y: center.y + Math.sin(angle) * dist,
      };

      const segment = TrajectoryGenerator.generateBezierPath(current, target, 8);
      result.push(...segment);
      current = target;
    }

    return result;
  }

  private static calcSteps(distance: number): number {
    const normalized = Math.min(distance / 1000, 1);
    const steps = TrajectoryGenerator.MIN_STEPS
      + Math.round(normalized * (TrajectoryGenerator.MAX_STEPS - TrajectoryGenerator.MIN_STEPS));
    return steps + Math.floor(Math.random() * 8) - 4;
  }

  private static calcFittsTime(distance: number): number {
    const minTime = 200;
    const maxTime = 1200;
    const a = 50;
    const b = 150;
    const w = 50;
    const id = Math.log2((distance + w) / w + 1);
    const fittsTime = a + b * id;
    return Math.max(minTime, Math.min(maxTime, fittsTime + (Math.random() - 0.5) * 200));
  }

  private static randomControlPoint(
    start: Point,
    end: Point,
    tPosition: number,
    yBias: number
  ): Point {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const spread = Math.max(30, dist * 0.25);

    return {
      x: start.x + dx * tPosition + (Math.random() - 0.5) * spread,
      y: start.y + dy * yBias + (Math.random() - 0.5) * spread * 0.8,
    };
  }

  private static maybeAddOvershoot(points: Point[], target: Point): Point[] {
    if (Math.random() > TrajectoryGenerator.OVERSHOOT_PROBABILITY) {
      return points;
    }

    const overshootDist = TrajectoryGenerator.OVERSHOOT_PIXELS_MIN
      + Math.random() * (TrajectoryGenerator.OVERSHOOT_PIXELS_MAX - TrajectoryGenerator.OVERSHOOT_PIXELS_MIN);
    const angle = Math.atan2(target.y - points[points.length - 2].y, target.x - points[points.length - 2].x);
    const overshootPoint: Point = {
      x: target.x + Math.cos(angle) * overshootDist,
      y: target.y + Math.sin(angle) * overshootDist,
    };

    const correctionSteps = 3 + Math.floor(Math.random() * 3);
    const correctionPoints: Point[] = [];
    for (let i = 1; i <= correctionSteps; i++) {
      const t = i / correctionSteps;
      correctionPoints.push({
        x: overshootPoint.x + (target.x - overshootPoint.x) * t,
        y: overshootPoint.y + (target.y - overshootPoint.y) * t,
      });
    }

    return [...points, overshootPoint, ...correctionPoints];
  }

  private static applyFittsTiming(points: Point[], totalTime: number): TrajectoryPoint[] {
    const result: TrajectoryPoint[] = [];
    const n = points.length;

    for (let i = 0; i < n; i++) {
      const progress = i / (n - 1);

      const speedFactor = TrajectoryGenerator.fittsSpeedCurve(progress);

      const jitterX = (Math.random() - 0.5) * TrajectoryGenerator.JITTER_AMPLITUDE;
      const jitterY = (Math.random() - 0.5) * TrajectoryGenerator.JITTER_AMPLITUDE;

      const baseStepTime = totalTime / n;
      const stepTime = baseStepTime / speedFactor;

      result.push({
        x: Math.round((points[i].x + jitterX) * 10) / 10,
        y: Math.round((points[i].y + jitterY) * 10) / 10,
        delay: Math.max(2, Math.round(stepTime)),
      });
    }

    return result;
  }

  private static fittsSpeedCurve(progress: number): number {
    const accelEnd = 0.25;
    const decelStart = 0.7;

    if (progress < accelEnd) {
      const t = progress / accelEnd;
      return 0.3 + 0.7 * (t * t);
    } else if (progress < decelStart) {
      return 1.0;
    } else {
      const t = (progress - decelStart) / (1 - decelStart);
      return 1.0 - 0.6 * (t * t);
    }
  }
}
