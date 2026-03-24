# Ink TUI Migration Plan — Safe, Incremental Process

## Context

The goal is to migrate claude-tenet's terminal output from raw `console.log` calls to an [Ink](https://github.com/vadimdemedes/ink) (React-based TUI) renderer. The primary concern is **migration safety** — keeping the app working at every step, not touching core logic, and having rollback paths.

**Current state:** All UI is imperative `console.log` — ~20 print functions in `logger.ts`, plus ~50 inline `console.log` calls scattered across both orchestrators. One custom interactive `multiselect.ts` using raw Deno terminal APIs. No color library.

**Core logic files that must NOT be modified:** `red-team.ts`, `blue-team.ts`, `scanner.ts`, `coverage.ts`, `mission.ts`, `fix-phase.ts`, `sandbox.ts`, `ownership.ts`, `types.ts`.

**IMPORTANT: Ink TUI is mandatory.** There is no opt-in flag or console fallback. The old `console.log` output is being fully replaced by Ink. All users will use the Ink TUI — there is no `--ui` toggle. The console-renderer exists only as a transitional stepping stone during migration (Phase 1), not as a permanent alternative. By the end of migration, logger.ts print functions and direct console.log calls in orchestrators will be deleted, not preserved.

---

## Phase 0: Validate Ink + Deno Compatibility — COMPLETED (2026-03-24)

**Result: GO** — All checks passed.

| Test | Result |
|------|--------|
| `deno run --allow-all` — Ink renders, React state updates, yoga layout works | **PASS** |
| `deno compile --allow-all` — Bundles Ink+React+yoga into standalone binary | **PASS** |
| Compiled binary executes correctly (render lifecycle, timer, auto-exit) | **PASS** |

**Findings for future phases:**
- React types require `/// <reference types="npm:@types/react@18" />` directive in `.tsx` files
- `deno.json` compilerOptions needs `"jsx": "react-jsx"` and `"jsxImportSource": "react"`
- Import map needs: `"ink": "npm:ink@5"`, `"react": "npm:react@18"`, `"react/jsx-runtime": "npm:react@18/jsx-runtime"`, `"@types/react": "npm:@types/react@18"`
- Compiled binary bundles ~6.9MB of node_modules (6.26MB unique) — acceptable overhead
- No yoga-layout native binding issues on darwin/arm64
- Spike directory cleaned up (was `ink-spike/`)

---

## Phase 1: Decouple UI from Logic via Event Emitter — COMPLETED (2026-03-24)

**Result:** All orchestrator output decoupled via `TenetUI` interface. `deno task check` passes clean.

**New files created:**
- `src/ui/events.ts` — `UIEvent` discriminated union (19 event types) + `TenetUI` interface + `MultiSelectOptions`
- `src/ui/emitter.ts` — `createTenetUI()` factory: accepts a listener function + multiselect handler, returns `TenetUI`
- `src/ui/console-renderer.ts` — `createConsoleUI()`: switch on event type → delegates to existing `logger.ts` print functions + `multiselect.ts`

**Files modified:**
- `src/tenet/orchestrator.ts` — All 16 `console.log` + 14 `print*` calls → `ui.emit()`. Accepts `ui: TenetUI` param. Only imports `debug`/`startTimer`/`setVerbose` from logger.
- `src/tenet/unit-orchestrator.ts` — All 29 `console.log` + 12 `print*` calls → `ui.emit()`. Same pattern.
- `src/main.ts` — Creates `ui` via `createConsoleUI()`, passes to both orchestrators.

**Unchanged:** All core logic files, `logger.ts`, `multiselect.ts`. Zero `console.log` calls remain in either orchestrator.

**Architecture after Phase 1:**
```
main.ts → createConsoleUI() → TenetUI { emit(), multiSelect() }
                                  ↓
orchestrator.ts ──ui.emit(event)──→ console-renderer.ts → logger.ts print functions
                ──ui.multiSelect()→                     → multiselect.ts
```

**Key design decisions:**
- `TenetUI` has two methods: `emit(event)` (sync, fire-and-forget) and `multiSelect(options)` (async, returns `Promise<string[]>`)
- Events are a discriminated union on `type` field — exhaustive switch in renderer
- `status` event type covers all inline status messages (strings pass through verbatim)
- Structured event types (`round-complete`, `iteration-complete`, etc.) carry full payloads matching logger function signatures
- Orchestrators receive `ui` as a function parameter (not global), making them testable

---

## Phase 2: Replace Console Output with Ink TUI — COMPLETED (2026-03-24)

**Result:** All event rendering replaced with Ink. `deno task check` passes clean. MultiSelect reimplemented as Ink component.

