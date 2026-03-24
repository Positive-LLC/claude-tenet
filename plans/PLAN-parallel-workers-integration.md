# Plan: Parallel Workers for Integration Test Mode

## Context

Currently, tenet runs rounds sequentially — one mission, one red team, one blue team at a time. This limits throughput, especially for projects with many components. The `--worker N` flag enables tenet to dispatch N concurrent red+blue pairs per iteration, significantly reducing total test time while maintaining the depth-first testing strategy.

This plan covers **integration test mode only**. Unit test mode will be designed separately.

---

## New Entities

### Task

A Task is a self-contained red+blue pair execution unit. It holds:
- A `Mission` (assigned by tenet)
- Produces a `RedTeamResult` and a `BlueTeamReport`
- Blue team is **analysis-only** — no fixes applied during task execution

```
interface Task {
  taskId: string;
  mission: Mission;
  workerId: number;
}

interface TaskResult {
  taskId: string;
  workerId: number;
  redResult?: RedTeamResult;    // undefined if red team failed
  blueReport?: BlueTeamReport;  // undefined if blue team failed
}
```

### Worker

A Worker is a stateless async executor. It receives a Task, runs the red team relay then blue team analysis, and returns a TaskResult. Workers run concurrently via `Promise.all` (single-thread Deno async, no threads needed).

```
interface Worker {
  id: number;
  execute(task: Task, config, abortController): Promise<TaskResult>;
}
```

Workers have no state between iterations. They are conceptually just numbered slots.

---

## Three-Status Coverage Model

Replace the current binary `covered: boolean` with a three-way status:

```
type ComponentStatus = "untested" | "pass" | "proceed" | "fail";
```

| Status | Meaning | Next iteration? |
|---|---|---|
| `untested` | Never tested | Yes |
| `pass` | Tested, behavior correct, sufficient depth | **No — done** |
| `proceed` | Tested, no blocking issues, but needs more depth | Yes |
| `fail` | Issues found | Yes (high priority) |

**Who decides:** The orchestrator's mission-planning LLM call determines status. It has cross-iteration context — it sees all previous blue team reports for a component and judges whether depth is sufficient to promote "proceed" → "pass" or whether more testing is needed.

**Key change to `CoverageStatus`:**
```
interface CoverageStatus {
  status: ComponentStatus;       // replaces `covered: boolean`
  statusUpdatedInIteration?: number;
  issueCount: number;
  fixCount: number;
}
```

---

## Revised Orchestrator Loop (Integration Mode)

```
1. Scan project → Inventory
2. User selects priority components
3. Initialize coverage (all components: "untested")

4. ITERATION LOOP:
   │
   ├─ 4a. Check termination
   │       - All components in scope are "pass" → stop
   │       - Max iterations reached → stop
   │
   ├─ 4b. Re-scan project (iterations > 1, since fixes were applied)
   │
   ├─ 4c. Mission planning (single LLM call)
   │       Input: remaining components (not "pass"), worker count N,
   │              full iteration history, priority list
   │       Output: N Missions, each with assigned focus components
   │       Also outputs: updated component statuses (proceed→pass promotions)
   │       This replaces the current separate generateMission() per round
   │
   ├─ 4d. Dispatch N Tasks to N Workers (Promise.all)
   │       Each worker runs: red team → blue team (analysis only)
   │       All workers target the live project directory
   │       Blue team produces proposedFixes[], not fixesApplied[]
   │
   ├─ 4e. Collect all TaskResults
   │
   ├─ 4f. Update coverage from all blue team reports
   │
   ├─ 4g. Fix phase (tenet-owned, sequential)
   │       Input: all proposedFixes[] from all workers' blue reports
   │       Deduplicate (multiple workers may flag same issue)
   │       Prioritize (critical > high > medium > low)
   │       Apply fixes to live project (single LLM call or direct application)
   │
   └─ 4h. Report iteration results

5. Final summary
```

---

## Key Design Decisions

### Blue team becomes analysis-only

- Current: `fixesApplied: Fix[]` — blue team reads session AND applies fixes
- New: `proposedFixes: ProposedFix[]` — blue team reads session, proposes fixes, applies nothing

```
interface ProposedFix {
  fixId: string;
  issueId: string;
  targetFilePath: string;
  description: string;
  suggestedChange: string;   // what to change (natural language or diff)
  priority: Severity;
}
```

Blue team's tools should be restricted (or it should run without tool access to the target project) to enforce analysis-only behavior. This is a prompt + configuration change to `runBlueTeam()`.

### Fix phase owned by tenet

After all workers complete, tenet runs a dedicated fix phase:

