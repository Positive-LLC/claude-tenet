import type { TenetConfig, UnitTestPlan } from "../types.ts";
import { DEFAULT_TYPE_PRIORITY } from "../types.ts";
import { scanProject } from "./scanner.ts";
import { generateUnitMission } from "./mission.ts";
import { analyzeOwnership, buildUnitTestPlans } from "./ownership.ts";
import { createSandbox, populateSandbox, cleanupSandbox, syncFixesBack } from "./sandbox.ts";
import { initCoverage, updateCoverage, getCoverageStats } from "./coverage.ts";
import { runRedTeam } from "../red/red-team.ts";
import { runBlueTeam } from "../blue/blue-team.ts";
import { resolve, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  printScanResult,
  printRoundStart,
  printRedTeamResult,
  printBlueTeamResult,
  printRoundComplete,
  printFinalSummary,
  printDryRunMission,
  printError,
  debug,
  startTimer,
  setVerbose,
} from "../utils/logger.ts";
import { multiSelect } from "../utils/multiselect.ts";

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

export async function runUnitTenet(
  config: TenetConfig,
  abortController: AbortController,
): Promise<void> {
  setVerbose(config.verbose);
  const totalElapsed = startTimer();

  // Step 1: Scan
  console.log("  Scanning target project...\n");
  const inventory = await scanProject(config.targetPath);
  printScanResult(inventory);

  if (inventory.components.length === 0) {
    console.log(
      "  No components found. Is this a Claude agent project?\n" +
        "  Expected: CLAUDE.md, .claude/skills/, .claude/commands/, etc.\n",
    );
    return;
  }

  // Filter out MCP servers for unit testing
  const testableComponents = inventory.components.filter(
    (c) => c.type !== "mcp_server",
  );

  if (testableComponents.length === 0) {
    console.log("  No testable components found (MCP servers are skipped in unit test mode).\n");
    return;
  }

  // Step 2: User priority selection
  const userSelected = await multiSelect({
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
  console.log("  Analyzing component ownership...\n");
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

  console.log(`  ${orderedPlans.length} unit test plans ready.\n`);

  // Initialize coverage
  const coverage = initCoverage(inventory);

  // Dry run
  if (config.dryRun) {
    const firstPlan = orderedPlans[0];
    if (!firstPlan) {
      console.log("  No plans to show.\n");
      return;
    }
    console.log("  Generating unit test mission (dry run)...\n");
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
    printDryRunMission(mission);

    console.log("\n  Ownership assignments:");
    for (const a of ownershipResult.assignments) {
      console.log(`    ${a.componentId} → owner: ${a.ownerComponentId} (${a.reasoning.slice(0, 60)})`);
    }
    console.log();
    return;
  }

  // Step 4: Run unit tests per component
  for (const plan of orderedPlans) {
    if (abortController.signal.aborted) break;

    console.log(`\n  ═══ Unit Testing: ${plan.targetComponent} ═══\n`);
    debug(`unit-orchestrator: testing ${plan.targetComponent} — setup=${plan.setupType}, owner=${plan.systemPromptSource}`);

    // Create sandbox
    let sandboxPath: string;
    try {
      sandboxPath = await createSandbox(config.targetPath);
      plan.sandboxPath = sandboxPath;
      await populateSandbox(sandboxPath, config.targetPath, plan, inventory);
    } catch (err) {
      printError(`Failed to create sandbox for ${plan.targetComponent}`, err);
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
        console.log(`  Round ${round}/${config.rounds} — generating mission...\n`);
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
        printRoundStart(round, config.rounds, mission);

        // Red team (against sandbox)
        console.log("  Running red team (sandbox)...\n");
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
          printRedTeamResult(redResult);
        } catch (err) {
          printError("Red team failed", err);
          continue;
        }

        if (abortController.signal.aborted) break;

        // Blue team (analyzes sandbox session, fixes in sandbox)
        console.log("  Running blue team...\n");
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
          printBlueTeamResult(blueReport);
        } catch (err) {
          printError("Blue team failed", err);
          continue;
        }

        if (abortController.signal.aborted) break;

        // Sync fixes back to original project
        if (blueReport.fixesApplied.length > 0) {
          console.log(`  Syncing ${blueReport.fixesApplied.length} fix(es) back to project...\n`);
          await syncFixesBack(sandboxPath, config.targetPath, blueReport.fixesApplied);
        }

        // Update coverage
        updateCoverage(coverage, blueReport, redResult, round, mission.objective);

        printRoundComplete(
          round,
          config.rounds,
          mission,
          redResult,
          blueReport,
          coverage,
          inventory,
        );
      }
    } finally {
      // Cleanup sandbox
      await cleanupSandbox(sandboxPath);
    }

    // Early exit: if user selected specific components and they all pass, stop
    if (userSelectedSet.size > 0) {
      const stats = getCoverageStats(coverage, userSelectedSet);
      if (stats.covered === stats.total && stats.total > 0) {
        console.log("  Selected components — all pass! Stopping early.\n");
        break;
      }
    }
  }

  // Final summary
  if (coverage.rounds.length > 0) {
    printFinalSummary(coverage);
  }
  debug(`unit-orchestrator: total runtime [${totalElapsed()}]`);
}
