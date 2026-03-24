import type {
  BlueTeamReport,
  ComponentStatus,
  CoverageState,
  CoverageStatus,
  Inventory,
  RedTeamResult,
  RoundSummary,
  TaskResult,
} from "../types.ts";

export function initCoverage(inventory: Inventory): CoverageState {
  const components: Record<string, CoverageStatus> = {};
  for (const c of inventory.components) {
    components[c.id] = {
      status: "untested",
      issueCount: 0,
      fixCount: 0,
      covered: false,
    };
  }
  return { components, iterations: [], rounds: [] };
}

/**
 * Update coverage from a single blue team report (used by both integration and unit modes).
 */
export function updateCoverage(
  coverage: CoverageState,
  blueReport: BlueTeamReport,
  redResult: RedTeamResult,
  round: number,
  missionObjective: string,
): void {
  updateCoverageFromReport(coverage, blueReport, round);

  // Count fixes per component (from fixesApplied for backward compat)
  for (const fix of blueReport.fixesApplied) {
    const issue = blueReport.issuesFound.find(
      (i) => i.issueId === fix.issueId,
    );
    if (!issue) continue;

    let matched = false;
    for (const ct of blueReport.componentsTested) {
      if (issue.rootCauseFile && issue.rootCauseFile.includes(ct.componentId.split(":")[1] || "")) {
        const status = coverage.components[ct.componentId];
        if (status) {
          status.fixCount++;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      for (const [compId, status] of Object.entries(coverage.components)) {
        const comp = blueReport.componentsTested.find(
          (ct) => ct.componentId === compId,
        );
        if (comp && fix.filePath && fix.filePath.includes(compId.split(":")[1] || "")) {
          status.fixCount++;
          break;
        }
      }
    }
  }

  // Record round summary (backward compat)
  const summary: RoundSummary = {
    round,
    missionId: blueReport.missionId,
    missionObjective,
    redResult,
    blueReport,
    timestamp: new Date().toISOString(),
  };
  coverage.rounds.push(summary);
}

/**
 * Update component statuses from a single blue team report.
 * Used by both single-report updateCoverage and batch updateCoverageFromResults.
 */
function updateCoverageFromReport(
  coverage: CoverageState,
  blueReport: BlueTeamReport,
  iteration: number,
): void {
  for (const ct of blueReport.componentsTested) {
    const status = coverage.components[ct.componentId];
    if (!status) {
      // Component not in inventory, add it
      const isPass = ct.wasInvoked && ct.behaviorCorrect;
      coverage.components[ct.componentId] = {
        status: isPass ? "pass" : ct.wasInvoked ? "fail" : "untested",
        statusUpdatedInIteration: iteration,
        issueCount: ct.wasInvoked && !ct.behaviorCorrect ? 1 : 0,
        fixCount: 0,
        covered: isPass,
        coveredInRound: isPass ? iteration : undefined,
      };
      continue;
    }

    if (ct.wasInvoked && ct.behaviorCorrect) {
      // Mark as proceed (mission planner decides pass vs proceed)
      if (status.status !== "pass") {
        status.status = "proceed";
        status.statusUpdatedInIteration = iteration;
      }
      status.covered = true;
      status.coveredInRound = status.coveredInRound ?? iteration;
    } else if (ct.wasInvoked && !ct.behaviorCorrect) {
      status.status = "fail";
      status.statusUpdatedInIteration = iteration;
      status.issueCount++;
      status.covered = false;
    }
  }
}

/**
 * Update coverage from multiple task results (integration mode with workers).
 */
export function updateCoverageFromResults(
  coverage: CoverageState,
  results: TaskResult[],
  iteration: number,
): void {
  for (const result of results) {
    if (result.blueReport) {
      updateCoverageFromReport(coverage, result.blueReport, iteration);
    }
  }
}

/**
 * Apply status updates from the mission planner (e.g., promote proceed → pass).
 */
export function applyStatusUpdates(
  coverage: CoverageState,
  updates: Array<{ componentId: string; newStatus: ComponentStatus; reason: string }>,
  iteration: number,
): void {
  for (const update of updates) {
    const status = coverage.components[update.componentId];
    if (!status) continue;
    status.status = update.newStatus;
    status.statusUpdatedInIteration = iteration;
    status.covered = update.newStatus === "pass";
    if (update.newStatus === "pass" && !status.coveredInRound) {
      status.coveredInRound = iteration;
    }
  }
}

export function getCoverageStats(
  coverage: CoverageState,
  scopeIds?: Set<string>,
): { total: number; covered: number; percentage: number; passed: number; failed: number; proceed: number; untested: number } {
  const entries = scopeIds
    ? Object.entries(coverage.components).filter(([id]) => scopeIds.has(id))
    : Object.entries(coverage.components);
  const total = entries.length;
  const passed = entries.filter(([, c]) => c.status === "pass").length;
  const failed = entries.filter(([, c]) => c.status === "fail").length;
  const proceed = entries.filter(([, c]) => c.status === "proceed").length;
  const untested = entries.filter(([, c]) => c.status === "untested").length;
  // covered = pass (for backward compat)
  const covered = passed;
  const percentage = total > 0 ? Math.round((passed / total) * 100) : 0;
  return { total, covered, percentage, passed, failed, proceed, untested };
}

/**
 * Check if all components in scope have reached "pass" status.
 */
export function isFullyPassed(
  coverage: CoverageState,
  scopeIds?: Set<string>,
): boolean {
  const stats = getCoverageStats(coverage, scopeIds);
  return stats.passed === stats.total && stats.total > 0;
}
