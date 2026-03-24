import type { Inventory, Task, TaskResult, TenetConfig } from "../types.ts";
import { DEFAULT_TYPE_PRIORITY } from "../types.ts";
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
  printScanResult,
  printRoundStart,
  printRedTeamResult,
  printBlueTeamResult,
  printRoundComplete,
  printFinalSummary,
  printFinalSummaryV2,
  printDryRunMission,
  printDryRunIterationPlan,
  printIterationStart,
  printWorkerResult,
  printFixPhaseResult,
  printIterationComplete,
  printError,
  printWarning,
  debug,
  startTimer,
  setVerbose,
} from "../utils/logger.ts";
import { multiSelect } from "../utils/multiselect.ts";

// ─── Worker Execution ───────────────────────────────────────────────────────

async function executeTask(
  task: Task,
  config: TenetConfig,
  inventory: Inventory,
  abortController: AbortController,
): Promise<TaskResult> {
  const result: TaskResult = {
    taskId: task.taskId,
    workerId: task.workerId,
  };

  const label = config.workers > 1 ? `worker-${task.workerId}` : "";

  // Red team
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
    printError(`${label || "Red team"} red team failed`, err);
    return result;
  }

  if (abortController.signal.aborted) return result;

  // Blue team (analysis-only in multi-worker integration mode)
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
    printError(`${label || "Blue team"} blue team failed`, err);
  }

  return result;
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

export async function runTenet(
  config: TenetConfig,
  abortController: AbortController,
): Promise<void> {
  setVerbose(config.verbose);

  // Route to single-worker mode for backward compatibility
  if (config.workers <= 1) {
    return runTenetSingleWorker(config, abortController);
  }

  return runTenetMultiWorker(config, abortController);
}

// ─── Multi-Worker Mode ──────────────────────────────────────────────────────

async function runTenetMultiWorker(
  config: TenetConfig,
  abortController: AbortController,
): Promise<void> {
  const totalElapsed = startTimer();

  // Step 1: Initial scan
  console.log("  Scanning target project...\n");
  debug(`orchestrator: scanning ${config.targetPath}`);
  const phaseTimer = startTimer();
  let inventory = await scanProject(config.targetPath);
  debug(`orchestrator: scan complete [${phaseTimer()}]`);
  printScanResult(inventory);

  if (inventory.components.length === 0) {
    console.log(
      "  No components found. Is this a Claude agent project?\n" +
      "  Expected: CLAUDE.md, .claude/skills/, .claude/commands/, etc.\n",
    );
    return;
  }

  // Prompt user for priority components
  const userSelected = await multiSelect({
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
    console.log(`  Planning iteration (dry run, ${config.workers} workers)...\n`);
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
    printDryRunIterationPlan(plan.missions);
    return;
  }

  // Iteration loop
  for (let iteration = 1; iteration <= config.rounds; iteration++) {
    if (abortController.signal.aborted) break;

    // Check termination: all components in scope are "pass"
    const scopeIds = userSelectedSet.size > 0 ? userSelectedSet : undefined;
    if (isFullyPassed(coverage, scopeIds) && iteration > 1) {
      const scope = scopeIds ? "Selected components" : "All components";
      console.log(`  ${scope} — all pass! Stopping early.\n`);
      break;
    }

    // Re-scan on subsequent iterations (fixes may have changed files)
    if (iteration > 1) {
      inventory = await scanProject(config.targetPath);
    }

    // Plan iteration: generate N missions + status updates
    console.log(`  Planning iteration ${iteration} (${config.workers} workers)...\n`);
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
        console.log(`  All components promoted to pass after planning. Stopping early.\n`);
        break;
      }
    }

    printIterationStart(iteration, config.rounds, plan.missions, config.workers);

    // Dispatch tasks to workers
    const tasks: Task[] = plan.missions.map((mission, i) => ({
      taskId: crypto.randomUUID(),
      mission,
      workerId: i + 1,
    }));

    console.log(`  Dispatching ${tasks.length} workers...\n`);
    const dispatchTimer = startTimer();

    const results = await Promise.all(
      tasks.map((task) => executeTask(task, config, inventory, abortController)),
    );

    debug(`orchestrator: all workers complete [${dispatchTimer()}]`);

    if (abortController.signal.aborted) break;

    // Print worker results
    for (const result of results) {
      printWorkerResult(result.workerId, result);
    }
    console.log("");

    // Update coverage from all blue reports
    updateCoverageFromResults(coverage, results, iteration);

    // Fix phase: collect, dedup, apply
    const proposedFixes = collectAndDedup(results);
    let fixesApplied = 0;
    if (proposedFixes.length > 0 && !abortController.signal.aborted) {
      console.log(`  Applying ${proposedFixes.length} fixes...\n`);
      const fixTimer = startTimer();
      fixesApplied = await applyFixes(proposedFixes, config.targetPath, abortController);
      debug(`orchestrator: fix phase complete [${fixTimer()}]`);
    }
    printFixPhaseResult(fixesApplied, proposedFixes.length);

    // Record iteration summary
    coverage.iterations.push({
      iteration,
      taskResults: results,
      fixesAppliedCount: fixesApplied,
      timestamp: new Date().toISOString(),
    });

    // Print iteration report
    printIterationComplete(iteration, config.rounds, results, coverage, fixesApplied);
  }

  // Final summary
  if (coverage.iterations.length > 0) {
    printFinalSummaryV2(coverage);
  }
  debug(`orchestrator: total runtime [${totalElapsed()}]`);
}

