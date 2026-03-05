import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CoverageState, Inventory, Mission } from "../types.ts";
import { MISSION_SCHEMA } from "../types.ts";
import { printWarning, debug, startTimer } from "../utils/logger.ts";
import { PROMPTS } from "../prompts.ts";
import { getClaudePath } from "../utils/claude-path.ts";

/** Truncate a string to maxLen, appending "…" if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

function buildMissionPrompt(
  inventory: Inventory,
  coverage: CoverageState,
  round: number,
  totalRounds: number,
  maxExchanges: number,
  priorityComponents: string[] = [],
): string {
  const total = priorityComponents.length;
  const priorityMap = new Map(priorityComponents.map((id, i) => [id, total - i]));
  const componentsWithCoverage = inventory.components.map((c) => {
    const status = coverage.components[c.id];
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      filePath: c.filePath,
      description: c.description.slice(0, 150),
      covered: status?.covered ?? false,
      issueCount: status?.issueCount ?? 0,
      fixCount: status?.fixCount ?? 0,
      priority: priorityMap.get(c.id) ?? 0,
    };
  });

  // Build rich previous round summaries
  const previousRounds = coverage.rounds.map((r) => ({
    round: r.round,
    missionId: r.missionId,
    objective: truncate(r.missionObjective, 200),
    componentsTested: r.blueReport.componentsTested.map((ct) => ({
      componentId: ct.componentId,
      wasInvoked: ct.wasInvoked,
      behaviorCorrect: ct.behaviorCorrect,
      notes: truncate(ct.notes, 200),
    })),
    issuesFound: r.blueReport.issuesFound.map((i) => ({
      severity: i.severity,
      category: i.category,
      description: truncate(i.description, 200),
      rootCauseFile: i.rootCauseFile,
    })),
    fixesApplied: r.blueReport.fixesApplied.map((f) => ({
      filePath: f.filePath,
      description: truncate(f.description, 200),
    })),
    recommendations: r.blueReport.recommendations.map((rec) => ({
      description: truncate(rec.description, 200),
      priority: rec.priority,
    })),
  }));

  // User-priority components: those explicitly in the priority list with a positive score
  const userPriorityList = componentsWithCoverage
    .filter((c) => {
      const p = priorityMap.get(c.id);
      return p !== undefined && p > 0;
    })
    .sort((a, b) => b.priority - a.priority);

  const sections: string[] = [
    `MODE: GENERATE_MISSION`,
    ``,
    `## Current State`,
    `Round: ${round} of ${totalRounds}`,
    `Max conversation turns available: ${maxExchanges}`,
    ``,
    `## Project Inventory (with coverage status)`,
    `\`\`\`json`,
    JSON.stringify(componentsWithCoverage, null, 2),
    `\`\`\``,
  ];

  // User-priority section
  if (userPriorityList.length > 0 && userPriorityList.length < componentsWithCoverage.length) {
    sections.push(
      ``,
      `## User-Priority Components`,
      `The user explicitly selected these components for focused testing (highest priority first):`,
    );
    for (const c of userPriorityList) {
      const status = c.covered ? "COVERED" : c.issueCount > 0 ? `ISSUES(${c.issueCount}), fixes(${c.fixCount})` : "UNTESTED";
      sections.push(`- **${c.id}** — ${status}`);
    }
  }

  // Previous rounds section
  sections.push(
    ``,
    `## Previous Rounds`,
  );
  if (previousRounds.length > 0) {
    sections.push(`\`\`\`json`, JSON.stringify(previousRounds, null, 2), `\`\`\``);
  } else {
    sections.push(`None yet — this is the first round.`);
  }

  // Instructions with depth-first strategy
  sections.push(
    ``,
    `## Instructions`,
    `Generate a Mission JSON targeting components based on the following strategy:`,
    ``,
    `### Depth-First Retesting Strategy`,
    `1. **Re-validate fixed components** — If a user-priority component had issues in a previous round AND blue team applied fixes, re-target it to validate the fixes work.`,
    `2. **Re-attack unfixed components** — If a user-priority component had issues that were NOT fixed (no fixesApplied for it), re-target it with a different angle of attack.`,
    `3. **Only broaden when priority components are confirmed** — Only move on to new/lower-priority components when all user-priority components are \`covered: true\`.`,
    `4. **Vary the attack angle** — When retesting a component, use a different persona and conversation approach than previous rounds. Review the previous round objectives and change your strategy.`,
    ``,
    `### Component Priority`,
    `Components have a numeric \`priority\` field (higher number = higher priority).`,
    `After applying the depth-first strategy above, prefer higher-priority components.`,
    `Coverage status ranking: has-issues-with-fixes (revalidate) > has-issues-unfixed (retry) > untested > covered.`,
    ``,
    `Set the round field to ${round}.`,
    `Generate a UUID for missionId.`,
    `Keep estimatedTurns <= ${maxExchanges}.`,
  );

  return sections.join("\n");
}

export async function generateMission(
  inventory: Inventory,
  coverage: CoverageState,
  round: number,
  totalRounds: number,
  maxExchanges: number,
  abortController: AbortController,
  priorityComponents: string[] = [],
): Promise<Mission> {
  const tenetPrompt = PROMPTS.tenet;
  const claudePath = getClaudePath();
  const prompt = buildMissionPrompt(
    inventory,
    coverage,
    round,
    totalRounds,
    maxExchanges,
    priorityComponents,
  );

  // Build clean env without CLAUDECODE to allow nested sessions
  const { CLAUDECODE: _, ...cleanEnv } = Deno.env.toObject();

  debug(`mission: starting SDK call — prompt ${prompt.length} chars, claudePath=${claudePath}`);
  const elapsed = startTimer();

  const missionQuery = query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      pathToClaudeCodeExecutable: claudePath,
      env: cleanEnv,
      systemPrompt: tenetPrompt,
      tools: [],
      outputFormat: { type: "json_schema", schema: MISSION_SCHEMA },
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      abortController,
    },
  });

  let mission: Mission | null = null;

  try {
    let msgCount = 0;
    for await (const msg of missionQuery) {
      msgCount++;
      if (abortController.signal.aborted) {
        debug(`mission: aborted after ${msgCount} messages [${elapsed()}]`);
        break;
      }

      const subtype = "subtype" in msg ? `:${msg.subtype}` : "";
      debug(`mission: msg #${msgCount} type=${msg.type}${subtype} [${elapsed()}]`);

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          mission = msg.structured_output as Mission;
          debug(`mission: got structured output — objective: "${mission.objective.slice(0, 80)}..." [${elapsed()}]`);
        } else if (msg.subtype !== "success") {
          printWarning(`Mission generation ended with: ${msg.subtype}`);
        }
        break;
      }
    }
    debug(`mission: stream ended — ${msgCount} messages [${elapsed()}]`);
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`Mission generation error: ${err}`);
      debug(`mission: EXCEPTION — ${err} [${elapsed()}]`);
    }
  } finally {
    await missionQuery.return(undefined as never);
    debug(`mission: query closed [${elapsed()}]`);
  }

  if (!mission) {
    debug(`mission: using fallback mission [${elapsed()}]`);
    // Fallback: generate a basic mission (sort by position in priorityComponents)
    const uncovered = inventory.components.filter(
      (c) => !coverage.components[c.id]?.covered,
    );
    const rankMap = new Map(priorityComponents.map((id, i) => [id, i]));
    const sorted = uncovered.length > 0
      ? [...uncovered].sort((a, b) => (rankMap.get(a.id) ?? 999) - (rankMap.get(b.id) ?? 999))
      : [...inventory.components].sort((a, b) => (rankMap.get(a.id) ?? 999) - (rankMap.get(b.id) ?? 999));
    const targets = sorted.slice(0, 3).map((c) => c.id);

    mission = {
      missionId: crypto.randomUUID(),
      round,
      objective: `Test the following components: ${targets.join(", ")}`,
      targetComponents: targets,
      persona: "A general user exploring the agent's capabilities",
      conversationStarters: [
        "Hi, I need some help with a task.",
        "Can you help me with something?",
      ],
      edgeCasesToProbe: ["Try ambiguous inputs", "Test error handling"],
      successCriteria: targets.map((t) => `Component ${t} was exercised`),
      estimatedTurns: Math.min(maxExchanges, 10),
    };
  }

  return mission;
}
