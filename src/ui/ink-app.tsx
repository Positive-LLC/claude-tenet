/// <reference types="npm:@types/react@18" />
import React, { useState, useEffect } from "react";
import { Box, Text, Static, useInput } from "ink";
import chalk from "chalk";
import type { UIEvent, MultiSelectOptions } from "./events.ts";

const SEPARATOR = "\u2550".repeat(47);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function severityColor(severity: string): string {
  switch (severity.toLowerCase()) {
    case "critical": return chalk.red.bold(severity.toUpperCase());
    case "high": return chalk.red(severity.toUpperCase());
    case "medium": return chalk.yellow(severity.toUpperCase());
    case "low": return chalk.dim(severity.toUpperCase());
    default: return severity.toUpperCase();
  }
}

function coverageColor(pct: number): string {
  if (pct >= 80) return chalk.green(`${pct}%`);
  if (pct >= 50) return chalk.yellow(`${pct}%`);
  return chalk.red(`${pct}%`);
}

function statusIcon(status: string): string {
  switch (status) {
    case "pass": return chalk.green("\u2713");
    case "fail": return chalk.red("\u2717");
    case "proceed": return chalk.yellow("\u279C");
    default: return chalk.dim("\u25CB");
  }
}

function sectionHeader(text: string): string {
  return [
    chalk.cyan(SEPARATOR),
    chalk.cyan.bold(`  ${text}`),
    chalk.cyan(SEPARATOR),
  ].join("\n");
}

// ─── Event Formatting ────────────────────────────────────────────────────────