**New files created:**
- `src/ui/ink-app.tsx` — Root Ink component. `<Static>` renders completed events via `formatEvent()` (all 19 event types). `<MultiSelectPrompt>` handles interactive selection with `useInput` (arrow keys, space toggle, enter confirm, escape skip). `App` receives events array + multiselect state as props from renderer.
- `src/ui/ink-renderer.ts` — `createInkUI()` factory: holds events array + multiselect state externally, calls `render()`/`rerender()` on the `App` component. Banner pushed as first status event. Returns `{ ui: TenetUI, unmount }`.

**Files modified:**
- `deno.json` — Added `ink@5`, `react@18`, `react/jsx-runtime`, `@types/react@18` to imports. Added `"jsx": "react-jsx"` and `"jsxImportSource": "react"` to compilerOptions.
- `src/main.ts` — Replaced `createConsoleUI` with `createInkUI`. Removed `printBanner` import (banner now rendered by Ink). Added `unmount()` in SIGINT handler and finally block. Config parsing moved before Ink init so `--help`/error paths don't conflict with Ink.

**Architecture after Phase 2:**
```
main.ts → createInkUI() → { ui: TenetUI, unmount }
                              ↓
orchestrator.ts ──ui.emit()──→ ink-renderer.ts → rerender(App)
              ──ui.multiSelect()→               → MultiSelectPrompt component
                              ↓
                          ink-app.tsx → <Static> events + <MultiSelectPrompt>
```

**Key design decisions:**
- Events rendered as text strings via `formatEvent()` — direct translation from logger.ts formatting, preserving identical output content
- `<Static items={events}>` renders each event once and appends new events below — matches console.log's append-only behavior
- MultiSelect implemented as Ink component in Phase 2 (pulled forward from Phase 3) since Ink controls stdout and the old raw-terminal multiselect would conflict
- `rerender()` called on every `emit()` and `multiSelect()` — React reconciliation + Static ensures only new items render
- SIGINT handler calls `unmount()` then `Deno.exit(130)` — hard exit avoids hanging on unresolved multiSelect promises
- `debug()` from logger.ts still writes to `console.log` — Ink's `patch-console` dependency handles interleaving

---

## Phase 3: Enhanced Ink UI — COMPLETED (2026-03-24)

**Result:** Full color output, animated spinners, and real-time worker status panel. `deno task check` passes clean.

**New event types added:**
- `{ type: "status"; message: string; spinner?: boolean }` — spinner flag on status events
- `{ type: "worker-phase"; workerId: number; phase: "red" | "blue" | "done" }` — real-time worker progress

**New dependencies:**
- `chalk@5` — ANSI color strings rendered inside Ink's `<Text>` components

**ink-app.tsx enhancements:**
- All output colorized via chalk: `cyan` headers/separators, `green`/`red`/`yellow` status icons, severity-colored issues (`critical`=red bold, `high`=red, `medium`=yellow, `low`=dim), `dim` costs, `bold` labels
- `DynamicStatus` component: animated braille spinner (`useEffect` + `setInterval` at 80ms), shown for spinner-flagged status events in the dynamic section (below `<Static>`)
- Worker panel: shows per-worker phase (red team/blue team/done) with individual spinners during multi-worker execution
- Helper functions: `severityColor()`, `coverageColor()`, `statusIcon()`, `sectionHeader()`
- `MultiSelectPrompt` enhanced with colored cursor (`cyan ❯`), green selected indicators, bold focused item

**ink-renderer.ts enhancements:**
- Spinner status events (`spinner: true`) stored as transient `spinnerMessage`, not added to static events array — disappear when result events arrive
- `worker-phase` events update a `workerPhases` Map, clear spinner — dynamic section shows worker panel instead
- `iteration-complete`/`unit-batch-complete` events clear worker phases map
- Banner rendered with chalk cyan colors
- New props passed to App: `spinnerMessage: string | null`, `workerPhases: [number, string][]`

**Orchestrator changes (both orchestrators):**
- 18 status events flagged with `spinner: true` across both orchestrators (scanning, planning, generating missions, dispatching workers, red/blue team execution, applying fixes, ownership analysis)
- `executeTask` in integration orchestrator wrapped in `try/finally` emitting `worker-phase` events: `"red"` before red team, `"blue"` before blue team, `"done"` in finally block

**Key design decisions:**
- Spinner events are transient — they show in the dynamic section during long operations and vanish when the result event arrives, keeping the static scrollback clean
- Worker panel replaces spinner during multi-worker dispatch — when `worker-phase` events arrive, they clear `spinnerMessage` and the dynamic section shows per-worker status instead
- Colors use chalk strings inside `<Text>` rather than Ink's color props — simpler to apply in the existing `formatEvent` string-based architecture
- Spinner animation uses `useEffect`/`setInterval` which triggers React state updates independently of `rerender()` calls — Ink reconciles both sources of updates correctly

