import type {
  BlueTeamReport,
  CoverageState,
  Inventory,
  Mission,
  RedTeamResult,
  RoundSummary,
} from "../types.ts";

const SEPARATOR = "\u2550".repeat(47);

// ─── Verbose / Debug Logging ─────────────────────────────────────────────────

let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

/** Print a debug line only when --verbose is active. Prefixed with timestamp. */
export function debug(message: string): void {
  if (!_verbose) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`  [DEBUG ${ts}] ${message}`);
}

/** Return a timer function — call it to get elapsed ms string. */
export function startTimer(): () => string {
  const t0 = performance.now();
  return () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

export function printBanner(): void {
  console.log(`
${SEPARATOR}
  TENET — Adversarial Agent Testing Framework
${SEPARATOR}
`);
}

export function printScanResult(inventory: Inventory): void {
  console.log(`  Scanned: ${inventory.projectPath}`);
  console.log(`  Components found: ${inventory.components.length}\n`);
}

export function printRoundStart(
  round: number,
  totalRounds: number,
  mission: Mission,
): void {
  console.log(SEPARATOR);
  console.log(`  TENET \u2014 Round ${round}/${totalRounds} Starting`);
  console.log(SEPARATOR);
  console.log();
  console.log(`  Mission: ${mission.objective}`);
  console.log(`  Persona: ${mission.persona}`);
  console.log(
    `  Targets: ${mission.targetComponents.join(", ")}`,
  );
  console.log();
}

export function printRedTeamResult(result: RedTeamResult): void {
  console.log(
    `  Red Team: ${result.conversationTurns} exchanges, ${(result.durationMs / 1000).toFixed(1)}s, $${result.costUsd.toFixed(2)}`,
  );
}

export function printBlueTeamResult(report: BlueTeamReport): void {
  console.log(
    `  Blue Team: ${report.conversationSummary.totalToolCalls} tool calls`,
  );
}

export function printRoundComplete(
  round: number,
  totalRounds: number,
  mission: Mission,
  redResult: RedTeamResult,
  blueReport: BlueTeamReport,
  coverage: CoverageState,
  _inventory: Inventory,
): void {
  const totalComponents = Object.keys(coverage.components).length;
  const coveredCount = Object.values(coverage.components).filter(
    (c) => c.covered,
  ).length;
  const pct = totalComponents > 0
    ? Math.round((coveredCount / totalComponents) * 100)
    : 0;

  const roundCost = redResult.costUsd;
  const totalCost = coverage.rounds.reduce(
    (sum, r) => sum + r.redResult.costUsd,
    0,
  );

  console.log();
  console.log(SEPARATOR);
  console.log(`  TENET \u2014 Round ${round}/${totalRounds} Complete`);
  console.log(SEPARATOR);
  console.log();
  console.log(`  Mission: ${mission.objective}`);
  console.log(`  Persona: ${mission.persona}`);
  console.log();
  console.log(
    `  Red Team: ${redResult.conversationTurns} exchanges, ${(redResult.durationMs / 1000).toFixed(1)}s, $${redResult.costUsd.toFixed(2)}`,
  );
  console.log(
    `  Blue Team: ${blueReport.conversationSummary.totalToolCalls} tool calls`,
  );
  console.log();

  // Components tested this round
  console.log(`  Components Tested: ${blueReport.componentsTested.length}`);
  for (const ct of blueReport.componentsTested) {
    if (ct.wasInvoked && ct.behaviorCorrect) {
      console.log(`    \u2713 ${ct.componentId} \u2014 OK`);
    } else if (ct.wasInvoked && !ct.behaviorCorrect) {
      console.log(
        `    \u2717 ${ct.componentId} \u2014 issue found`,
      );
    } else {
      console.log(`    - ${ct.componentId} \u2014 not triggered`);
    }
  }
  console.log();

  // Issues
  if (blueReport.issuesFound.length > 0) {
    console.log(`  Issues Found: ${blueReport.issuesFound.length}`);
    for (const issue of blueReport.issuesFound) {
      console.log(
        `    [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.description}`,
      );
      console.log();
    }
    console.log();
  }

  // Fixes
  if (blueReport.fixesApplied.length > 0) {
    console.log(`  Fixes Applied: ${blueReport.fixesApplied.length}`);
    for (const fix of blueReport.fixesApplied) {
      console.log(
        `    ${fix.changeType === "modified" ? "Modified" : "Created"}: ${fix.filePath} \u2014 ${fix.description}`,
      );
      console.log();
    }
  }

  console.log(
    `  Coverage: ${coveredCount}/${totalComponents} components (${pct}%)`,
  );
  console.log(
    `  Round Cost: $${roundCost.toFixed(2)} | Total Cost: $${totalCost.toFixed(2)}`,
  );
  console.log(SEPARATOR);
  console.log();
}

export function printFinalSummary(coverage: CoverageState): void {
  const totalComponents = Object.keys(coverage.components).length;
  const coveredCount = Object.values(coverage.components).filter(
    (c) => c.covered,
  ).length;
  const pct = totalComponents > 0
    ? Math.round((coveredCount / totalComponents) * 100)
    : 0;

  const totalIssues = coverage.rounds.reduce(
    (sum, r) => sum + r.blueReport.issuesFound.length,
    0,
  );
  const totalFixes = coverage.rounds.reduce(
    (sum, r) => sum + r.blueReport.fixesApplied.length,
    0,
  );
  const totalCost = coverage.rounds.reduce(
    (sum, r) => sum + r.redResult.costUsd,
    0,
  );

  console.log(SEPARATOR);
  console.log(`  TENET \u2014 Final Summary`);
  console.log(SEPARATOR);
  console.log();
  console.log(`  Rounds Completed: ${coverage.rounds.length}`);
  console.log(
    `  Coverage: ${coveredCount}/${totalComponents} components (${pct}%)`,
  );
  console.log(`  Total Issues Found: ${totalIssues}`);
  console.log(`  Total Fixes Applied: ${totalFixes}`);
  console.log(`  Total Cost: $${totalCost.toFixed(2)}`);
  console.log();

  // Per-component breakdown
  console.log(`  Component Status:`);
  for (const [id, status] of Object.entries(coverage.components)) {
    const icon = status.covered ? "\u2713" : "\u2717";
    const round = status.coveredInRound
      ? ` (round ${status.coveredInRound})`
      : "";
    const issues = status.issueCount > 0
      ? `, ${status.issueCount} issues`
      : "";
    const fixes = status.fixCount > 0 ? `, ${status.fixCount} fixes` : "";
    console.log(`    ${icon} ${id}${round}${issues}${fixes}`);
  }
  console.log();
  console.log(SEPARATOR);
}

export function printDryRunMission(mission: Mission): void {
  console.log(`  [DRY RUN] Generated mission:`);
  console.log();
  console.log(`  Mission ID: ${mission.missionId}`);
  console.log(`  Objective: ${mission.objective}`);
  console.log(`  Persona: ${mission.persona}`);
  console.log(`  Target Components: ${mission.targetComponents.join(", ")}`);
  console.log(`  Estimated Turns: ${mission.estimatedTurns}`);
  console.log();
  console.log(`  Conversation Starters:`);
  for (const s of mission.conversationStarters) {
    console.log(`    - ${s}`);
  }
  console.log();
  console.log(`  Edge Cases to Probe:`);
  for (const e of mission.edgeCasesToProbe) {
    console.log(`    - ${e}`);
  }
  console.log();
  console.log(`  Success Criteria:`);
  for (const c of mission.successCriteria) {
    console.log(`    - ${c}`);
  }
  console.log();
}

export function printError(context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`  [ERROR] ${context}: ${msg}`);
}

export function printWarning(message: string): void {
  console.log(`  [WARN] ${message}`);
}

export function printVerboseSession(sessionSummary: string): void {
  console.log();
  console.log(`  ── Session Transcript ──`);
  console.log(sessionSummary);
  console.log(`  ── End Transcript ──`);
  console.log();
}
