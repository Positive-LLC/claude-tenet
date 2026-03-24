import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CoverageState, Inventory, IterationPlan, Mission, UnitTestPlan } from "../types.ts";
import { MISSION_SCHEMA, ITERATION_PLAN_SCHEMA } from "../types.ts";
import { printWarning, debug, startTimer } from "../utils/logger.ts";
import { PROMPTS } from "../prompts.ts";
import { getClaudePath } from "../utils/claude-path.ts";
import { resolve, join } from "https://deno.land/std@0.224.0/path/mod.ts";

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
      status: status?.status ?? "untested",
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
    proposedFixes: (r.blueReport.proposedFixes || []).map((f) => ({
      targetFilePath: f.targetFilePath,
      description: truncate(f.description, 200),
      priority: f.priority,
    })),
    fixesApplied: (r.blueReport.fixesApplied || []).map((f) => ({
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
      const display = c.status === "pass" ? "PASS" : c.status === "fail" ? `FAIL(${c.issueCount} issues, ${c.fixCount} fixes)` : c.status === "proceed" ? "PROCEED" : "UNTESTED";
      sections.push(`- **${c.id}** — ${display}`);
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
    `1. **Re-validate fixed components** — If a user-priority component has status "fail" and fixes were applied, re-target it to validate the fixes work.`,
    `2. **Re-attack failed components** — If a component has status "fail" with no fixes applied, re-target it with a different angle of attack.`,
    `3. **Deepen "proceed" components** — Components with status "proceed" have been tested but need more depth. Test with different scenarios.`,
    `4. **Only broaden when priority components pass** — Only move on to new/lower-priority components when all user-priority components are "pass".`,
    `5. **Vary the attack angle** — When retesting a component, use a different persona and conversation approach than previous rounds.`,
    ``,
    `### Component Priority`,
    `Components have a numeric \`priority\` field (higher number = higher priority).`,
    `After applying the depth-first strategy above, prefer higher-priority components.`,
    `Status ranking: fail (revalidate/retry) > proceed (deepen) > untested > pass (done).`,
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
      (c) => coverage.components[c.id]?.status !== "pass",
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

// ─── Iteration Planning (Multi-Worker) ──────────────────────────────────────

function buildIterationPlanPrompt(
  inventory: Inventory,
  coverage: CoverageState,
  iteration: number,
  totalIterations: number,
  maxExchanges: number,
  workerCount: number,
  priorityComponents: string[] = [],
): string {
  // Reuse the base mission prompt content for context
  const basePrompt = buildMissionPrompt(
    inventory,
    coverage,
    iteration,
    totalIterations,
    maxExchanges,
    priorityComponents,
  );

  // Replace the MODE and instructions sections
  const sections: string[] = [
    basePrompt.replace("MODE: GENERATE_MISSION", "MODE: PLAN_ITERATION"),
    ``,
    `## Multi-Worker Planning`,
    ``,
    `You must generate exactly ${workerCount} missions, one for each worker.`,
    `Each mission should target DIFFERENT components or test the same components from DIFFERENT angles.`,
    `Ensure diversity: vary personas, attack angles, and edge cases across missions.`,
    ``,
    `## Status Updates`,
    ``,
    `Review all previous iteration results. For components with status "proceed":`,
    `- If the component has been tested thoroughly across multiple iterations with no issues, promote it to "pass".`,
    `- If it still needs more depth, leave it as "proceed".`,
    `For components with status "fail" that have had fixes applied and retested successfully, you may promote to "proceed" or "pass".`,
    ``,
    `Output your response as an IterationPlan JSON with:`,
    `- \`missions\`: array of exactly ${workerCount} Mission objects`,
    `- \`statusUpdates\`: array of status changes (componentId, newStatus, reason)`,
    ``,
    `Each mission must have a unique missionId (UUID), round set to ${iteration}, and estimatedTurns <= ${maxExchanges}.`,
  ];

  return sections.join("\n");
}

export async function planIteration(
  inventory: Inventory,
  coverage: CoverageState,
  iteration: number,
  totalIterations: number,
  maxExchanges: number,
  workerCount: number,
  abortController: AbortController,
  priorityComponents: string[] = [],
): Promise<IterationPlan> {
  const tenetPrompt = PROMPTS.tenet;
  const claudePath = getClaudePath();
  const prompt = buildIterationPlanPrompt(
    inventory,
    coverage,
    iteration,
    totalIterations,
    maxExchanges,
    workerCount,
    priorityComponents,
  );

  const { CLAUDECODE: _, ...cleanEnv } = Deno.env.toObject();

  debug(`plan-iteration: starting SDK call — ${workerCount} workers, prompt ${prompt.length} chars`);
  const elapsed = startTimer();

  const planQuery = query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      pathToClaudeCodeExecutable: claudePath,
      env: cleanEnv,
      systemPrompt: tenetPrompt,
      tools: [],
      outputFormat: { type: "json_schema", schema: ITERATION_PLAN_SCHEMA },
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      abortController,
    },
  });

  let plan: IterationPlan | null = null;

  try {
    let msgCount = 0;
    for await (const msg of planQuery) {
      msgCount++;
      if (abortController.signal.aborted) {
        debug(`plan-iteration: aborted after ${msgCount} messages [${elapsed()}]`);
        break;
      }

      const subtype = "subtype" in msg ? `:${msg.subtype}` : "";
      debug(`plan-iteration: msg #${msgCount} type=${msg.type}${subtype} [${elapsed()}]`);

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          plan = msg.structured_output as IterationPlan;
          debug(`plan-iteration: got ${plan.missions.length} missions, ${plan.statusUpdates.length} status updates [${elapsed()}]`);
        } else if (msg.subtype !== "success") {
          printWarning(`Iteration planning ended with: ${msg.subtype}`);
        }
        break;
      }
    }
    debug(`plan-iteration: stream ended — ${msgCount} messages [${elapsed()}]`);
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`Iteration planning error: ${err}`);
      debug(`plan-iteration: EXCEPTION — ${err} [${elapsed()}]`);
    }
  } finally {
    await planQuery.return(undefined as never);
    debug(`plan-iteration: query closed [${elapsed()}]`);
  }

  // Fallback: generate N basic missions
  if (!plan || plan.missions.length === 0) {
    debug(`plan-iteration: using fallback — generating ${workerCount} missions`);
    const rankMap = new Map(priorityComponents.map((id, i) => [id, i]));
    const nonPassed = inventory.components
      .filter((c) => coverage.components[c.id]?.status !== "pass")
      .sort((a, b) => (rankMap.get(a.id) ?? 999) - (rankMap.get(b.id) ?? 999));

    const missions: Mission[] = [];
    for (let w = 0; w < workerCount; w++) {
      // Distribute components across workers
      const startIdx = Math.floor((w * nonPassed.length) / workerCount);
      const endIdx = Math.floor(((w + 1) * nonPassed.length) / workerCount);
      const targets = nonPassed.slice(startIdx, Math.max(endIdx, startIdx + 1)).map((c) => c.id);

      if (targets.length === 0) {
        // All components passed, target random ones
        const allIds = inventory.components.map((c) => c.id);
        targets.push(allIds[w % allIds.length]);
      }

      missions.push({
        missionId: crypto.randomUUID(),
        round: iteration,
        objective: `Worker ${w + 1}: Test components ${targets.join(", ")}`,
        targetComponents: targets,
        persona: `A general user exploring the agent's capabilities (worker ${w + 1})`,
        conversationStarters: [
          "Hi, I need some help with a task.",
          "Can you help me with something?",
        ],
        edgeCasesToProbe: ["Try ambiguous inputs", "Test error handling"],
        successCriteria: targets.map((t) => `Component ${t} was exercised`),
        estimatedTurns: Math.min(maxExchanges, 10),
      });
    }

    plan = { missions, statusUpdates: [] };
  }

  // Ensure we have exactly workerCount missions
  while (plan.missions.length < workerCount) {
    // Duplicate the last mission with a new ID
    const last = plan.missions[plan.missions.length - 1];
    plan.missions.push({
      ...last,
      missionId: crypto.randomUUID(),
    });
  }
  if (plan.missions.length > workerCount) {
    plan.missions = plan.missions.slice(0, workerCount);
  }

  return plan;
}

