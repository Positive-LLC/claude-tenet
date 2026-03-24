import type {
  BlueTeamReport,
  CoverageState,
  Inventory,
  Mission,
  ProposedFix,
  RedTeamResult,
  RoundSummary,
  TaskResult,
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
        `    • [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.description}`,
      );
    }
    console.log();
  }

  // Fixes
  if (blueReport.fixesApplied.length > 0) {
    console.log(`  Fixes Applied: ${blueReport.fixesApplied.length}`);
    for (const fix of blueReport.fixesApplied) {
      console.log(
        `    • ${fix.changeType === "modified" ? "Modified" : "Created"}: ${fix.filePath} \u2014 ${fix.description}`,
      );
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

// ─── Iteration-Based Reporting (Multi-Worker) ──────────────────────────────

export function printIterationStart(
  iteration: number,
  totalIterations: number,
  missions: Mission[],
  workerCount: number,
): void {
  console.log(SEPARATOR);
  console.log(`  TENET \u2014 Iteration ${iteration}/${totalIterations} (${workerCount} worker${workerCount > 1 ? "s" : ""})`);
  console.log(SEPARATOR);
  console.log();
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    console.log(`  Worker ${i + 1}: ${m.objective}`);
    console.log(`    Persona: ${m.persona}`);
    console.log(`    Targets: ${m.targetComponents.join(", ")}`);
    console.log();
  }
}

export function printWorkerResult(
  workerId: number,
  result: TaskResult,
): void {
  if (result.redResult) {
    console.log(
      `  Worker ${workerId}: Red ${result.redResult.conversationTurns} exchanges, ${(result.redResult.durationMs / 1000).toFixed(1)}s, $${result.redResult.costUsd.toFixed(2)}`,
    );
  } else {
    console.log(`  Worker ${workerId}: Red team failed`);
  }
  if (result.blueReport) {
    const issues = result.blueReport.issuesFound.length;
    const fixes = result.blueReport.proposedFixes?.length ?? 0;
    console.log(
      `  Worker ${workerId}: Blue ${result.blueReport.conversationSummary.totalToolCalls} tool calls, ${issues} issues, ${fixes} proposed fixes`,
    );
  } else {
    console.log(`  Worker ${workerId}: Blue team failed`);
  }
}

export function printFixPhaseResult(
  appliedCount: number,
  totalProposed: number,
): void {
  if (totalProposed === 0) {
    console.log(`  Fix Phase: No fixes proposed`);
  } else {
    console.log(`  Fix Phase: Applied ${appliedCount} of ${totalProposed} proposed fixes`);
  }
}

export function printIterationComplete(
  iteration: number,
  totalIterations: number,
  results: TaskResult[],
  coverage: CoverageState,
  fixesApplied: number,
): void {
  const totalComponents = Object.keys(coverage.components).length;
  const passed = Object.values(coverage.components).filter((c) => c.status === "pass").length;
  const failed = Object.values(coverage.components).filter((c) => c.status === "fail").length;
  const proceed = Object.values(coverage.components).filter((c) => c.status === "proceed").length;
  const pct = totalComponents > 0 ? Math.round((passed / totalComponents) * 100) : 0;

  const iterCost = results.reduce((sum, r) => sum + (r.redResult?.costUsd ?? 0), 0);
  const totalCost = coverage.rounds.reduce((sum, r) => sum + r.redResult.costUsd, 0)
    + coverage.iterations.reduce((sum, it) =>
      sum + it.taskResults.reduce((s, r) => s + (r.redResult?.costUsd ?? 0), 0), 0);

  console.log();
  console.log(SEPARATOR);
  console.log(`  TENET \u2014 Iteration ${iteration}/${totalIterations} Complete`);
  console.log(SEPARATOR);
  console.log();

  // Components tested across all workers
  const allTested = new Map<string, { invoked: boolean; correct: boolean }>();
  for (const r of results) {
    if (!r.blueReport) continue;
    for (const ct of r.blueReport.componentsTested) {
      const existing = allTested.get(ct.componentId);
      if (!existing || (ct.wasInvoked && !existing.invoked)) {
        allTested.set(ct.componentId, { invoked: ct.wasInvoked, correct: ct.behaviorCorrect });
      }
    }
  }

  console.log(`  Components Tested: ${allTested.size}`);
  for (const [id, { invoked, correct }] of allTested) {
    if (invoked && correct) {
      console.log(`    \u2713 ${id} \u2014 OK`);
    } else if (invoked && !correct) {
      console.log(`    \u2717 ${id} \u2014 issue found`);
    } else {
      console.log(`    - ${id} \u2014 not triggered`);
    }
  }
  console.log();

  // Issues across all workers
  const allIssues = results.flatMap((r) => r.blueReport?.issuesFound ?? []);
  if (allIssues.length > 0) {
    console.log(`  Issues Found: ${allIssues.length}`);
    for (const issue of allIssues) {
      console.log(`    \u2022 [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.description}`);
    }
    console.log();
  }

  if (fixesApplied > 0) {
    console.log(`  Fixes Applied: ${fixesApplied}`);
    console.log();
  }

  console.log(`  Status: ${passed} pass, ${proceed} proceed, ${failed} fail, ${totalComponents - passed - proceed - failed} untested (${pct}% complete)`);
  console.log(`  Iteration Cost: $${iterCost.toFixed(2)} | Total Cost: $${totalCost.toFixed(2)}`);
  console.log(SEPARATOR);
  console.log();
}

export function printFinalSummaryV2(coverage: CoverageState): void {
  const totalComponents = Object.keys(coverage.components).length;
  const passed = Object.values(coverage.components).filter((c) => c.status === "pass").length;
  const pct = totalComponents > 0 ? Math.round((passed / totalComponents) * 100) : 0;

  const totalIssues = [
    ...coverage.rounds.flatMap((r) => r.blueReport.issuesFound),
    ...coverage.iterations.flatMap((it) => it.taskResults.flatMap((r) => r.blueReport?.issuesFound ?? [])),
  ].length;

  const totalFixesApplied = coverage.iterations.reduce((sum, it) => sum + it.fixesAppliedCount, 0)
    + coverage.rounds.reduce((sum, r) => sum + r.blueReport.fixesApplied.length, 0);

  const totalCost = coverage.rounds.reduce((sum, r) => sum + r.redResult.costUsd, 0)
    + coverage.iterations.reduce((sum, it) =>
      sum + it.taskResults.reduce((s, r) => s + (r.redResult?.costUsd ?? 0), 0), 0);

  const totalRounds = coverage.iterations.length + coverage.rounds.length;

  console.log(SEPARATOR);
  console.log(`  TENET \u2014 Final Summary`);
  console.log(SEPARATOR);
  console.log();
  console.log(`  Iterations Completed: ${totalRounds}`);
  console.log(`  Coverage: ${passed}/${totalComponents} components pass (${pct}%)`);
  console.log(`  Total Issues Found: ${totalIssues}`);
  console.log(`  Total Fixes Applied: ${totalFixesApplied}`);
  console.log(`  Total Cost: $${totalCost.toFixed(2)}`);
  console.log();

  console.log(`  Component Status:`);
  for (const [id, status] of Object.entries(coverage.components)) {
    const icon = status.status === "pass" ? "\u2713" : status.status === "fail" ? "\u2717" : status.status === "proceed" ? "\u279C" : "\u25CB";
    const iter = status.statusUpdatedInIteration ? ` (iter ${status.statusUpdatedInIteration})` : "";
    const issues = status.issueCount > 0 ? `, ${status.issueCount} issues` : "";
    const fixes = status.fixCount > 0 ? `, ${status.fixCount} fixes` : "";
    console.log(`    ${icon} ${id} [${status.status}]${iter}${issues}${fixes}`);
  }
  console.log();
  console.log(SEPARATOR);
}

export function printUnitBatchStart(
  iteration: number,
  componentIds: string[],
  totalRemaining: number,
): void {
  console.log(SEPARATOR);
  console.log(`  TENET Unit \u2014 Batch ${iteration} (${componentIds.length} worker${componentIds.length > 1 ? "s" : ""}, ${totalRemaining} remaining)`);
  console.log(SEPARATOR);
  console.log();
  for (let i = 0; i < componentIds.length; i++) {
    console.log(`  Worker ${i + 1}: ${componentIds[i]}`);
  }
  console.log();
}

export function printUnitBatchComplete(
  iteration: number,
  results: { plan: { targetComponent: string }; redResult?: { conversationTurns: number; durationMs: number; costUsd: number }; blueReport?: { issuesFound: { length: number }; fixesApplied: { length: number }; conversationSummary: { totalToolCalls: number } } }[],
  coverage: CoverageState,
): void {
  const totalComponents = Object.keys(coverage.components).length;
  const coveredCount = Object.values(coverage.components).filter(
    (c) => c.covered,
  ).length;
  const pct = totalComponents > 0
    ? Math.round((coveredCount / totalComponents) * 100)
    : 0;

  console.log();
  console.log(SEPARATOR);
  console.log(`  TENET Unit \u2014 Batch ${iteration} Complete`);
  console.log(SEPARATOR);
  console.log();

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const icon = r.blueReport && r.blueReport.issuesFound.length === 0 ? "\u2713" : r.blueReport ? "\u2717" : "\u25CB";
    const detail = r.redResult
      ? `${r.redResult.conversationTurns} exchanges, ${(r.redResult.durationMs / 1000).toFixed(1)}s, $${r.redResult.costUsd.toFixed(2)}`
      : "skipped";
    const issues = r.blueReport ? `, ${r.blueReport.issuesFound.length} issues, ${r.blueReport.fixesApplied.length} fixes` : "";
    console.log(`  ${icon} ${r.plan.targetComponent} \u2014 ${detail}${issues}`);
  }

  console.log();
  console.log(`  Coverage: ${coveredCount}/${totalComponents} components (${pct}%)`);
  console.log(SEPARATOR);
  console.log();
}

export function printDryRunIterationPlan(missions: Mission[]): void {
  console.log(`  [DRY RUN] Generated ${missions.length} mission${missions.length > 1 ? "s" : ""}:`);
  console.log();
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    console.log(`  ── Worker ${i + 1} ──`);
    console.log(`  Mission ID: ${m.missionId}`);
    console.log(`  Objective: ${m.objective}`);
    console.log(`  Persona: ${m.persona}`);
    console.log(`  Target Components: ${m.targetComponents.join(", ")}`);
    console.log(`  Estimated Turns: ${m.estimatedTurns}`);
    console.log();
    console.log(`  Conversation Starters:`);
    for (const s of m.conversationStarters) {
      console.log(`    - ${s}`);
    }
    console.log();
    console.log(`  Edge Cases to Probe:`);
    for (const e of m.edgeCasesToProbe) {
      console.log(`    - ${e}`);
    }
    console.log();
  }
}