1. Collect all `proposedFixes[]` from all `BlueTeamReport`s
2. Deduplicate: multiple workers may report the same issue on the same file
3. Prioritize: sort by severity
4. Apply: single SDK call with tool access to the target project, given the deduplicated fix list
5. This is a new function: `applyFixes(proposedFixes[], targetPath, abortController)`

### Mission planning produces N missions in one call

- Current: `generateMission()` called once per round, produces 1 mission
- New: `planIteration()` called once per iteration, produces N missions (one per worker)
- Single LLM call ensures diversity — the model explicitly assigns different component groups and attack angles to each worker
- Also responsible for promoting "proceed" → "pass" based on accumulated history

### Concurrency model: live project, no isolation

- All N workers' red team sessions run against the same target directory
- The attacker session (red team proper) has no tools — cannot write
- The target session (Claude Code being tested) has full tools — may write files as part of natural behavior
- This is acceptable: concurrent target sessions represent realistic usage
- Only the fix phase writes structural changes, and it runs alone between iterations

### CLI changes

```
tenet integration -t ./my-project -r 5 -w 3
```

- `-w, --workers <n>` — Number of parallel workers (default: 1)
- `--rounds` semantics change: becomes max iterations (each iteration dispatches N workers)
- When `--workers 1`, behavior is identical to current sequential mode (backward compatible)

### `TenetConfig` update

```
interface TenetConfig {
  testMode: TestMode;
  rounds: number;          // now means "max iterations"
  maxExchanges: number;
  targetPath: string;
  verbose: boolean;
  dryRun: boolean;
  workers: number;         // new, default 1
}
```

---

## Files Modified

| File | Change |
|---|---|
| `src/types.ts` | Added `Task`, `TaskResult`, `ProposedFix`, `ComponentStatus`, `IterationPlan`, `StatusUpdate`, `IterationSummary`. Changed `CoverageStatus.covered` → `.status`. Added `proposedFixes` to `BlueTeamReport` and its schema. Added `workers` to `TenetConfig`. |
| `src/main.ts` | Parse `-w`/`--workers` argument. |
| `src/tenet/orchestrator.ts` | Rewritten with `runTenetMultiWorker()` iteration model: planIteration → dispatch workers → collect → fix phase → repeat. `runTenetSingleWorker()` preserves original behavior for `--workers 1`. |
| `src/tenet/mission.ts` | Added `planIteration()` that produces N missions + status updates in one LLM call. New `ITERATION_PLAN_SCHEMA`. Updated `buildMissionPrompt` to use `status` field. |
| `src/tenet/coverage.ts` | Updated `CoverageStatus` to use `ComponentStatus`. Added `updateCoverageFromResults()`, `applyStatusUpdates()`, `isFullyPassed()`. Updated `getCoverageStats()` with pass/fail/proceed/untested breakdown. |
| `src/blue/blue-team.ts` | Added `analysisOnly` parameter. When true, restricts to read-only tools (`Read`, `Glob`, `Grep`) and instructs proposing fixes instead of applying. |
| `src/tenet/fix-phase.ts` | **New file.** `collectAndDedup()` gathers and deduplicates proposed fixes. `applyFixes()` applies via single SDK call with tool access. |
| `prompts/blue-team.md` | Rewritten for analysis-only behavior: propose fixes in `proposedFixes`, leave `fixesApplied` empty. |
| `src/utils/logger.ts` | Added iteration-based print functions: `printIterationStart`, `printWorkerResult`, `printFixPhaseResult`, `printIterationComplete`, `printFinalSummaryV2`, `printDryRunIterationPlan`. |

---

## Backward Compatibility

- `--workers 1` (default) produces identical behavior to current sequential mode: 1 mission per iteration, 1 red+blue pair, fix phase applies that worker's proposals
- The `--rounds` flag keeps its name but semantics shift from "sequential rounds" to "max iterations" — each iteration may test more components than a single old round
- Existing `CoverageStatus.covered: boolean` retained as deprecated field for unit-orchestrator compatibility
- `BlueTeamReport.fixesApplied` retained as deprecated field for unit mode

---

## Verification

1. **Type-check**: `deno task check` passes after all changes
2. **Single worker**: `tenet integration -t <project> -r 3 -w 1` produces same behavior as current `tenet integration -t <project> -r 3`
3. **Multi-worker**: `tenet integration -t <project> -r 3 -w 3` dispatches 3 concurrent red+blue pairs, collects results, applies fixes between iterations
4. **Dry run**: `tenet integration --dry-run -w 3` generates 3 missions and prints them
5. **Early exit**: components reaching "pass" are excluded from subsequent iterations; loop terminates when all in-scope components pass
6. **Fix deduplication**: when two workers flag the same issue, only one fix is applied