// ─── Unit Test Mission Generation ───────────────────────────────────────────

function buildUnitMissionPrompt(
  plan: UnitTestPlan,
  inventory: Inventory,
  coverage: CoverageState,
  round: number,
  totalRounds: number,
  maxExchanges: number,
  targetPath: string,
): string {
  const absTarget = resolve(targetPath);
  const comp = inventory.components.find((c) => c.id === plan.targetComponent);

  // Read full file content of target component
  let fullContent = "(could not read file)";
  if (comp) {
    try {
      const filePath = comp.filePath.startsWith("/")
        ? comp.filePath
        : join(absTarget, comp.filePath);
      const stat = Deno.statSync(filePath);
      if (stat.isDirectory) {
        // For skill directories, read SKILL.md or first .md
        try {
          fullContent = Deno.readTextFileSync(join(filePath, "SKILL.md"));
        } catch {
          for (const entry of Deno.readDirSync(filePath)) {
            if (entry.name.endsWith(".md")) {
              fullContent = Deno.readTextFileSync(join(filePath, entry.name));
              break;
            }
          }
        }
      } else {
        fullContent = Deno.readTextFileSync(filePath);
      }
    } catch {
      fullContent = comp.description;
    }
  }

  const status = coverage.components[plan.targetComponent];
  const coverageInfo = status
    ? `covered=${status.covered}, issues=${status.issueCount}, fixes=${status.fixCount}`
    : "untested";

  const sections: string[] = [
    `MODE: GENERATE_UNIT_MISSION`,
    ``,
    `## Target Component`,
    `- ID: ${plan.targetComponent}`,
    `- Type: ${comp?.type || "unknown"}`,
    `- File: ${comp?.filePath || "unknown"}`,
    `- Coverage: ${coverageInfo}`,
    `- Setup Type: ${plan.setupType}`,
    `- System Prompt Source: ${plan.systemPromptSource}`,
    ``,
    `## Full Component Content`,
    `\`\`\``,
    fullContent,
    `\`\`\``,
    ``,
    `## Test Environment`,
    `Sandbox contains these components:`,
    ...plan.componentsToCopy.map((id) => {
      const c = inventory.components.find((x) => x.id === id);
      return `- ${id} (${c?.type || "?"}) — ${c?.filePath || "?"}`;
    }),
    ``,
    `## State`,
    `Round: ${round} of ${totalRounds}`,
    `Max conversation turns: ${maxExchanges}`,
    ``,
    `## Instructions`,
    `Generate a Mission JSON that deeply tests this single component.`,
    `The targetComponents array must contain exactly: ["${plan.targetComponent}"]`,
    `Set round to ${round}.`,
    `Generate a UUID for missionId.`,
    `Set estimatedTurns to ${maxExchanges} (use the full budget for thorough testing).`,
    `Design conversation starters that each test a different aspect of the component.`,
    `Include edge cases: boundary inputs, ambiguous requests, error conditions, adversarial inputs.`,
  ];

  return sections.join("\n");
}

