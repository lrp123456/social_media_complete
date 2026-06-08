# Selector System Unification Plan

## Goal
Unify all selector systems into ONE source of truth: `data/selectors.json` → `SelectorReader` → used by ALL publishers and crawlers. Web UI edits selectors → saved to json → next run picks up latest.

## Current Reality (4 disconnected systems)
1. **data/selectors.json → SelectorReader** (1517 lines, loaded by selectorStore.ts) — used ONLY by douyin.ts publisher
2. **kuaishou.ts, xiaohongshu.ts** — 100% hardcoded selectors, no SelectorReader usage
3. **menuSelectors.ts** — own hardcoded PLATFORM_SELECTORS registry, no SelectorReader usage
4. **packages/selectors/src/index.ts SelectorRegistry** — Prisma-backed, dead code (no runtime path)

## Critical Finding
The settings UI (`/app/settings/page.tsx#panel-automation`) ALREADY connects to SelectorReader via config-automation API endpoints. The disconnect is that publishers/crawlers ignore SelectorReader.

## Implementation Plan

### Phase 1: Enrich data/selectors.json with missing selectors
Add all hardcoded selectors from the code into the config:
- QR code selectors (all 3 platforms)
- SMS verification selectors (douyin)
- Progress bar selectors (all 3)
- Joyride/guide close selectors (kuaishou)
- Success detection selectors (all 3)
- Login URL patterns (all 3)
- Transcode selectors (kuaishou)
- Disabled button selectors (douyin)

### Phase 2: Migrate kuaishou.ts to SelectorReader
Replace all hardcoded selectors with SelectorReader lookups

### Phase 3: Migrate xiaohongshu.ts to SelectorReader
Replace all hardcoded selectors with SelectorReader lookups

### Phase 4: Migrate menuSelectors.ts to SelectorReader
Replace hardcoded PLATFORM_SELECTORS with SelectorReader-based getSelector

### Phase 5: Add selector health tracking
- Add `health` field to selector config entries
- When a selector fails to match, log failure to config
- Expose failed selectors in API

### Phase 6: Enhance settings UI
- Show selector health status
- Multi-level fallback editing per selector
- Per-platform selector list

### Phase 7: Delete dead code
- packages/selectors/src/index.ts SelectorRegistry class + DEFAULT_SELECTORS
- selectorConfig.ts DEFAULT_SELECTOR_CONFIG (keep only the structure type)
- Prisma CustomSelector table/migration
