import type {
  BlueTeamReport,
  CoverageState,
  CoverageStatus,
  Inventory,
  RedTeamResult,
  RoundSummary,
} from "../types.ts";

export function initCoverage(inventory: Inventory): CoverageState {
  const components: Record<string, CoverageStatus> = {};
  for (const c of inventory.components) {
    components[c.id] = {
      covered: false,
      issueCount: 0,
      fixCount: 0,
    };
  }
  return { components, rounds: [] };
}

export function updateCoverage(
  coverage: CoverageState,
  blueReport: BlueTeamReport,
  redResult: RedTeamResult,
  round: number,
): void {
  // Update component coverage from blue team report
  for (const ct of blueReport.componentsTested) {
    const status = coverage.components[ct.componentId];
    if (!status) {
      // Component not in inventory, add it
      coverage.components[ct.componentId] = {
        covered: ct.wasInvoked && ct.behaviorCorrect,
        coveredInRound: ct.wasInvoked && ct.behaviorCorrect ? round : undefined,
        issueCount: ct.wasInvoked && !ct.behaviorCorrect ? 1 : 0,
        fixCount: 0,
      };
      continue;
    }

    if (ct.wasInvoked && ct.behaviorCorrect) {
      status.covered = true;
      status.coveredInRound = status.coveredInRound ?? round;
    } else if (ct.wasInvoked && !ct.behaviorCorrect) {
      status.issueCount++;
      // Reset coverage if behavior was incorrect (needs retest)
      status.covered = false;
    }
  }

  // Count fixes per component by matching fix → issue → rootCauseFile → component
  for (const fix of blueReport.fixesApplied) {
    const issue = blueReport.issuesFound.find(
      (i) => i.issueId === fix.issueId,
    );
    if (!issue) continue;

    // Find the component whose filePath matches the issue's rootCauseFile
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
    // Fallback: match by fix filePath against component filePath
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

  // Record round summary
  const summary: RoundSummary = {
    round,
    missionId: blueReport.missionId,
    redResult,
    blueReport,
    timestamp: new Date().toISOString(),
  };
  coverage.rounds.push(summary);
}

export function getCoverageStats(
  coverage: CoverageState,
): { total: number; covered: number; percentage: number } {
  const total = Object.keys(coverage.components).length;
  const covered = Object.values(coverage.components).filter(
    (c) => c.covered,
  ).length;
  const percentage = total > 0 ? Math.round((covered / total) * 100) : 0;
  return { total, covered, percentage };
}
