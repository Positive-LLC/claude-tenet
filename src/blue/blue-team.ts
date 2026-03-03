import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BlueTeamReport,
  Inventory,
  Mission,
  RedTeamResult,
} from "../types.ts";
import { BLUE_TEAM_REPORT_SCHEMA } from "../types.ts";
import { parseSessionFile, formatSessionForPrompt } from "./session-reader.ts";
import { printWarning } from "../utils/logger.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

async function loadPrompt(path: string): Promise<string> {
  const scriptDir = new URL(".", import.meta.url).pathname;
  const projectRoot = resolve(scriptDir, "..", "..");
  return await Deno.readTextFile(resolve(projectRoot, path));
}

function buildBlueTeamPrompt(
  sessionText: string,
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
    `## Session Transcript`,
    ``,
    sessionText,
    ``,
    `## Instructions`,
    ``,
    `1. Read the session transcript above carefully`,
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

  // Parse the session
  const parsedSession = await parseSessionFile(redResult.sessionFilePath);
  const sessionText = formatSessionForPrompt(parsedSession);

  const blueTeamSystemPrompt = await loadPrompt("prompts/blue-team.md");
  const sessionId = parsedSession.sessionId || redResult.sessionId;
  const prompt = buildBlueTeamPrompt(sessionText, sessionId, mission, inventory);

  const blueQuery = query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      cwd: resolve(targetPath),
      systemPrompt: blueTeamSystemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: "json_schema", schema: BLUE_TEAM_REPORT_SCHEMA },
      maxTurns: 50,
      abortController,
    },
  });

  let report: BlueTeamReport | null = null;

  try {
    for await (const msg of blueQuery) {
      if (abortController.signal.aborted) break;

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          report = msg.structured_output as BlueTeamReport;
        } else if (msg.subtype !== "success") {
          printWarning(`Blue team ended with: ${msg.subtype}`);
        }
        break;
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`Blue team error: ${err}`);
    }
  }

  return report || makeEmptyReport(parsedSession.sessionId || redResult.sessionId, mission.missionId);
}
