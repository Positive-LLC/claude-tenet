import type { TenetConfig } from "../types.ts";
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
} from "../utils/logger.ts";

export async function runTenet(
  config: TenetConfig,
  abortController: AbortController,
): Promise<void> {
  // Step 1: Initial scan
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
    const mission = await generateMission(
      currentInventory,
      coverage,
      round,
      config.rounds,
      config.maxExchanges,
      abortController,
    );

    if (abortController.signal.aborted) break;
    printRoundStart(round, config.rounds, mission);

    // Red team
    console.log("  Running red team...\n");
    let redResult;
    try {
      redResult = await runRedTeam(
        mission,
        config.targetPath,
        config.maxExchanges,
        abortController,
      );
      printRedTeamResult(redResult);
    } catch (err) {
      printError("Red team failed", err);
      continue;
    }

    if (abortController.signal.aborted) break;

    // Blue team
    console.log("  Running blue team...\n");
    let blueReport;
    try {
      blueReport = await runBlueTeam(
        redResult,
        mission,
        currentInventory,
        config.targetPath,
        abortController,
      );
      printBlueTeamResult(blueReport);
    } catch (err) {
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
}