export async function generateUnitMission(
  plan: UnitTestPlan,
  inventory: Inventory,
  coverage: CoverageState,
  round: number,
  totalRounds: number,
  maxExchanges: number,
  abortController: AbortController,
  targetPath: string,
): Promise<Mission> {
  const claudePath = getClaudePath();
  const prompt = buildUnitMissionPrompt(
    plan,
    inventory,
    coverage,
    round,
    totalRounds,
    maxExchanges,
    targetPath,
  );

  const { CLAUDECODE: _, ...cleanEnv } = Deno.env.toObject();

  debug(`unit-mission: starting SDK call — prompt ${prompt.length} chars`);
  const elapsed = startTimer();

  const missionQuery = query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      pathToClaudeCodeExecutable: claudePath,
      env: cleanEnv,
      systemPrompt: PROMPTS.unitTest,
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
      if (abortController.signal.aborted) break;

      const subtype = "subtype" in msg ? `:${msg.subtype}` : "";
      debug(`unit-mission: msg #${msgCount} type=${msg.type}${subtype} [${elapsed()}]`);

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          mission = msg.structured_output as Mission;
          debug(`unit-mission: objective: "${mission.objective.slice(0, 80)}..." [${elapsed()}]`);
        } else if (msg.subtype !== "success") {
          printWarning(`Unit mission generation ended with: ${msg.subtype}`);
        }
        break;
      }
    }
    debug(`unit-mission: stream ended — ${msgCount} messages [${elapsed()}]`);
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`Unit mission generation error: ${err}`);
      debug(`unit-mission: EXCEPTION — ${err} [${elapsed()}]`);
    }
  } finally {
    await missionQuery.return(undefined as never);
    debug(`unit-mission: query closed [${elapsed()}]`);
  }

  if (!mission) {
    debug(`unit-mission: using fallback`);
    mission = {
      missionId: crypto.randomUUID(),
      round,
      objective: `Thoroughly test component ${plan.targetComponent} with edge cases and adversarial inputs`,
      targetComponents: [plan.targetComponent],
      persona: "A demanding, detail-oriented user who notices subtle errors",
      conversationStarters: [
        "I need to test this specific functionality thoroughly.",
        "Let me try some edge cases.",
      ],
      edgeCasesToProbe: [
        "Empty or missing inputs",
        "Very long inputs",
        "Special characters and unicode",
        "Conflicting instructions",
      ],
      successCriteria: [
        `Component ${plan.targetComponent} handles all scenarios correctly`,
        `Error messages are helpful and accurate`,
      ],
      estimatedTurns: maxExchanges,
    };
  }

  // Tag with unit test metadata
  mission.testMode = "unit";
  mission.setupType = plan.setupType;
  mission.systemPromptComponentId = plan.systemPromptSource;

  return mission;
}
