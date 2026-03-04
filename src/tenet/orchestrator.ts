import type { Inventory, TenetConfig } from "../types.ts";
import { DEFAULT_TYPE_PRIORITY } from "../types.ts";
import { scanProject } from "./scanner.ts";
import { generateMission } from "./mission.ts";
import { initCoverage, updateCoverage, getCoverageStats } from "./coverage.ts";
import { runRedTeam } from "../red/red-team.ts";
import { runBlueTeam } from "../blue/blue-team.ts";
import {
  printScanResult,
  printRoundStart,
  printRedTeamResult,
  printBlueTeamResult,
  printRoundComplete,
  printFinalSummary,
  printDryRunMission,
  printError,
  printWarning,
  debug,
  startTimer,
  setVerbose,
} from "../utils/logger.ts";
import { multiSelect } from "../utils/multiselect.ts";

export async function runTenet(
  config: TenetConfig,
  abortController: AbortController,
): Promise<void> {
  // Enable verbose logging if requested
  setVerbose(config.verbose);

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

  // Build full sorted priority list: user-selected first, then remaining by type priority
  const userSelectedSet = new Set(userSelected);
  const remaining = inventory.components
    .filter((c) => !userSelectedSet.has(c.id))
    .sort((a, b) => DEFAULT_TYPE_PRIORITY[b.type] - DEFAULT_TYPE_PRIORITY[a.type])
    .map((c) => c.id);
  const priorityComponents = [...userSelected, ...remaining];

  // Initialize coverage
  const coverage = initCoverage(inventory);

  // Dry run: just generate one mission and print it
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
    const stats = getCoverageStats(coverage);
    if (stats.covered === stats.total && stats.total > 0 && round > 1) {
      console.log("  Full coverage achieved! Stopping early.\n");
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

    // Blue team
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
    updateCoverage(coverage, blueReport, redResult, round);

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
