import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Mission, RedTeamResult } from "../types.ts";
import { getSessionFilePath } from "../utils/session-path.ts";
import { printWarning } from "../utils/logger.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadPrompt(path: string): Promise<string> {
  const scriptDir = new URL(".", import.meta.url).pathname;
  const projectRoot = resolve(scriptDir, "..", "..");
  return await Deno.readTextFile(resolve(projectRoot, path));
}

function formatMissionContext(mission: Mission): string {
  return [
    `## Mission Brief`,
    ``,
    `**Objective**: ${mission.objective}`,
    ``,
    `**Your Persona**: ${mission.persona}`,
    ``,
    `**Conversation Starters** (pick one or adapt):`,
    ...mission.conversationStarters.map((s) => `- ${s}`),
    ``,
    `**Edge Cases to Probe**:`,
    ...mission.edgeCasesToProbe.map((e) => `- ${e}`),
    ``,
    `**Success Criteria** (stop when all are met):`,
    ...mission.successCriteria.map((c) => `- ${c}`),
    ``,
    `**Budget**: ~${mission.estimatedTurns} conversation turns`,
  ].join("\n");
}

function extractTextFromMessages(messages: SDKMessage[]): string {
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg.type === "assistant") {
      const content = msg.message.content;
      if (typeof content === "string") {
        texts.push(content);
      } else if (Array.isArray(content)) {
        const text = content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { type: string; text?: string }) => b.text || "")
          .join("\n");
        if (text.trim()) texts.push(text);
      }
    }
  }
  // Return the last text message (after all tool processing)
  return texts[texts.length - 1] || "";
}

// ─── Single SDK Call ─────────────────────────────────────────────────────────

interface SDKCallResult {
  sessionId: string;
  text: string;
  costUsd: number;
  errorSubtype: string;
}

async function callSDK(
  prompt: string,
  options: Record<string, unknown>,
  abortController: AbortController,
): Promise<SDKCallResult> {
  let sessionId = "";
  let costUsd = 0;
  let errorSubtype = "";
  const messages: SDKMessage[] = [];

  const q = query({
    prompt,
    options: { ...options, abortController } as never,
  });

  try {
    for await (const msg of q) {
      if (abortController.signal.aborted) break;

      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        sessionId = msg.session_id;
      }

      if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        if (msg.subtype !== "success") {
          errorSubtype = msg.subtype;
        }
        break;
      }

      messages.push(msg);
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`SDK call error: ${err}`);
      errorSubtype = "exception";
    }
  }

  const text = extractTextFromMessages(messages);
  return { sessionId, text, costUsd, errorSubtype };
}

// ─── Main Red Team Function ─────────────────────────────────────────────────

export async function runRedTeam(
  mission: Mission,
  targetPath: string,
  maxExchanges: number,
  abortController: AbortController,
): Promise<RedTeamResult> {
  const startTime = Date.now();
  let totalCostUsd = 0;
  let exchangeCount = 0;

  const redTeamPrompt = await loadPrompt("prompts/red-team.md");
  const missionContext = formatMissionContext(mission);
  const resolvedTargetPath = resolve(targetPath);

  // Attacker base options (no tools — purely conversational)
  const attackerBaseOpts = {
    model: "claude-opus-4-6",
    systemPrompt: redTeamPrompt,
    tools: [] as string[],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 1,
  };

  // Target base options (full Claude Code)
  const targetBaseOpts = {
    model: "claude-opus-4-6",
    cwd: resolvedTargetPath,
    systemPrompt: { type: "preset", preset: "claude_code" } as const,
    settingSources: ["project"] as string[],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 50,
  };

  let attackerSessionId = "";
  let targetSessionId = "";

  // ── Exchange 1: Attacker gets mission brief, generates opening message ────

  const firstPrompt = mission.objective + "\n\n" + missionContext;

  const atk1 = await callSDK(firstPrompt, attackerBaseOpts, abortController);
  attackerSessionId = atk1.sessionId;
  totalCostUsd += atk1.costUsd;

  if (!atk1.text.trim() || abortController.signal.aborted) {
    return makeResult(mission, "", 0, startTime, totalCostUsd, resolvedTargetPath);
  }

  exchangeCount++;

  // Send attacker's opening to target
  const tgt1 = await callSDK(atk1.text, targetBaseOpts, abortController);
  targetSessionId = tgt1.sessionId;
  totalCostUsd += tgt1.costUsd;

  if (abortController.signal.aborted) {
    return makeResult(mission, targetSessionId, exchangeCount, startTime, totalCostUsd, resolvedTargetPath);
  }

  let lastTargetText = tgt1.text;

  // ── Exchanges 2..N: Resume both sessions alternately ──────────────────────

  while (exchangeCount < maxExchanges && !abortController.signal.aborted) {
    // If target produced no text, conversation stalled
    if (!lastTargetText.trim()) {
      printWarning("Target produced no text response, ending conversation");
      break;
    }

    // Resume attacker with target's response
    const atkResult = await callSDK(lastTargetText, {
      ...attackerBaseOpts,
      resume: attackerSessionId,
    }, abortController);
    totalCostUsd += atkResult.costUsd;

    if (!atkResult.text.trim() || abortController.signal.aborted) {
      break;
    }

    exchangeCount++;

    // Resume target with attacker's next message
    const tgtResult = await callSDK(atkResult.text, {
      ...targetBaseOpts,
      resume: targetSessionId,
    }, abortController);
    totalCostUsd += tgtResult.costUsd;

    lastTargetText = tgtResult.text;

    if (tgtResult.errorSubtype || abortController.signal.aborted) {
      break;
    }
  }

  return makeResult(mission, targetSessionId, exchangeCount, startTime, totalCostUsd, resolvedTargetPath);
}

function makeResult(
  mission: Mission,
  sessionId: string,
  conversationTurns: number,
  startTime: number,
  costUsd: number,
  resolvedTargetPath: string,
): RedTeamResult {
  const sessionFilePath = sessionId
    ? getSessionFilePath(resolvedTargetPath, sessionId)
    : "";

  return {
    missionId: mission.missionId,
    sessionId,
    sessionFilePath,
    conversationTurns,
    durationMs: Date.now() - startTime,
    costUsd,
  };
}
