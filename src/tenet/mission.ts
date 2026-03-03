import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CoverageState, Inventory, Mission } from "../types.ts";
import { MISSION_SCHEMA } from "../types.ts";
import { printWarning, debug, startTimer } from "../utils/logger.ts";
import { PROMPTS } from "../prompts.ts";
import { getClaudePath } from "../utils/claude-path.ts";

function buildMissionPrompt(
  inventory: Inventory,
  coverage: CoverageState,
  round: number,
  totalRounds: number,
  maxExchanges: number,
): string {
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
    };
  });

  const previousMissions = coverage.rounds.map((r) => {
    // Extract the objective from the blue report's mission context
    const testedComponents = r.blueReport.componentsTested.map(
      (ct) => ct.componentId,
    );
    return {
      round: r.round,
      missionId: r.missionId,
      componentsTested: testedComponents,
    };
  });

  return [
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
    ``,
    `## Previous Missions (avoid repetition)`,
    previousMissions.length > 0
      ? `\`\`\`json\n${JSON.stringify(previousMissions, null, 2)}\n\`\`\``
      : `None yet — this is the first round.`,
    ``,
    `## Instructions`,
    `Generate a Mission JSON targeting the highest-priority uncovered components.`,
    `Set the round field to ${round}.`,
    `Generate a UUID for missionId.`,
    `Keep estimatedTurns <= ${maxExchanges}.`,
  ].join("\n");
}

export async function generateMission(
  inventory: Inventory,
  coverage: CoverageState,
  round: number,
  totalRounds: number,
  maxExchanges: number,
  abortController: AbortController,
): Promise<Mission> {
  const tenetPrompt = PROMPTS.tenet;
  const claudePath = getClaudePath();
  const prompt = buildMissionPrompt(
    inventory,
    coverage,
    round,
    totalRounds,
    maxExchanges,
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
  }

  if (!mission) {
    debug(`mission: using fallback mission [${elapsed()}]`);
    // Fallback: generate a basic mission
    const uncovered = inventory.components.filter(
      (c) => !coverage.components[c.id]?.covered,
    );
    const targets = uncovered.slice(0, 3).map((c) => c.id);

    mission = {
      missionId: crypto.randomUUID(),
      round,
      objective: `Test the following components: ${targets.join(", ")}`,
      targetComponents: targets.length > 0
        ? targets
        : inventory.components.slice(0, 3).map((c) => c.id),
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