function formatEvent(event: UIEvent): string {
  switch (event.type) {
    case "status":
      return event.message.replace(/\n+$/, "");

    case "scan-result":
      return [
        `  Scanned: ${chalk.bold(event.inventory.projectPath)}`,
        `  Components found: ${chalk.bold(String(event.inventory.components.length))}`,
      ].join("\n");

    case "round-start":
      return [
        sectionHeader(`TENET \u2014 Round ${event.round}/${event.totalRounds} Starting`),
        "",
        `  ${chalk.bold("Mission:")} ${event.mission.objective}`,
        `  ${chalk.bold("Persona:")} ${event.mission.persona}`,
        `  ${chalk.bold("Targets:")} ${event.mission.targetComponents.join(", ")}`,
      ].join("\n");

    case "red-team-result":
      return `  ${chalk.red.bold("Red Team:")} ${event.result.conversationTurns} exchanges, ${(event.result.durationMs / 1000).toFixed(1)}s, ${chalk.dim(`$${event.result.costUsd.toFixed(2)}`)}`;

    case "blue-team-result":
      return `  ${chalk.blue.bold("Blue Team:")} ${event.report.conversationSummary.totalToolCalls} tool calls`;

    case "round-complete": {
      const { round, totalRounds, mission, redResult, blueReport, coverage } = event;
      const totalComponents = Object.keys(coverage.components).length;
      const coveredCount = Object.values(coverage.components).filter((c) => c.covered).length;
      const pct = totalComponents > 0 ? Math.round((coveredCount / totalComponents) * 100) : 0;
      const roundCost = redResult.costUsd;
      const totalCost = coverage.rounds.reduce((sum, r) => sum + r.redResult.costUsd, 0);

      const lines = [
        "",
        sectionHeader(`TENET \u2014 Round ${round}/${totalRounds} Complete`),
        "",
        `  ${chalk.bold("Mission:")} ${mission.objective}`,
        `  ${chalk.bold("Persona:")} ${mission.persona}`,
        "",
        `  ${chalk.red.bold("Red Team:")} ${redResult.conversationTurns} exchanges, ${(redResult.durationMs / 1000).toFixed(1)}s, ${chalk.dim(`$${redResult.costUsd.toFixed(2)}`)}`,
        `  ${chalk.blue.bold("Blue Team:")} ${blueReport.conversationSummary.totalToolCalls} tool calls`,
        "",
        `  ${chalk.bold("Components Tested:")} ${blueReport.componentsTested.length}`,
      ];

      for (const ct of blueReport.componentsTested) {
        if (ct.wasInvoked && ct.behaviorCorrect) {
          lines.push(`    ${chalk.green("\u2713")} ${ct.componentId} \u2014 ${chalk.green("OK")}`);
        } else if (ct.wasInvoked && !ct.behaviorCorrect) {
          lines.push(`    ${chalk.red("\u2717")} ${ct.componentId} \u2014 ${chalk.red("issue found")}`);
        } else {
          lines.push(`    ${chalk.dim("-")} ${ct.componentId} \u2014 ${chalk.dim("not triggered")}`);
        }
      }
      lines.push("");

      if (blueReport.issuesFound.length > 0) {
        lines.push(`  ${chalk.bold("Issues Found:")} ${blueReport.issuesFound.length}`);
        for (const issue of blueReport.issuesFound) {
          lines.push(`    ${chalk.dim("\u2022")} [${severityColor(issue.severity)}] ${issue.category}: ${issue.description}`);
        }
        lines.push("");
      }

      if (blueReport.fixesApplied.length > 0) {
        lines.push(`  ${chalk.bold("Fixes Applied:")} ${blueReport.fixesApplied.length}`);
        for (const fix of blueReport.fixesApplied) {
          lines.push(`    ${chalk.dim("\u2022")} ${fix.changeType === "modified" ? "Modified" : "Created"}: ${chalk.bold(fix.filePath)} \u2014 ${fix.description}`);
        }
      }

      lines.push(`  ${chalk.bold("Coverage:")} ${coveredCount}/${totalComponents} components (${coverageColor(pct)})`);
      lines.push(`  ${chalk.dim(`Round Cost: $${roundCost.toFixed(2)} | Total Cost: $${totalCost.toFixed(2)}`)}`);
      lines.push(chalk.cyan(SEPARATOR));
      return lines.join("\n");
    }

    case "iteration-start": {
      const { iteration, totalIterations, missions, workerCount } = event;
      const lines = [
        sectionHeader(`TENET \u2014 Iteration ${iteration}/${totalIterations} (${workerCount} worker${workerCount > 1 ? "s" : ""})`),
        "",
      ];
      for (let i = 0; i < missions.length; i++) {
        const m = missions[i];
        lines.push(`  ${chalk.bold(`Worker ${i + 1}:`)} ${m.objective}`);
        lines.push(`    ${chalk.bold("Persona:")} ${m.persona}`);
        lines.push(`    ${chalk.bold("Targets:")} ${m.targetComponents.join(", ")}`);
        lines.push("");
      }
      return lines.join("\n");
    }

    case "worker-result": {
      const { workerId, result } = event;
      const lines: string[] = [];
      if (result.redResult) {
        lines.push(`  ${chalk.bold(`Worker ${workerId}:`)} ${chalk.red("Red")} ${result.redResult.conversationTurns} exchanges, ${(result.redResult.durationMs / 1000).toFixed(1)}s, ${chalk.dim(`$${result.redResult.costUsd.toFixed(2)}`)}`);
      } else {
        lines.push(`  ${chalk.bold(`Worker ${workerId}:`)} ${chalk.red("Red team failed")}`);
      }
      if (result.blueReport) {
        const issues = result.blueReport.issuesFound.length;
        const fixes = result.blueReport.proposedFixes?.length ?? 0;
        lines.push(`  ${chalk.bold(`Worker ${workerId}:`)} ${chalk.blue("Blue")} ${result.blueReport.conversationSummary.totalToolCalls} tool calls, ${issues} issues, ${fixes} proposed fixes`);
      } else {
        lines.push(`  ${chalk.bold(`Worker ${workerId}:`)} ${chalk.blue("Blue team failed")}`);
      }
      return lines.join("\n");
    }

    case "worker-phase":
      return "";

    case "fix-phase-result":
      if (event.totalProposed === 0) return `  ${chalk.bold("Fix Phase:")} ${chalk.dim("No fixes proposed")}`;
      return `  ${chalk.bold("Fix Phase:")} Applied ${chalk.green(String(event.appliedCount))} of ${event.totalProposed} proposed fixes`;

    case "iteration-complete": {
      const { iteration, totalIterations, results, coverage, fixesApplied } = event;
      const totalComponents = Object.keys(coverage.components).length;
      const passed = Object.values(coverage.components).filter((c) => c.status === "pass").length;
      const failed = Object.values(coverage.components).filter((c) => c.status === "fail").length;
      const proceed = Object.values(coverage.components).filter((c) => c.status === "proceed").length;
      const pct = totalComponents > 0 ? Math.round((passed / totalComponents) * 100) : 0;

      const iterCost = results.reduce((sum, r) => sum + (r.redResult?.costUsd ?? 0), 0);
      const totalCost = coverage.rounds.reduce((sum, r) => sum + r.redResult.costUsd, 0)
        + coverage.iterations.reduce((sum, it) =>
          sum + it.taskResults.reduce((s, r) => s + (r.redResult?.costUsd ?? 0), 0), 0);

      const lines = [
        "",
        sectionHeader(`TENET \u2014 Iteration ${iteration}/${totalIterations} Complete`),
        "",
      ];

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

      lines.push(`  ${chalk.bold("Components Tested:")} ${allTested.size}`);
      for (const [id, { invoked, correct }] of allTested) {
        if (invoked && correct) {
          lines.push(`    ${chalk.green("\u2713")} ${id} \u2014 ${chalk.green("OK")}`);
        } else if (invoked && !correct) {
          lines.push(`    ${chalk.red("\u2717")} ${id} \u2014 ${chalk.red("issue found")}`);
        } else {
          lines.push(`    ${chalk.dim("-")} ${id} \u2014 ${chalk.dim("not triggered")}`);
        }
      }
      lines.push("");

      const allIssues = results.flatMap((r) => r.blueReport?.issuesFound ?? []);
      if (allIssues.length > 0) {
        lines.push(`  ${chalk.bold("Issues Found:")} ${allIssues.length}`);
        for (const issue of allIssues) {
          lines.push(`    ${chalk.dim("\u2022")} [${severityColor(issue.severity)}] ${issue.category}: ${issue.description}`);
        }
        lines.push("");
      }

      if (fixesApplied > 0) {
        lines.push(`  ${chalk.bold("Fixes Applied:")} ${fixesApplied}`);
        lines.push("");
      }

      lines.push(`  ${chalk.bold("Status:")} ${chalk.green(String(passed))} pass, ${chalk.yellow(String(proceed))} proceed, ${chalk.red(String(failed))} fail, ${totalComponents - passed - proceed - failed} untested (${coverageColor(pct)} complete)`);
      lines.push(`  ${chalk.dim(`Iteration Cost: $${iterCost.toFixed(2)} | Total Cost: $${totalCost.toFixed(2)}`)}`);
      lines.push(chalk.cyan(SEPARATOR));
      return lines.join("\n");
    }

    case "unit-batch-start": {
      const { iteration, componentIds, totalRemaining } = event;
      const lines = [
        sectionHeader(`TENET Unit \u2014 Batch ${iteration} (${componentIds.length} worker${componentIds.length > 1 ? "s" : ""}, ${totalRemaining} remaining)`),
        "",
      ];
      for (let i = 0; i < componentIds.length; i++) {
        lines.push(`  ${chalk.bold(`Worker ${i + 1}:`)} ${componentIds[i]}`);
      }
      return lines.join("\n");
    }

    case "unit-batch-complete": {
      const { iteration, results, coverage } = event;
      const totalComponents = Object.keys(coverage.components).length;
      const coveredCount = Object.values(coverage.components).filter((c) => c.covered).length;
      const pct = totalComponents > 0 ? Math.round((coveredCount / totalComponents) * 100) : 0;

      const lines = [
        "",
        sectionHeader(`TENET Unit \u2014 Batch ${iteration} Complete`),
        "",
      ];

      for (const r of results) {
        const icon = r.blueReport && r.blueReport.issuesFound.length === 0
          ? chalk.green("\u2713") : r.blueReport ? chalk.red("\u2717") : chalk.dim("\u25CB");
        const detail = r.redResult
          ? `${r.redResult.conversationTurns} exchanges, ${(r.redResult.durationMs / 1000).toFixed(1)}s, ${chalk.dim(`$${r.redResult.costUsd.toFixed(2)}`)}`
          : chalk.dim("skipped");
        const issues = r.blueReport ? `, ${r.blueReport.issuesFound.length} issues, ${r.blueReport.fixesApplied.length} fixes` : "";
        lines.push(`  ${icon} ${r.plan.targetComponent} \u2014 ${detail}${issues}`);
      }

      lines.push("");
      lines.push(`  ${chalk.bold("Coverage:")} ${coveredCount}/${totalComponents} components (${coverageColor(pct)})`);
      lines.push(chalk.cyan(SEPARATOR));
      return lines.join("\n");
    }

    case "dry-run-mission": {
      const m = event.mission;
      return [
        `  ${chalk.yellow.bold("[DRY RUN]")} Generated mission:`,
        "",
        `  ${chalk.bold("Mission ID:")} ${m.missionId}`,
        `  ${chalk.bold("Objective:")} ${m.objective}`,
        `  ${chalk.bold("Persona:")} ${m.persona}`,
        `  ${chalk.bold("Target Components:")} ${m.targetComponents.join(", ")}`,
        `  ${chalk.bold("Estimated Turns:")} ${m.estimatedTurns}`,
        "",
        `  ${chalk.bold("Conversation Starters:")}`,
        ...m.conversationStarters.map((s) => `    ${chalk.dim("-")} ${s}`),
        "",
        `  ${chalk.bold("Edge Cases to Probe:")}`,
        ...m.edgeCasesToProbe.map((e) => `    ${chalk.dim("-")} ${e}`),
        "",
        `  ${chalk.bold("Success Criteria:")}`,
        ...m.successCriteria.map((c) => `    ${chalk.dim("-")} ${c}`),
      ].join("\n");
    }

    case "dry-run-iteration-plan": {
      const { missions } = event;
      const lines = [
        `  ${chalk.yellow.bold("[DRY RUN]")} Generated ${missions.length} mission${missions.length > 1 ? "s" : ""}:`,
        "",
      ];
      for (let i = 0; i < missions.length; i++) {
        const m = missions[i];
        lines.push(`  ${chalk.dim("\u2500\u2500")} ${chalk.bold(`Worker ${i + 1}`)} ${chalk.dim("\u2500\u2500")}`);
        lines.push(`  ${chalk.bold("Mission ID:")} ${m.missionId}`);
        lines.push(`  ${chalk.bold("Objective:")} ${m.objective}`);
        lines.push(`  ${chalk.bold("Persona:")} ${m.persona}`);
        lines.push(`  ${chalk.bold("Target Components:")} ${m.targetComponents.join(", ")}`);
        lines.push(`  ${chalk.bold("Estimated Turns:")} ${m.estimatedTurns}`);
        lines.push("");
        lines.push(`  ${chalk.bold("Conversation Starters:")}`);
        for (const s of m.conversationStarters) lines.push(`    ${chalk.dim("-")} ${s}`);
        lines.push("");
        lines.push(`  ${chalk.bold("Edge Cases to Probe:")}`);
        for (const e of m.edgeCasesToProbe) lines.push(`    ${chalk.dim("-")} ${e}`);
        lines.push("");
      }
      return lines.join("\n");
    }

    case "final-summary": {
      const { coverage } = event;
      const totalComponents = Object.keys(coverage.components).length;
      const coveredCount = Object.values(coverage.components).filter((c) => c.covered).length;
      const pct = totalComponents > 0 ? Math.round((coveredCount / totalComponents) * 100) : 0;
      const totalIssues = coverage.rounds.reduce((sum, r) => sum + r.blueReport.issuesFound.length, 0);
      const totalFixes = coverage.rounds.reduce((sum, r) => sum + r.blueReport.fixesApplied.length, 0);
      const totalCost = coverage.rounds.reduce((sum, r) => sum + r.redResult.costUsd, 0);

      const lines = [
        sectionHeader("TENET \u2014 Final Summary"),
        "",
        `  ${chalk.bold("Rounds Completed:")} ${coverage.rounds.length}`,
        `  ${chalk.bold("Coverage:")} ${coveredCount}/${totalComponents} components (${coverageColor(pct)})`,
        `  ${chalk.bold("Total Issues Found:")} ${totalIssues}`,
        `  ${chalk.bold("Total Fixes Applied:")} ${totalFixes}`,
        `  ${chalk.bold("Total Cost:")} ${chalk.dim(`$${totalCost.toFixed(2)}`)}`,
        "",
        `  ${chalk.bold("Component Status:")}`,
      ];

      for (const [id, status] of Object.entries(coverage.components)) {
        const icon = status.covered ? chalk.green("\u2713") : chalk.red("\u2717");
        const round = status.coveredInRound ? chalk.dim(` (round ${status.coveredInRound})`) : "";
        const issues = status.issueCount > 0 ? chalk.yellow(`, ${status.issueCount} issues`) : "";
        const fixes = status.fixCount > 0 ? chalk.green(`, ${status.fixCount} fixes`) : "";
        lines.push(`    ${icon} ${id}${round}${issues}${fixes}`);
      }

      lines.push("");
      lines.push(chalk.cyan(SEPARATOR));
      return lines.join("\n");
    }

    case "final-summary-v2": {
      const { coverage } = event;
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

      const lines = [
        sectionHeader("TENET \u2014 Final Summary"),
        "",
        `  ${chalk.bold("Iterations Completed:")} ${totalRounds}`,
        `  ${chalk.bold("Coverage:")} ${passed}/${totalComponents} components pass (${coverageColor(pct)})`,
        `  ${chalk.bold("Total Issues Found:")} ${totalIssues}`,
        `  ${chalk.bold("Total Fixes Applied:")} ${totalFixesApplied}`,
        `  ${chalk.bold("Total Cost:")} ${chalk.dim(`$${totalCost.toFixed(2)}`)}`,
        "",
        `  ${chalk.bold("Component Status:")}`,
      ];

      for (const [id, status] of Object.entries(coverage.components)) {
        const icon = statusIcon(status.status);
        const iter = status.statusUpdatedInIteration ? chalk.dim(` (iter ${status.statusUpdatedInIteration})`) : "";
        const issues = status.issueCount > 0 ? chalk.yellow(`, ${status.issueCount} issues`) : "";
        const fixes = status.fixCount > 0 ? chalk.green(`, ${status.fixCount} fixes`) : "";
        lines.push(`    ${icon} ${id} [${status.status}]${iter}${issues}${fixes}`);
      }

      lines.push("");
      lines.push(chalk.cyan(SEPARATOR));
      return lines.join("\n");
    }

    case "ownership-assignments": {
      const lines = ["", `  ${chalk.bold("Ownership assignments:")}`];
      for (const a of event.assignments) {
        lines.push(`    ${a.componentId} ${chalk.dim("\u2192")} owner: ${chalk.bold(a.ownerComponentId)} ${chalk.dim(`(${a.reasoning.slice(0, 60)})`)}`);
      }
      return lines.join("\n");
    }

    case "error": {
      const msg = event.error instanceof Error ? event.error.message : String(event.error);
      return chalk.red(`  [ERROR] ${event.context}: ${msg}`);
    }

    case "warning":
      return chalk.yellow(`  [WARN] ${event.message}`);
  }
}

