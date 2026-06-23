// @ts-api-gateway/lib/settingsStore.ts — 统一设置持久化
import fs from 'fs';
import path from 'path';

const OVERRIDES_FILE = path.resolve(process.cwd(), 'data', 'settings-overrides.json');

let _cache: Record<string, any> | null = null;

function loadFile(): Record<string, any> {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
  } catch {
    _cache = {};
  }
  return _cache!;
}

export function getSection<T>(section: string, defaults: T): T {
  const file = loadFile();
  if (file[section]) return { ...defaults, ...file[section] } as T;
  return defaults;
}

export function saveSection(section: string, data: any): void {
  const file = { ...loadFile() };
  file[section] = { ...file[section], ...data };
  _cache = file;
  const dir = path.dirname(OVERRIDES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(file, null, 2), 'utf-8');
}
