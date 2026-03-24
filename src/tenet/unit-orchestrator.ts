import type { TenetConfig, UnitTestPlan, Inventory, Mission, BlueTeamReport, RedTeamResult, CoverageState } from "../types.ts";
import { DEFAULT_TYPE_PRIORITY } from "../types.ts";
import type { TenetUI } from "../ui/events.ts";
import { scanProject } from "./scanner.ts";
import { generateUnitMission } from "./mission.ts";
import { analyzeOwnership, buildUnitTestPlans } from "./ownership.ts";
import { createSandbox, populateSandbox, cleanupSandbox, syncFixesBack } from "./sandbox.ts";
import { initCoverage, updateCoverage, getCoverageStats } from "./coverage.ts";
import { runRedTeam } from "../red/red-team.ts";
import { runBlueTeam } from "../blue/blue-team.ts";
import { resolve, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  debug,
  startTimer,
  setVerbose,
} from "../utils/logger.ts";

// ─── Types (local to unit orchestrator) ──────────────────────────────────────

interface UnitTaskContext {
  plan: UnitTestPlan;
  sandboxPath: string;
  customSystemPrompt: string | undefined;
}

interface UnitTaskResult {
  plan: UnitTestPlan;
  sandboxPath: string;
  mission?: Mission;
  redResult?: RedTeamResult;
  blueReport?: BlueTeamReport;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load the system prompt content for a component (agent .md or CLAUDE.md).
 */
function loadSystemPrompt(
  comp: { type: string; filePath: string } | undefined,
  targetPath: string,
): string | undefined {
  if (!comp) return undefined;

  const absTarget = resolve(targetPath);
  try {
    const filePath = comp.filePath.startsWith("/")
      ? comp.filePath
      : join(absTarget, comp.filePath);
    const stat = Deno.statSync(filePath);

    if (stat.isDirectory) {
      // For skill-like directories, read the main .md
      try {
        return Deno.readTextFileSync(join(filePath, "SKILL.md"));
      } catch {
        for (const entry of Deno.readDirSync(filePath)) {
          if (entry.name.endsWith(".md")) {
            return Deno.readTextFileSync(join(filePath, entry.name));
          }
        }
      }
    } else {
      return Deno.readTextFileSync(filePath);
    }
  } catch {
    debug(`unit-orchestrator: could not load system prompt for ${comp.filePath}`);
  }
  return undefined;
}

/**
 * Create a worker context: sandbox + system prompt.
 */
async function createWorkerContext(
  plan: UnitTestPlan,
  config: TenetConfig,
  inventory: Inventory,
): Promise<UnitTaskContext> {
  const sandboxPath = await createSandbox(config.targetPath);
  plan.sandboxPath = sandboxPath;
  await populateSandbox(sandboxPath, config.targetPath, plan, inventory);

  let customSystemPrompt: string | undefined;
  if (plan.setupType === "focus") {
    const ownerComp = inventory.components.find(
      (c) => c.id === plan.systemPromptSource,
    );
    customSystemPrompt = loadSystemPrompt(ownerComp, config.targetPath);
  }

  return { plan, sandboxPath, customSystemPrompt };
}

/**
 * Execute a single unit task (red + blue) inside a sandbox.
 */
async function executeUnitTask(
  ctx: UnitTaskContext,
  mission: Mission,
  config: TenetConfig,
  inventory: Inventory,
  abortController: AbortController,
  ui: TenetUI,
): Promise<UnitTaskResult> {
  const result: UnitTaskResult = {
    plan: ctx.plan,
    sandboxPath: ctx.sandboxPath,
    mission,
  };

  const label = `unit-worker[${ctx.plan.targetComponent}]`;

  // Red team
  debug(`${label}: starting red team`);
  try {
    result.redResult = await runRedTeam(
      mission,
      ctx.sandboxPath,
      config.maxExchanges,
      abortController,
      inventory.plugins,
      ctx.customSystemPrompt,
    );
    debug(`${label}: red team done — ${result.redResult.conversationTurns} turns`);
  } catch (err) {
    ui.emit({ type: "error", context: `${label} red team failed`, error: err });
    return result;
  }

  if (abortController.signal.aborted) return result;

  // Blue team (full tool access in sandbox — isolated, no conflict risk)
  debug(`${label}: starting blue team`);
  try {
    result.blueReport = await runBlueTeam(
      result.redResult,
      mission,
      inventory,
      ctx.sandboxPath,
      abortController,
      inventory.plugins,
    );
    debug(`${label}: blue team done — ${result.blueReport.issuesFound.length} issues`);
  } catch (err) {
    ui.emit({ type: "error", context: `${label} blue team failed`, error: err });
  }

  return result;
}

// ─── Public Entry Point ──────────────────────────────────────────────────────

export async function runUnitTenet(
  config: TenetConfig,
  abortController: AbortController,
  ui: TenetUI,
): Promise<void> {
  if (config.workers <= 1) {
    return runUnitTenetSequential(config, abortController, ui);
  }
  return runUnitTenetMultiWorker(config, abortController, ui);
}

// ─── Multi-Worker Mode ───────────────────────────────────────────────────────

async function runUnitTenetMultiWorker(
  config: TenetConfig,
  abortController: AbortController,
  ui: TenetUI,
): Promise<void> {
  setVerbose(config.verbose);
  const totalElapsed = startTimer();

  // Step 1: Scan
  ui.emit({ type: "status", message: "  Scanning target project...\n", spinner: true });
  const inventory = await scanProject(config.targetPath);
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

  // Filter out MCP servers for unit testing
  const testableComponents = inventory.components.filter(
    (c) => c.type !== "mcp_server",
  );

  if (testableComponents.length === 0) {
    ui.emit({ type: "status", message: "  No testable components found (MCP servers are skipped in unit test mode).\n" });
    return;
  }

  // Step 2: User priority selection
  const userSelected = await ui.multiSelect({
    title: "Select components to unit test (or Enter for all):",
    hint: "↑/↓ navigate · Space toggle · Enter confirm · Esc use default priority",
    items: testableComponents.map((c) => ({
      label: `[${c.type}] ${c.id.replace(/^[^:]+:/, "")}`,
      value: c.id,
    })),
  });

  const userSelectedSet = new Set(userSelected);
  const remaining = testableComponents
    .filter((c) => !userSelectedSet.has(c.id))
    .sort((a, b) => DEFAULT_TYPE_PRIORITY[b.type] - DEFAULT_TYPE_PRIORITY[a.type])
    .map((c) => c.id);
  const priorityComponents = [...userSelected, ...remaining];

  // Step 3: LLM ownership analysis
  ui.emit({ type: "status", message: "  Analyzing component ownership...\n", spinner: true });
  const ownershipTimer = startTimer();
  const ownershipResult = await analyzeOwnership(
    inventory,
    config.targetPath,
    abortController,
  );
  debug(`unit-orchestrator: ownership analysis done [${ownershipTimer()}] — ${ownershipResult.assignments.length} assignments`);

  if (abortController.signal.aborted) return;

  // Build test plans
  const allPlans = buildUnitTestPlans(inventory, ownershipResult);
  const planMap = new Map(allPlans.map((p) => [p.targetComponent, p]));
  const orderedPlans: UnitTestPlan[] = [];
  for (const compId of priorityComponents) {
    const plan = planMap.get(compId);
    if (plan) orderedPlans.push(plan);
  }

  ui.emit({ type: "status", message: `  ${orderedPlans.length} unit test plans ready (${config.workers} workers).\n` });

  // Initialize coverage
  const coverage = initCoverage(inventory);

  // Dry run: generate missions for first batch
  if (config.dryRun) {
    const batchSize = Math.min(config.workers, orderedPlans.length);
    const batch = orderedPlans.slice(0, batchSize);
    ui.emit({ type: "status", message: `  Generating ${batchSize} unit test mission(s) (dry run)...\n`, spinner: true });
    const missions = await Promise.all(
      batch.map((plan) =>
        generateUnitMission(
          plan,
          inventory,
          coverage,
          1,
          config.rounds,
          config.maxExchanges,
          abortController,
          config.targetPath,
        )
      ),
    );
    for (let i = 0; i < missions.length; i++) {
      ui.emit({ type: "status", message: `  ── Worker ${i + 1}: ${batch[i].targetComponent} ──` });
      ui.emit({ type: "dry-run-mission", mission: missions[i] });
    }

    ui.emit({ type: "ownership-assignments", assignments: ownershipResult.assignments });
    return;
  }

  // Build queue from ordered plans
  const queue = [...orderedPlans];
  let iteration = 0;

  while (queue.length > 0 && iteration < config.rounds) {
    if (abortController.signal.aborted) break;

    iteration++;
    const batchSize = Math.min(config.workers, queue.length);
    const batch = queue.splice(0, batchSize);

    ui.emit({ type: "unit-batch-start", iteration, componentIds: batch.map((p) => p.targetComponent), totalRemaining: queue.length });

    // A. Create N sandboxes in parallel
    debug(`unit-orchestrator: creating ${batchSize} sandboxes`);
    const contextTimer = startTimer();
    let contexts: UnitTaskContext[];
    try {
      contexts = await Promise.all(
        batch.map((plan) => createWorkerContext(plan, config, inventory)),
      );
      debug(`unit-orchestrator: sandboxes created [${contextTimer()}]`);
    } catch (err) {
      ui.emit({ type: "error", context: "Failed to create sandboxes", error: err });
      // Cleanup any that were created
      for (const plan of batch) {
        if (plan.sandboxPath) {
          await cleanupSandbox(plan.sandboxPath);
        }
      }
      continue;
    }

    // B. Generate N missions in parallel
    debug(`unit-orchestrator: generating ${batchSize} missions`);
    const missionTimer = startTimer();
    const missions = await Promise.all(
      batch.map((plan) =>
        generateUnitMission(
          plan,
          inventory,
          coverage,
          iteration,
          config.rounds,
          config.maxExchanges,
          abortController,
          config.targetPath,
        )
      ),
    );
    debug(`unit-orchestrator: missions generated [${missionTimer()}]`);

    if (abortController.signal.aborted) {
      for (const ctx of contexts) {
        await cleanupSandbox(ctx.sandboxPath);
      }
      break;
    }

    // C. Execute N workers in parallel (red + blue per sandbox)
    ui.emit({ type: "status", message: `  Dispatching ${batchSize} workers...\n`, spinner: true });
    const execTimer = startTimer();
    const results = await Promise.all(
      contexts.map((ctx, i) =>
        executeUnitTask(ctx, missions[i], config, inventory, abortController, ui).catch(
          (err): UnitTaskResult => {
            ui.emit({ type: "error", context: `Worker ${ctx.plan.targetComponent} failed`, error: err });
            return { plan: ctx.plan, sandboxPath: ctx.sandboxPath, mission: missions[i] };
          },
        )
      ),
    );
    debug(`unit-orchestrator: all workers done [${execTimer()}]`);

    if (abortController.signal.aborted) {
      for (const ctx of contexts) {
        await cleanupSandbox(ctx.sandboxPath);
      }
      break;
    }

    // D. Sequential fix sync with conflict detection
    const syncedFiles = new Set<string>();
    for (const result of results) {
      if (!result.blueReport || result.blueReport.fixesApplied.length === 0) continue;

      for (const fix of result.blueReport.fixesApplied) {
        if (syncedFiles.has(fix.filePath)) {
          ui.emit({ type: "warning", message: `File conflict: ${fix.filePath} modified by multiple workers — last-write-wins from ${result.plan.targetComponent}` });
        }
        syncedFiles.add(fix.filePath);
      }

      ui.emit({ type: "status", message: `  Syncing ${result.blueReport.fixesApplied.length} fix(es) from ${result.plan.targetComponent}...\n` });
      await syncFixesBack(result.sandboxPath, config.targetPath, result.blueReport.fixesApplied);
    }

    // E. Update coverage from all results
    for (const result of results) {
      if (result.blueReport && result.redResult && result.mission) {
        updateCoverage(coverage, result.blueReport, result.redResult, iteration, result.mission.objective);
      }
    }

    // F. Cleanup N sandboxes in parallel
    await Promise.all(
      contexts.map((ctx) => cleanupSandbox(ctx.sandboxPath)),
    );

    // G. Re-queue failed components (no blue report = failed)
    for (const result of results) {
      if (!result.blueReport) {
        // Re-queue if it failed entirely
        const plan = planMap.get(result.plan.targetComponent);
        if (plan) {
          queue.push(plan);
          debug(`unit-orchestrator: re-queued ${result.plan.targetComponent}`);
        }
      }
    }

    // H. Print batch summary + check early exit
    ui.emit({ type: "unit-batch-complete", iteration, results, coverage });

    if (userSelectedSet.size > 0) {
      const stats = getCoverageStats(coverage, userSelectedSet);
      if (stats.covered === stats.total && stats.total > 0) {
        ui.emit({ type: "status", message: "  Selected components — all pass! Stopping early.\n" });
        break;
      }
    }
  }

  // Final summary
  if (coverage.rounds.length > 0) {
    ui.emit({ type: "final-summary", coverage });
  }
  debug(`unit-orchestrator: total runtime [${totalElapsed()}]`);
}

// ─── Sequential Mode (Backward Compatible) ──────────────────────────────────

async function runUnitTenetSequential(
  config: TenetConfig,
  abortController: AbortController,
  ui: TenetUI,
): Promise<void> {
  setVerbose(config.verbose);
  const totalElapsed = startTimer();

  // Step 1: Scan
  ui.emit({ type: "status", message: "  Scanning target project...\n", spinner: true });
  const inventory = await scanProject(config.targetPath);
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

  // Filter out MCP servers for unit testing
  const testableComponents = inventory.components.filter(
    (c) => c.type !== "mcp_server",
  );

  if (testableComponents.length === 0) {
    ui.emit({ type: "status", message: "  No testable components found (MCP servers are skipped in unit test mode).\n" });
    return;
  }

  // Step 2: User priority selection
  const userSelected = await ui.multiSelect({
    title: "Select components to unit test (or Enter for all):",
    hint: "↑/↓ navigate · Space toggle · Enter confirm · Esc use default priority",
    items: testableComponents.map((c) => ({
      label: `[${c.type}] ${c.id.replace(/^[^:]+:/, "")}`,
      value: c.id,
    })),
  });

  const userSelectedSet = new Set(userSelected);
  const remaining = testableComponents
    .filter((c) => !userSelectedSet.has(c.id))
    .sort((a, b) => DEFAULT_TYPE_PRIORITY[b.type] - DEFAULT_TYPE_PRIORITY[a.type])
    .map((c) => c.id);
  const priorityComponents = [...userSelected, ...remaining];

  // Step 3: LLM ownership analysis
  ui.emit({ type: "status", message: "  Analyzing component ownership...\n", spinner: true });
  const ownershipTimer = startTimer();
  const ownershipResult = await analyzeOwnership(
    inventory,
    config.targetPath,
    abortController,
  );
  debug(`unit-orchestrator: ownership analysis done [${ownershipTimer()}] — ${ownershipResult.assignments.length} assignments`);

  if (abortController.signal.aborted) return;

  // Build test plans
  const allPlans = buildUnitTestPlans(inventory, ownershipResult);

  // Order plans by user priority
  const planMap = new Map(allPlans.map((p) => [p.targetComponent, p]));
  const orderedPlans: UnitTestPlan[] = [];
  for (const compId of priorityComponents) {
    const plan = planMap.get(compId);
    if (plan) orderedPlans.push(plan);
  }

  ui.emit({ type: "status", message: `  ${orderedPlans.length} unit test plans ready.\n` });

  // Initialize coverage
  const coverage = initCoverage(inventory);

  // Dry run
  if (config.dryRun) {
    const firstPlan = orderedPlans[0];
    if (!firstPlan) {
      ui.emit({ type: "status", message: "  No plans to show.\n" });
      return;
    }
    ui.emit({ type: "status", message: "  Generating unit test mission (dry run)...\n", spinner: true });
    const mission = await generateUnitMission(
      firstPlan,
      inventory,
      coverage,
      1,
      config.rounds,
      config.maxExchanges,
      abortController,
      config.targetPath,
    );
    ui.emit({ type: "dry-run-mission", mission });

    ui.emit({ type: "ownership-assignments", assignments: ownershipResult.assignments });
    return;
  }

  // Step 4: Run unit tests per component
  for (const plan of orderedPlans) {
    if (abortController.signal.aborted) break;

    ui.emit({ type: "status", message: `\n  ═══ Unit Testing: ${plan.targetComponent} ═══\n` });
    debug(`unit-orchestrator: testing ${plan.targetComponent} — setup=${plan.setupType}, owner=${plan.systemPromptSource}`);

    // Create sandbox
    let sandboxPath: string;
    try {
      sandboxPath = await createSandbox(config.targetPath);
      plan.sandboxPath = sandboxPath;
      await populateSandbox(sandboxPath, config.targetPath, plan, inventory);
    } catch (err) {
      ui.emit({ type: "error", context: `Failed to create sandbox for ${plan.targetComponent}`, error: err });
      continue;
    }

    // Load custom system prompt for focus setups
    let customSystemPrompt: string | undefined;
    if (plan.setupType === "focus") {
      const ownerComp = inventory.components.find(
        (c) => c.id === plan.systemPromptSource,
      );
      customSystemPrompt = loadSystemPrompt(ownerComp, config.targetPath);
    }

    try {
      // Run rounds for this component
      for (let round = 1; round <= config.rounds; round++) {
        if (abortController.signal.aborted) break;

        // Check if already covered
        const compStatus = coverage.components[plan.targetComponent];
        if (compStatus?.covered && round > 1) {
          debug(`unit-orchestrator: ${plan.targetComponent} already covered, skipping round ${round}`);
          break;
        }

        // Generate unit mission
        ui.emit({ type: "status", message: `  Round ${round}/${config.rounds} — generating mission...\n`, spinner: true });
        const missionTimer = startTimer();
        const mission = await generateUnitMission(
          plan,
          inventory,
          coverage,
          round,
          config.rounds,
          config.maxExchanges,
          abortController,
          config.targetPath,
        );
        debug(`unit-orchestrator: mission generated [${missionTimer()}]`);

        if (abortController.signal.aborted) break;
        ui.emit({ type: "round-start", round, totalRounds: config.rounds, mission });

        // Red team (against sandbox)
        ui.emit({ type: "status", message: "  Running red team (sandbox)...\n", spinner: true });
        const redTimer = startTimer();
        let redResult;
        try {
          redResult = await runRedTeam(
            mission,
            sandboxPath,
            config.maxExchanges,
            abortController,
            inventory.plugins,
            customSystemPrompt,
          );
          debug(`unit-orchestrator: red team done [${redTimer()}]`);
          ui.emit({ type: "red-team-result", result: redResult });
        } catch (err) {
          ui.emit({ type: "error", context: "Red team failed", error: err });
          continue;
        }

        if (abortController.signal.aborted) break;

        // Blue team (analyzes sandbox session, fixes in sandbox)
        ui.emit({ type: "status", message: "  Running blue team...\n", spinner: true });
        const blueTimer = startTimer();
        let blueReport;
        try {
          blueReport = await runBlueTeam(
            redResult,
            mission,
            inventory,
            sandboxPath,
            abortController,
            inventory.plugins,
          );
          debug(`unit-orchestrator: blue team done [${blueTimer()}]`);
          ui.emit({ type: "blue-team-result", report: blueReport });
        } catch (err) {
          ui.emit({ type: "error", context: "Blue team failed", error: err });
          continue;
        }

        if (abortController.signal.aborted) break;

        // Sync fixes back to original project
        if (blueReport.fixesApplied.length > 0) {
          ui.emit({ type: "status", message: `  Syncing ${blueReport.fixesApplied.length} fix(es) back to project...\n` });
          await syncFixesBack(sandboxPath, config.targetPath, blueReport.fixesApplied);
        }

        // Update coverage
        updateCoverage(coverage, blueReport, redResult, round, mission.objective);

        ui.emit({
          type: "round-complete",
          round,
          totalRounds: config.rounds,
          mission,
          redResult,
          blueReport,
          coverage,
          inventory,
        });
      }
    } finally {
      // Cleanup sandbox
      await cleanupSandbox(sandboxPath);
    }

    // Early exit: if user selected specific components and they all pass, stop
    if (userSelectedSet.size > 0) {
      const stats = getCoverageStats(coverage, userSelectedSet);
      if (stats.covered === stats.total && stats.total > 0) {
        ui.emit({ type: "status", message: "  Selected components — all pass! Stopping early.\n" });
        break;
      }
    }
  }

  // Final summary
  if (coverage.rounds.length > 0) {
    ui.emit({ type: "final-summary", coverage });
  }
  debug(`unit-orchestrator: total runtime [${totalElapsed()}]`);
}