// ─── Dynamic Status (Spinner + Worker Panel) ────────────────────────────────

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

function DynamicStatus({ spinnerMessage, workerPhases }: {
  spinnerMessage: string | null;
  workerPhases: [number, string][];
}): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f: number) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  const spinner = chalk.cyan(SPINNER_FRAMES[frame]);

  return (
    <Box flexDirection="column">
      {spinnerMessage && workerPhases.length === 0 && (
        <Text>{spinner} {spinnerMessage}</Text>
      )}
      {workerPhases.map(([id, phase]) => {
        if (phase === "done") {
          return <Text key={id}>{"  "}{chalk.green("\u2713")} {chalk.dim(`Worker ${id}:`)} {chalk.green("done")}</Text>;
        }
        const label = phase === "red" ? chalk.red("Red team") : chalk.blue("Blue team");
        return <Text key={id}>{"  "}{spinner} {chalk.dim(`Worker ${id}:`)} {label}</Text>;
      })}
    </Box>
  );
}

// ─── MultiSelect Component ──────────────────────────────────────────────────

function MultiSelectPrompt({
  options,
  onComplete,
}: {
  options: MultiSelectOptions;
  onComplete: (values: string[]) => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useInput((input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean; escape: boolean }) => {
    if (key.upArrow) {
      setCursor((c: number) => Math.max(0, c - 1));
    } else if (key.downArrow) {
      setCursor((c: number) => Math.min(options.items.length - 1, c + 1));
    } else if (input === " ") {
      setSelected((prev: Set<number>) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
    } else if (key.return) {
      const values = [...selected].sort((a, b) => a - b).map((i) => options.items[i].value);
      onComplete(values);
    } else if (key.escape) {
      onComplete([]);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{"  "}{chalk.bold(options.title)}</Text>
      <Text dimColor>{"  "}{options.hint}</Text>
      {options.items.map((item, i) => (
        <Text key={i}>
          {"  "}{i === cursor ? chalk.cyan("\u276F") : " "} {selected.has(i) ? chalk.green("\u25C9") : chalk.dim("\u25CB")} {i === cursor ? chalk.bold(item.label) : item.label}
        </Text>
      ))}
    </Box>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export interface AppProps {
  events: UIEvent[];
  spinnerMessage: string | null;
  workerPhases: [number, string][];
  multiSelectOptions: MultiSelectOptions | null;
  onMultiSelectComplete: (values: string[]) => void;
}

export function App({
  events,
  spinnerMessage,
  workerPhases,
  multiSelectOptions,
  onMultiSelectComplete,
}: AppProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={events}>
        {(event: UIEvent, index: number) => (
          <Text key={index}>{formatEvent(event)}</Text>
        )}
      </Static>
      {(spinnerMessage || workerPhases.length > 0) && (
        <DynamicStatus spinnerMessage={spinnerMessage} workerPhases={workerPhases} />
      )}
      {multiSelectOptions && (
        <MultiSelectPrompt
          options={multiSelectOptions}
          onComplete={onMultiSelectComplete}
        />
      )}
    </Box>
  );
}
