import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BlueTeamReport,
  ComponentType,
  Inventory,
  Mission,
  PluginConfig,
  RedTeamResult,
} from "../types.ts";
import { BLUE_TEAM_REPORT_SCHEMA, FIX_GUIDANCE, MIN_OK_GUIDANCE } from "../types.ts";
import { extractSessionId, readSessionJSONL } from "./session-reader.ts";
import { printWarning, debug, startTimer } from "../utils/logger.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { PROMPTS } from "../prompts.ts";
import { getClaudePath } from "../utils/claude-path.ts";

function buildGuidanceSection(
  inventory: Inventory,
  mission: Mission,
): string[] {
  // Collect types of targeted components
  const targetedTypes = new Set<ComponentType>();
  const targetSet = new Set(mission.targetComponents);
  for (const c of inventory.components) {
    if (targetSet.has(c.id)) {
      targetedTypes.add(c.type);
    }
  }

  const lines: string[] = [];
  for (const type of targetedTypes) {
    const guidance = MIN_OK_GUIDANCE[type];
    if (guidance) {
      lines.push(`- **${type}**: ${guidance}`);
    }
  }

  if (lines.length === 0) return [];

  return [
    `## Type-Specific Evaluation Guidance`,
    ``,
    ...lines,
    ``,
  ];
}

function buildFixGuidanceSection(): string[] {
  const entries = Object.entries(FIX_GUIDANCE) as [string, string[]][];
  if (entries.length === 0) return [];

  const lines: string[] = [
    `## Fix Guidance`,
    ``,
    `When applying fixes, follow these rules:`,
    ``,
  ];
  for (const [category, bullets] of entries) {
    lines.push(`### ${category}`);
    for (const bullet of bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push(``);
  }
  return lines;
}

function buildBlueTeamPrompt(
  rawJSONL: string,
  sessionId: string,
  mission: Mission,
  inventory: Inventory,
): string {
  return [
    `# Blue Team Analysis Task`,
    ``,
    `## Mission Context`,
    `- Session ID: ${sessionId}`,
    `- Mission ID: ${mission.missionId}`,
    `- Objective: ${mission.objective}`,
    `- Persona: ${mission.persona}`,
    `- Target Components: ${mission.targetComponents.join(", ")}`,
    `- Success Criteria: ${mission.successCriteria.join("; ")}`,
    ``,
    `## Project Inventory`,
    `Project path: ${inventory.projectPath}`,
    `Components:`,
    ...inventory.components.map(
      (c) => `- [${c.type}] ${c.id}: ${c.filePath} — ${c.description.slice(0, 100)}`,
    ),
    ``,
    ...buildGuidanceSection(inventory, mission),
    ...buildFixGuidanceSection(),
    `## Raw Session Data`,
    ``,
    `Below is the raw JSONL from the red team session. Parse it to understand what happened — each line is a JSON object representing a message. Refer to the JSONL Format Reference in your system prompt for the schema.`,
    ``,
    "```jsonl",
    rawJSONL,
    "```",
    ``,
    `## Instructions`,
    ``,
    `1. Parse the raw JSONL session data above carefully`,
    `2. For each target component (${mission.targetComponents.join(", ")}), determine if it was invoked and whether it behaved correctly`,
    `3. Identify any issues in the agent's behavior (use the issue categories from your system prompt)`,
    `4. Read the relevant project files using your tools to understand root causes`,
    `5. Apply minimal fixes to project files where appropriate`,
    `6. Output a BlueTeamReport JSON object as your final structured output`,
    ``,
    `Remember: use session_id="${sessionId}" and mission_id="${mission.missionId}" in your report.`,
  ].join("\n");
}

function makeEmptyReport(
  sessionId: string,
  missionId: string,
): BlueTeamReport {
  return {
    sessionId,
    missionId,
    conversationSummary: {
      totalTurns: 0,
      totalToolCalls: 0,
      skillsInvoked: [],
      commandsInvoked: [],
    },
    componentsTested: [],
    issuesFound: [],
    fixesApplied: [],
    recommendations: [],
  };
}

export async function runBlueTeam(
  redResult: RedTeamResult,
  mission: Mission,
  inventory: Inventory,
  targetPath: string,
  abortController: AbortController,
  plugins: PluginConfig[] = [],
): Promise<BlueTeamReport> {
  // If no session file, return empty report
  if (!redResult.sessionFilePath) {
    printWarning("No session file from red team, skipping blue team analysis");
    return makeEmptyReport(redResult.sessionId, mission.missionId);
  }

  // Check if session file exists
  try {
    await Deno.stat(redResult.sessionFilePath);
  } catch {
    printWarning(
      `Session file not found: ${redResult.sessionFilePath}, skipping blue team`,
    );
    return makeEmptyReport(redResult.sessionId, mission.missionId);
  }

  // Read the raw session data
  debug(`blue-team: reading session file: ${redResult.sessionFilePath}`);
  const sessionId = await extractSessionId(redResult.sessionFilePath) || redResult.sessionId;
  const rawJSONL = await readSessionJSONL(redResult.sessionFilePath);
  debug(`blue-team: session data — ${rawJSONL.length} chars, sessionId=${sessionId.slice(0, 8)}...`);

  const blueTeamSystemPrompt = PROMPTS.blueTeam;
  const claudePath = getClaudePath();
  const prompt = buildBlueTeamPrompt(rawJSONL, sessionId, mission, inventory);
  debug(`blue-team: prompt built — ${prompt.length} chars`);

  // Build clean env without CLAUDECODE to allow nested sessions
  const { CLAUDECODE: _, ...cleanEnv } = Deno.env.toObject();

  debug(`blue-team: starting SDK call — claudePath=${claudePath}, cwd=${resolve(targetPath)}`);
  const elapsed = startTimer();

  const blueQuery = query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      pathToClaudeCodeExecutable: claudePath,
      env: cleanEnv,
      cwd: resolve(targetPath),
      systemPrompt: blueTeamSystemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: "json_schema", schema: BLUE_TEAM_REPORT_SCHEMA },
      maxTurns: 50,
      plugins: plugins.length > 0 ? plugins : undefined,
      abortController,
    },
  });

  let report: BlueTeamReport | null = null;

  try {
    let msgCount = 0;
    for await (const msg of blueQuery) {
      msgCount++;
      if (abortController.signal.aborted) {
        debug(`blue-team: aborted after ${msgCount} messages [${elapsed()}]`);
        break;
      }

      const subtype = "subtype" in msg ? `:${msg.subtype}` : "";
      debug(`blue-team: msg #${msgCount} type=${msg.type}${subtype} [${elapsed()}]`);

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          report = msg.structured_output as BlueTeamReport;
          debug(`blue-team: got structured report — ${report.issuesFound.length} issues, ${report.fixesApplied.length} fixes [${elapsed()}]`);
        } else if (msg.subtype !== "success") {
          printWarning(`Blue team ended with: ${msg.subtype}`);
        }
        break;
      }
    }
    debug(`blue-team: stream ended — ${msgCount} messages [${elapsed()}]`);
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`Blue team error: ${err}`);
      debug(`blue-team: EXCEPTION — ${err} [${elapsed()}]`);
    }
  }

  return report || makeEmptyReport(sessionId, mission.missionId);
}