// ─── Single-Worker Mode (Backward Compatible) ──────────────────────────────

async function runTenetSingleWorker(
  config: TenetConfig,
  abortController: AbortController,
): Promise<void> {
  const totalElapsed = startTimer();

  // Step 1: Initial scan
  console.log("  Scanning target project...\n");
  debug(`orchestrator: scanning ${config.targetPath}`);
  const phaseTimer = startTimer();
  const inventory = await scanProject(config.targetPath);
  debug(`orchestrator: scan complete [${phaseTimer()}]`);
  printScanResult(inventory);

  if (inventory.components.length === 0) {
    console.log(
      "  No components found. Is this a Claude agent project?\n" +
      "  Expected: CLAUDE.md, .claude/skills/, .claude/commands/, etc.\n",
    );
    return;
  }

  // Prompt user for priority components
  const userSelected = await multiSelect({
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
    console.log("  Generating mission (dry run)...\n");
    const mission = await generateMission(
      inventory,
      coverage,
      1,
      config.rounds,
      config.maxExchanges,
      abortController,
      priorityComponents,
    );
    printDryRunMission(mission);
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
      console.log(`  ${scope} — all pass! Stopping early.\n`);
      break;
    }

    // Re-scan on subsequent rounds (blue team may have added/changed files)
    let currentInventory = inventory;
    if (round > 1) {
      currentInventory = await scanProject(config.targetPath);
    }

    // Generate mission
    console.log(`  Generating mission for round ${round}...\n`);
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
    printRoundStart(round, config.rounds, mission);

    // Red team
    console.log("  Running red team...\n");
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
      printRedTeamResult(redResult);
    } catch (err) {
      debug(`orchestrator: red team THREW [${missionTimer()}] — ${err}`);
      printError("Red team failed", err);
      continue;
    }

    if (abortController.signal.aborted) break;

    // Blue team (with tool access in single-worker mode for backward compat)
    console.log("  Running blue team...\n");
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
      printBlueTeamResult(blueReport);
    } catch (err) {
      debug(`orchestrator: blue team THREW [${missionTimer()}] — ${err}`);
      printError("Blue team failed", err);
      continue;
    }

    if (abortController.signal.aborted) break;

    // Update coverage
    updateCoverage(coverage, blueReport, redResult, round, mission.objective);

    // Print round report
    printRoundComplete(
      round,
      config.rounds,
      mission,
      redResult,
      blueReport,
      coverage,
      currentInventory,
    );
  }

  // Final summary
  if (coverage.rounds.length > 0) {
    printFinalSummary(coverage);
  }
  debug(`orchestrator: total runtime [${totalElapsed()}]`);
}
