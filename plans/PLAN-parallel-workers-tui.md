# Plan: Parallel Workers + Unit Test Workers + TUI Refactor

## Context

Tenet currently runs rounds sequentially and outputs plain text via `console.log`. The `PLAN-parallel-workers-integration.md` describes a multi-worker iteration model for integration test mode, which is partially implemented (modified files on `staging` branch). This plan covers three phases:

1. **Complete parallel workers for integration mode** (finish in-progress work)
2. **Extend parallel workers to unit test mode** (new)
3. **TUI refactor** using deno_tui framework (new)

---

## Phase 1: Complete Parallel Workers — Integration Mode

Finish the implementation described in `PLAN-parallel-workers-integration.md`. The following files are already modified on `staging`:

| File | Status | Remaining |
|---|---|---|
| `src/types.ts` | Modified | Verify Task, TaskResult, ProposedFix, ComponentStatus, IterationPlan types |
| `src/main.ts` | Modified | Verify `-w`/`--workers` argument parsing |
| `src/tenet/orchestrator.ts` | Modified | Verify `runTenetMultiWorker()` iteration loop |
| `src/tenet/mission.ts` | Modified | Verify `planIteration()` producing N missions |
| `src/tenet/coverage.ts` | Modified | Verify `updateCoverageFromResults()`, `applyStatusUpdates()`, `isFullyPassed()` |
| `src/blue/blue-team.ts` | Modified | Verify `analysisOnly` parameter and read-only tool restriction |
| `src/tenet/fix-phase.ts` | New file | Verify `collectAndDedup()` and `applyFixes()` |
| `prompts/blue-team.md` | Modified | Verify analysis-only prompt |
| `src/utils/logger.ts` | Modified | Verify iteration-based print functions |

**Verification:**
- `deno task check` passes
- `--workers 1` behaves identically to current sequential mode
- `--workers 3` dispatches 3 concurrent red+blue pairs
- `--dry-run -w 3` prints 3 missions
- Components reaching "pass" are excluded from subsequent iterations

---

## Phase 2: Extend Parallel Workers — Unit Test Mode

Adapt the multi-worker model for `src/tenet/unit-orchestrator.ts`.

### Key differences from integration mode
- Unit tests run in sandboxed environments (`src/tenet/sandbox.ts`), not the live project
- Each worker needs its own sandbox (already isolated — no conflict)
- Mission planning targets individual components for focused behavioral testing
- Blue team evaluates behavioral correctness more strictly
- Fix phase applies to the original project, not sandboxes

### Changes needed
| File | Change |
|---|---|
| `src/tenet/unit-orchestrator.ts` | Add `runUnitMultiWorker()` mirroring integration's iteration model: plan N missions → dispatch N sandbox workers → collect → fix |
| `src/tenet/sandbox.ts` | Ensure sandbox creation supports concurrent instances (verify no shared state) |
| `src/tenet/mission.ts` | Extend `planIteration()` to handle unit test missions (testMode, setupType, systemPromptComponentId) |
| `src/main.ts` | Wire `--workers` flag to unit test mode |

### Design decisions
- Each worker gets its own sandbox — no shared filesystem conflicts
- Sandbox cleanup happens per-worker after blue team analysis
- Fix phase runs against the real project directory (same as integration mode)
- `--workers 1` preserves current unit test behavior

**Verification:**
- `deno task check` passes
- `tenet unit -t <project> -r 3 -w 1` same as current behavior
- `tenet unit -t <project> -r 3 -w 3` runs 3 sandboxed workers concurrently

---

## Phase 3: TUI Refactor with deno_tui

### Framework
- **Library:** `deno.land/x/tui@2.1.11` (Im-Beast/deno_tui)
- **Styling:** `deno.land/x/crayon@3.3.3`
- **Architecture:** Signal-based reactivity, VerticalLayout, event-driven state

### TUI activation
- Default ON for interactive terminals
- Auto-disable when stdout is piped
- `--no-tui` flag for explicit plain-text fallback
- `--tui` flag to force TUI even in non-interactive contexts

### Screen layout (VerticalLayout)