---

## Phase 4: Cleanup — COMPLETED (2026-03-24)

**Result:** All dead code removed. `deno task check` passes clean. Migration complete.

**Files deleted:**
- `src/ui/console-renderer.ts` — Transitional bridge from Phase 1, no longer imported
- `src/ui/emitter.ts` — `createTenetUI()` factory, only consumer was console-renderer
- `src/utils/multiselect.ts` — Raw terminal interactive component, replaced by Ink `MultiSelectPrompt`

**Files stripped:**
- `src/utils/logger.ts` — Reduced from 503 LOC (20+ print functions) to 25 LOC. Retained only `debug()`, `startTimer()`, `setVerbose()`, `printWarning()` — still imported by core logic files (`scanner.ts`, `mission.ts`, `fix-phase.ts`, `sandbox.ts`, `ownership.ts`, `red-team.ts`, `blue-team.ts`) and both orchestrators.

**Key decision:**
- `logger.ts` was not fully deleted because core logic files (which must not be modified) import `debug`, `printWarning`, and `startTimer` directly. The file was stripped to just those 4 utility functions.

---

## Risk Matrix

| Risk | Severity | Phase | Mitigation |
|------|----------|-------|------------|
| ~~Ink's yoga-layout native bindings fail under Deno~~ | ~~HIGH~~ | 0 | ~~RESOLVED — spike test passed~~ |
| ~~`deno compile` can't bundle Ink + React~~ | ~~HIGH~~ | 0 | ~~RESOLVED — compiles to working binary~~ |
| ~~Event emitter introduces subtle ordering bugs~~ | ~~Medium~~ | 1 | ~~RESOLVED — events are synchronous, same call order preserved~~ |
| ~~Ink takes over stdout, conflicts with `debug()` calls from core modules~~ | ~~Medium~~ | 2 | ~~RESOLVED — Ink's `patch-console` handles console.log interleaving~~ |
| ~~SIGINT handling conflicts between Ink and AbortController~~ | ~~Medium~~ | 2 | ~~RESOLVED — SIGINT handler calls unmount() then Deno.exit(130)~~ |
| ~~multiselect replacement changes interactive UX~~ | ~~Low~~ | 2 | ~~RESOLVED — MultiSelect reimplemented as Ink component in Phase 2~~ |

## Key Principles

1. **Phase 0 is non-negotiable.** Don't write production Ink code without proving Deno compat. (DONE)
2. **Phase 1 is valuable independently.** The event emitter decouples UI from logic regardless of renderer. (DONE)
3. **Ink is the only UI.** No `--ui` flag, no console fallback. Old logger.ts print functions deleted in Phase 4. (DONE)
4. **Core logic files stay untouched.** Only orchestrators, main.ts, and UI layer change.
5. **Each phase is independently shippable** — the app works after every merge.

## Final File Layout (migration complete)

**Ink UI layer:**
- `src/ui/events.ts` — `UIEvent` union (20 types), `TenetUI` interface, `MultiSelectOptions`
- `src/ui/ink-app.tsx` — Root Ink component: `App`, `formatEvent` (chalk-colored), `DynamicStatus` (spinner + worker panel), `MultiSelectPrompt`
- `src/ui/ink-renderer.ts` — `createInkUI()` factory: events array + spinner/worker state + rerender bridge

**Utilities (stripped):**
- `src/utils/logger.ts` — 25 LOC: `debug()`, `startTimer()`, `setVerbose()`, `printWarning()` only

**Orchestration (emit events via TenetUI):**
- `src/tenet/orchestrator.ts` — Uses `ui.emit()` / `ui.multiSelect()`, emits `spinner: true` on 10 status events, emits `worker-phase` in `executeTask` with try/finally
- `src/tenet/unit-orchestrator.ts` — Uses `ui.emit()` / `ui.multiSelect()`, emits `spinner: true` on 8 status events
- `src/main.ts` — Creates `ui` via `createInkUI()`, passes to orchestrators, handles `unmount()` lifecycle

**Untouched (core logic):**
- `src/red/red-team.ts`, `src/blue/blue-team.ts`, `src/tenet/scanner.ts`, `src/tenet/coverage.ts`, `src/tenet/mission.ts`, `src/tenet/fix-phase.ts`, `src/tenet/sandbox.ts`, `src/tenet/ownership.ts`, `src/types.ts`
