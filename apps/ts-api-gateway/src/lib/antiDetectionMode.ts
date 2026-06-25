// apps/ts-api-gateway/src/lib/antiDetectionMode.ts
export const ANTI_DETECTION_MODE = {
  LEGACY: 'legacy',
  V2: 'v2',
} as const;

export function isAntiDetectionV2(): boolean {
  return process.env.ANTI_DETECTION_MODE === ANTI_DETECTION_MODE.V2;
}
