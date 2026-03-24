import type { Inventory, Task, TaskResult, TenetConfig } from "../types.ts";
import { DEFAULT_TYPE_PRIORITY } from "../types.ts";
import type { TenetUI } from "../ui/events.ts";
import { scanProject } from "./scanner.ts";
import { generateMission, planIteration } from "./mission.ts";
import {
  initCoverage,
  updateCoverage,
  updateCoverageFromResults,
  applyStatusUpdates,
  getCoverageStats,
  isFullyPassed,
} from "./coverage.ts";
import { collectAndDedup, applyFixes } from "./fix-phase.ts";
import { runRedTeam } from "../red/red-team.ts";
import { runBlueTeam } from "../blue/blue-team.ts";
import {
  debug,
  startTimer,
  setVerbose,
} from "../utils/logger.ts";

// ─── Worker Execution ───────────────────────────────────────────────────────

async function executeTask(
  task: Task,
  config: TenetConfig,
  inventory: Inventory,
  abortController: AbortController,
  ui: TenetUI,
): Promise<TaskResult> {
  const result: TaskResult = {
    taskId: task.taskId,
    workerId: task.workerId,
  };

  const label = config.workers > 1 ? `worker-${task.workerId}` : "";

  try {
    // Red team
    ui.emit({ type: "worker-phase", workerId: task.workerId, phase: "red" });
    if (label) debug(`${label}: starting red team`);
    try {
      result.redResult = await runRedTeam(
        task.mission,
        config.targetPath,
        config.maxExchanges,
        abortController,
        inventory.plugins,
      );
      if (label) debug(`${label}: red team done — ${result.redResult.conversationTurns} turns`);
    } catch (err) {
      ui.emit({ type: "error", context: `${label || "Red team"} red team failed`, error: err });
      return result;
    }

    if (abortController.signal.aborted) return result;

    // Blue team (analysis-only in multi-worker integration mode)
    ui.emit({ type: "worker-phase", workerId: task.workerId, phase: "blue" });
    if (label) debug(`${label}: starting blue team (analysis-only)`);
    try {
      result.blueReport = await runBlueTeam(
        result.redResult,
        task.mission,
        inventory,
        config.targetPath,
        abortController,
        inventory.plugins,
        true, // analysisOnly
      );
      if (label) debug(`${label}: blue team done — ${result.blueReport.issuesFound.length} issues`);
    } catch (err) {
      ui.emit({ type: "error", context: `${label || "Blue team"} blue team failed`, error: err });
    }

    return result;
  } finally {
    ui.emit({ type: "worker-phase", workerId: task.workerId, phase: "done" });
  }
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

export async function runTenet(
  config: TenetConfig,
  abortController: AbortController,
  ui: TenetUI,
): Promise<void> {
  setVerbose(config.verbose);

  // Route to single-worker mode for backward compatibility
  if (config.workers <= 1) {
    return runTenetSingleWorker(config, abortController, ui);
  }

  return runTenetMultiWorker(config, abortController, ui);
}

// ─── Multi-Worker Mode ──────────────────────────────────────────────────────

async function runTenetMultiWorker(
  config: TenetConfig,
  abortController: AbortController,
  ui: TenetUI,
): Promise<void> {
  const totalElapsed = startTimer();

  // Step 1: Initial scan
  ui.emit({ type: "status", message: "  Scanning target project...\n", spinner: true });
  debug(`orchestrator: scanning ${config.targetPath}`);
  const phaseTimer = startTimer();
  let inventory = await scanProject(config.targetPath);
  debug(`orchestrator: scan complete [${phaseTimer()}]`);
  ui.emit({ type: "scan-result", inventory });

  if (inventory.components.length === 0) {
    ui.emit({
      type: "status",
      message:
        "  No components found. Is this a Claude agent project?\n" +
        "  Expected: CLAUDE.md, .claude/skills/, .claude/commands/, etc.\n",
    });
    return;
  }

  // Prompt user for priority components
  const userSelected = await ui.multiSelect({
    title: "Any components you want to prioritize for testing?",
    hint: "↑/↓ navigate · Space toggle · Enter confirm · Esc use default priority",
    items: inventory.components.map((c) => ({
      label: `[${c.type}] ${c.id.replace(/^[^:]+:/, "")}`,
      value: c.id,
    })),
  });

  const userSelectedSet = new Set(userSelected);
  const remaining = inventory.components
    .filter((c) => !userSelectedSet.has(c.id))
    .sort((a, b) => DEFAULT_TYPE_PRIORITY[b.type] - DEFAULT_TYPE_PRIORITY[a.type])
    .map((c) => c.id);
  const priorityComponents = [...userSelected, ...remaining];

  // Initialize coverage
  const coverage = initCoverage(inventory);

  // Dry run
  if (config.dryRun) {
    ui.emit({ type: "status", message: `  Planning iteration (dry run, ${config.workers} workers)...\n`, spinner: true });
    const plan = await planIteration(
      inventory,
      coverage,
      1,
      config.rounds,
      config.maxExchanges,
      config.workers,
      abortController,
      priorityComponents,
    );
    ui.emit({ type: "dry-run-iteration-plan", missions: plan.missions });
    return;
  }

  // Iteration loop
  for (let iteration = 1; iteration <= config.rounds; iteration++) {
    if (abortController.signal.aborted) break;

    // Check termination: all components in scope are "pass"
    const scopeIds = userSelectedSet.size > 0 ? userSelectedSet : undefined;
    if (isFullyPassed(coverage, scopeIds) && iteration > 1) {
      const scope = scopeIds ? "Selected components" : "All components";
      ui.emit({ type: "status", message: `  ${scope} — all pass! Stopping early.\n` });
      break;
    }

    // Re-scan on subsequent iterations (fixes may have changed files)
    if (iteration > 1) {
      inventory = await scanProject(config.targetPath);
    }

    // Plan iteration: generate N missions + status updates
    ui.emit({ type: "status", message: `  Planning iteration ${iteration} (${config.workers} workers)...\n`, spinner: true });
    const planTimer = startTimer();
    const plan = await planIteration(
      inventory,
      coverage,
      iteration,
      config.rounds,
      config.maxExchanges,
      config.workers,
      abortController,
      priorityComponents,
    );
    debug(`orchestrator: iteration planned [${planTimer()}] — ${plan.missions.length} missions, ${plan.statusUpdates.length} status updates`);

    if (abortController.signal.aborted) break;

    // Apply status updates (e.g., proceed → pass promotions)
    if (plan.statusUpdates.length > 0) {
      applyStatusUpdates(coverage, plan.statusUpdates, iteration);
      debug(`orchestrator: applied ${plan.statusUpdates.length} status updates`);

      // Re-check termination after status updates
      if (isFullyPassed(coverage, scopeIds)) {
        ui.emit({ type: "status", message: "  All components promoted to pass after planning. Stopping early.\n" });
        break;
      }
    }

    ui.emit({ type: "iteration-start", iteration, totalIterations: config.rounds, missions: plan.missions, workerCount: config.workers });

    // Dispatch tasks to workers
    const tasks: Task[] = plan.missions.map((mission, i) => ({
      taskId: crypto.randomUUID(),
      mission,
      workerId: i + 1,
    }));

    ui.emit({ type: "status", message: `  Dispatching ${tasks.length} workers...\n`, spinner: true });
    const dispatchTimer = startTimer();

    const results = await Promise.all(
      tasks.map((task) => executeTask(task, config, inventory, abortController, ui)),
    );

    debug(`orchestrator: all workers complete [${dispatchTimer()}]`);

    if (abortController.signal.aborted) break;

    // Print worker results
    for (const result of results) {
      ui.emit({ type: "worker-result", workerId: result.workerId, result });
    }
    ui.emit({ type: "status", message: "" });

    // Update coverage from all blue reports
    updateCoverageFromResults(coverage, results, iteration);

    // Fix phase: collect, dedup, apply
    const proposedFixes = collectAndDedup(results);
    let fixesApplied = 0;
    if (proposedFixes.length > 0 && !abortController.signal.aborted) {
      ui.emit({ type: "status", message: `  Applying ${proposedFixes.length} fixes...\n`, spinner: true });
      const fixTimer = startTimer();
      fixesApplied = await applyFixes(proposedFixes, config.targetPath, abortController);
      debug(`orchestrator: fix phase complete [${fixTimer()}]`);
    }
    ui.emit({ type: "fix-phase-result", appliedCount: fixesApplied, totalProposed: proposedFixes.length });

    // Record iteration summary
    coverage.iterations.push({
      iteration,
      taskResults: results,
      fixesAppliedCount: fixesApplied,
      timestamp: new Date().toISOString(),
    });

    // Print iteration report
    ui.emit({ type: "iteration-complete", iteration, totalIterations: config.rounds, results, coverage, fixesApplied });
  }

  // Final summary
  if (coverage.iterations.length > 0) {
    ui.emit({ type: "final-summary-v2", coverage });
  }
  debug(`orchestrator: total runtime [${totalElapsed()}]`);
}

// ─── Single-Worker Mode (Backward Compatible) ──────────────────────────────

async function runTenetSingleWorker(
  config: TenetConfig,
  abortController: AbortController,
  ui: TenetUI,
): Promise<void> {
  const totalElapsed = startTimer();

  // Step 1: Initial scan
  ui.emit({ type: "status", message: "  Scanning target project...\n", spinner: true });
  debug(`orchestrator: scanning ${config.targetPath}`);
  const phaseTimer = startTimer();
  const inventory = await scanProject(config.targetPath);
  debug(`orchestrator: scan complete [${phaseTimer()}]`);
  ui.emit({ type: "scan-result", inventory });

  if (inventory.components.length === 0) {
    ui.emit({
      type: "status",
      message:
        "  No components found. Is this a Claude agent project?\n" +
        "  Expected: CLAUDE.md, .claude/skills/, .claude/commands/, etc.\n",
    });
    return;
  }

  // Prompt user for priority components
  const userSelected = await ui.multiSelect({
    title: "Any components you want to prioritize for testing?",
    hint: "↑/↓ navigate · Space toggle · Enter confirm · Esc use default priority",
    items: inventory.components.map((c) => ({
      label: `[${c.type}] ${c.id.replace(/^[^:]+:/, "")}`,
      value: c.id,
    })),
  });

  const userSelectedSet = new Set(userSelected);
  const remaining = inventory.components
    .filter((c) => !userSelectedSet.has(c.id))
    .sort((a, b) => DEFAULT_TYPE_PRIORITY[b.type] - DEFAULT_TYPE_PRIORITY[a.type])
    .map((c) => c.id);
  const priorityComponents = [...userSelected, ...remaining];

  // Initialize coverage
  const coverage = initCoverage(inventory);

  // Dry run
  if (config.dryRun) {
    ui.emit({ type: "status", message: "  Generating mission (dry run)...\n", spinner: true });
    const mission = await generateMission(
      inventory,
      coverage,
      1,
      config.rounds,
      config.maxExchanges,
      abortController,
      priorityComponents,
    );
    ui.emit({ type: "dry-run-mission", mission });
    return;
  }

  // Main loop
  for (let round = 1; round <= config.rounds; round++) {
    if (abortController.signal.aborted) break;

    // Check if full coverage already achieved
    const scopeIds = userSelectedSet.size > 0 ? userSelectedSet : undefined;
    const stats = getCoverageStats(coverage, scopeIds);
    if (stats.covered === stats.total && stats.total > 0 && round > 1) {
      const scope = scopeIds ? "Selected components" : "Full coverage";
      ui.emit({ type: "status", message: `  ${scope} — all pass! Stopping early.\n` });
      break;
    }

    // Re-scan on subsequent rounds (blue team may have added/changed files)
    let currentInventory = inventory;
    if (round > 1) {
      currentInventory = await scanProject(config.targetPath);
    }

    // Generate mission
    ui.emit({ type: "status", message: `  Generating mission for round ${round}...\n`, spinner: true });
    let missionTimer = startTimer();
    debug(`orchestrator: generating mission for round ${round}`);
    const mission = await generateMission(
      currentInventory,
      coverage,
      round,
      config.rounds,
      config.maxExchanges,
      abortController,
      priorityComponents,
    );
    debug(`orchestrator: mission generated [${missionTimer()}]`);

    if (abortController.signal.aborted) break;
    ui.emit({ type: "round-start", round, totalRounds: config.rounds, mission });

    // Red team
    ui.emit({ type: "status", message: "  Running red team...\n", spinner: true });
    missionTimer = startTimer();
    debug(`orchestrator: starting red team — maxExchanges=${config.maxExchanges}`);
    let redResult;
    try {
      redResult = await runRedTeam(
        mission,
        config.targetPath,
        config.maxExchanges,
        abortController,
        currentInventory.plugins,
      );
      debug(`orchestrator: red team done [${missionTimer()}] — ${redResult.conversationTurns} turns, $${redResult.costUsd.toFixed(2)}`);
      ui.emit({ type: "red-team-result", result: redResult });
    } catch (err) {
      debug(`orchestrator: red team THREW [${missionTimer()}] — ${err}`);
      ui.emit({ type: "error", context: "Red team failed", error: err });
      continue;
    }

    if (abortController.signal.aborted) break;

    // Blue team (with tool access in single-worker mode for backward compat)
    ui.emit({ type: "status", message: "  Running blue team...\n", spinner: true });
    missionTimer = startTimer();
    debug(`orchestrator: starting blue team — sessionFile=${redResult.sessionFilePath}`);
    let blueReport;
    try {
      blueReport = await runBlueTeam(
        redResult,
        mission,
        currentInventory,
        config.targetPath,
        abortController,
        currentInventory.plugins,
        false, // not analysis-only in single-worker mode
      );
      debug(`orchestrator: blue team done [${missionTimer()}] — ${blueReport.issuesFound.length} issues`);
      ui.emit({ type: "blue-team-result", report: blueReport });
    } catch (err) {
      debug(`orchestrator: blue team THREW [${missionTimer()}] — ${err}`);
      ui.emit({ type: "error", context: "Blue team failed", error: err });
      continue;
    }

    if (abortController.signal.aborted) break;

    // Update coverage
    updateCoverage(coverage, blueReport, redResult, round, mission.objective);

    // Print round report
    ui.emit({
      type: "round-complete",
      round,
      totalRounds: config.rounds,
      mission,
      redResult,
      blueReport,
      coverage,
      inventory: currentInventory,
    });
  }

  // Final summary
  if (coverage.rounds.length > 0) {
    ui.emit({ type: "final-summary", coverage });
  }
  debug(`orchestrator: total runtime [${totalElapsed()}]`);
}
