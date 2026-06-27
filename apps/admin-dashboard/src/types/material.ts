export interface PlatformRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body: string | null;
  maxPages: number;
  timeoutMs: number;
}

export interface KeyPool {
  placeholder: string;
  keys: string[];
  cooldownMs: number;
}

export interface ParseConfig {
  listPath: string;
  fields: Record<string, string>;
}

export interface Platform {
  id: string;
  name: string;
  enabled: boolean;
  request: PlatformRequest;
  keyPool: KeyPool;
  parse: ParseConfig;
}

export interface StyleDef {
  name: string;
  dir: string;
  keywords: string[];
}

export interface Processing {
  frameIntervalMs: number;
  evaluatePrompt: string;
  styles: StyleDef[];
  minRating: number;
}

export interface Schedule {
  cron: string[];
  enabled: boolean;
}

export interface MaterialUpdateConfig {
  platforms: Platform[];
  schedule: Schedule;
  processing: Processing;
  keyCooldownState: Record<string, Record<string, number>>;
  allCooldownRetryAfterMs: number;
}