```
┌─────────────────────────────────────────────────────────┐
│ TENET  Iteration 2/5  ██████████░░░░░ 60%  Cost: $0.42 │  ← "header" (3 rows)
├─────────────────────────────────────────────────────────┤
│ ▶ Worker 1  🔴 Red [5/8]   12.3s   2 issues            │  ← "workers" (dynamic)
│ ▼ Worker 2  🔵 Blue        8.1s    0 issues             │
│ │  Mission: Probe skill:create-file error handling      │
│ │  Components: skill:create-file ✗  hook:onSave ✓      │
│ │  Issues: [high] Missing error handler in SKILL.md    │
│ │  Proposed fixes: 2                                    │
│ ▶ Worker 3  🔴 Red [3/8]   6.2s    0 issues            │
├─────────────────────────────────────────────────────────┤
│ ✓4 pass  →2 proceed  ✗1 fail  ○3 untested              │  ← "status" (3 rows)
├─────────────────────────────────────────────────────────┤
│ 14:32:01 Worker 1: Exchange 5 — attacker probing edge   │  ← "log" (remaining)
│ 14:32:03 Worker 2: Blue team analysis complete           │
└─────────────────────────────────────────────────────────┘
 ↑↓ navigate  ⏎ expand/collapse  q quit  v verbose
```

### Architecture

**Event emitter layer** — The orchestrator emits events instead of calling logger functions:

```
emitter.emit("iterationStart", { iteration, total, missions })
emitter.emit("workerUpdate", { workerId, phase, exchanges, elapsed, cost })
emitter.emit("workerComplete", { workerId, result })
emitter.emit("fixPhase", { collected, deduped, applied })
emitter.emit("coverageUpdate", { pass, proceed, fail, untested, percent })
emitter.emit("log", { timestamp, message })
```

**TUI adapter** — Subscribes to events, updates Signals:

```
Signals (orchestrator → TUI):
  iteration, totalIterations, coveragePercent, totalCost
  workers: WorkerState[] (phase, exchanges, elapsed, issues, mission, components)
  coverageSummary: { pass, proceed, fail, untested }
  logLines: string[]

UI-only Signals:
  expandedWorkers: Set<number>
```

**Plain-text adapter** — Same events, writes `console.log` (existing logger functions). Used for `--no-tui` and piped output.

### deno_tui patterns used
- `VerticalLayout` for main regions → `Signal<Rectangle>` per region
- Worker headers as `Button` components (focusable, activatable)
- `state.when("active", fn)` to toggle expand/collapse
- `visible` Signal on detail `Text` components
- `Computed` rectangles that recalculate when workers expand/collapse
- `View` for scrollable log region
- `handleKeyboardControls` for arrow navigation between workers
- Custom `keyPress` handler for `q` (quit) and `v` (verbose toggle)
- `.peek()` in all event handlers, `.value` only in Computed/Effect

### Files

| File | Change |
|---|---|
| `src/ui/tui.ts` | **New.** TUI root: creates Tui instance, VerticalLayout, all components. Exports `createTui(emitter)` |
| `src/ui/components/header.ts` | **New.** Header region: title, iteration, progress bar, cost |
| `src/ui/components/worker-list.ts` | **New.** Worker buttons + expandable details. Handles focus, expand/collapse, rect recalculation |
| `src/ui/components/status-bar.ts` | **New.** Coverage summary counts |
| `src/ui/components/log-view.ts` | **New.** Scrollable log tail using View |
| `src/ui/events.ts` | **New.** EventEmitter type definitions and factory |
| `src/ui/adapters/tui-adapter.ts` | **New.** Subscribes to events → updates Signals |
| `src/ui/adapters/plain-adapter.ts` | **New.** Subscribes to events → console.log (wraps existing logger functions) |
| `src/utils/logger.ts` | Refactor: extract event emission, keep print functions for plain adapter |
| `src/tenet/orchestrator.ts` | Replace direct logger calls with event emissions |
| `src/tenet/unit-orchestrator.ts` | Same — event emissions |
| `src/main.ts` | Parse `--tui`/`--no-tui`, detect TTY, create appropriate adapter |

### Verification
- `deno task check` passes
- Interactive terminal: TUI renders, arrow keys navigate workers, enter expands/collapses
- Piped output (`tenet ... | cat`): falls back to plain text
- `--no-tui`: plain text output identical to current behavior
- `--workers 3`: all 3 workers visible with live progress
- `q` key cleanly exits
- Terminal resize reflows layout

---

## Implementation Order

1. Phase 1 first — verify/complete parallel workers for integration mode
2. Phase 2 — extend to unit test mode
3. Phase 3 — TUI refactor (event layer → adapters → components → wire up)

Each phase should pass `deno task check` independently.
