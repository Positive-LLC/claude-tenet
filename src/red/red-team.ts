import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Mission, PluginConfig, RedTeamResult } from "../types.ts";
import { getSessionFilePath } from "../utils/session-path.ts";
import { printWarning, debug, startTimer } from "../utils/logger.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { PROMPTS } from "../prompts.ts";
import { getClaudePath } from "../utils/claude-path.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  label = "sdk-call",
): Promise<SDKCallResult> {
  let sessionId = "";
  let costUsd = 0;
  let errorSubtype = "";
  const messages: SDKMessage[] = [];
  const elapsed = startTimer();

  const resumeId = options.resume ? ` (resume=${String(options.resume).slice(0, 8)}...)` : "";
  debug(`${label}: starting${resumeId} — prompt ${prompt.length} chars`);

  const q = query({
    prompt,
    options: { ...options, abortController } as never,
  });

  try {
    let msgCount = 0;
    for await (const msg of q) {
      msgCount++;
      if (abortController.signal.aborted) {
        debug(`${label}: aborted after ${msgCount} messages [${elapsed()}]`);
        break;
      }

      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        sessionId = msg.session_id;
        debug(`${label}: init — session=${sessionId.slice(0, 8)}... [${elapsed()}]`);
      } else if (msg.type === "assistant") {
        const preview = extractTextFromMessages([msg]).replace(/\n/g, " ");
        debug(`${label}: assistant msg #${msgCount}${preview ? ` — "${preview}"` : ""} [${elapsed()}]`);
      } else if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        if (msg.subtype !== "success") {
          errorSubtype = msg.subtype;
          debug(`${label}: result — ${msg.subtype} $${costUsd.toFixed(3)} [${elapsed()}]`);
        } else {
          debug(`${label}: result — success $${costUsd.toFixed(3)} [${elapsed()}]`);
        }
        break;
      } else {
        // Log other message types (tool_use, tool_result, etc.)
        const subtype = "subtype" in msg ? `:${msg.subtype}` : "";
        debug(`${label}: ${msg.type}${subtype} msg #${msgCount} [${elapsed()}]`);
      }

      messages.push(msg);
    }
    debug(`${label}: stream ended — ${msgCount} messages total [${elapsed()}]`);
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`SDK call error: ${err}`);
      debug(`${label}: EXCEPTION — ${err} [${elapsed()}]`);
      errorSubtype = "exception";
    }
  } finally {
    // Close the Query's underlying transport/child process
    await q.return(undefined as never);
    debug(`${label}: query closed [${elapsed()}]`);
  }

  const text = extractTextFromMessages(messages);
  debug(`${label}: done — text ${text.length} chars, session=${sessionId.slice(0, 8)}... [${elapsed()}]`);
  return { sessionId, text, costUsd, errorSubtype };
}

// ─── Main Red Team Function ─────────────────────────────────────────────────

export async function runRedTeam(
  mission: Mission,
  targetPath: string,
  maxExchanges: number,
  abortController: AbortController,
  plugins: PluginConfig[] = [],
  customSystemPrompt?: string,
): Promise<RedTeamResult> {
  const startTime = Date.now();
  let totalCostUsd = 0;
  let exchangeCount = 0;

  const redTeamPrompt = PROMPTS.redTeam;
  const claudePath = getClaudePath();
  const missionContext = formatMissionContext(mission);
  const resolvedTargetPath = resolve(targetPath);

  // Build clean env without CLAUDECODE to allow nested sessions
  const { CLAUDECODE: _, ...cleanEnv } = Deno.env.toObject();

  // Attacker base options (no tools — purely conversational)
  const attackerBaseOpts = {
    model: "claude-opus-4-6",
    pathToClaudeCodeExecutable: claudePath,
    env: cleanEnv,
    systemPrompt: redTeamPrompt,
    tools: [] as string[],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 1,
  };

  // Target base options (full Claude Code, or custom systemPrompt for unit tests)
  const targetSystemPrompt = customSystemPrompt
    ? customSystemPrompt
    : { type: "preset" as const, preset: "claude_code" as const };
  const targetBaseOpts = {
    model: "claude-opus-4-6",
    pathToClaudeCodeExecutable: claudePath,
    env: cleanEnv,
    cwd: resolvedTargetPath,
    systemPrompt: targetSystemPrompt,
    settingSources: ["project"] as string[],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 50,
    plugins: plugins.length > 0 ? plugins : undefined,
  };

  let attackerSessionId = "";
  let targetSessionId = "";

  // ── Exchange 1: Attacker gets mission brief, generates opening message ────

  const firstPrompt = mission.objective + "\n\n" + missionContext;

  debug(`red-team: === Exchange 1/${maxExchanges} ===`);
  debug(`red-team: calling attacker (initial mission brief)`);
  const atk1 = await callSDK(firstPrompt, attackerBaseOpts, abortController, "attacker[1]");
  attackerSessionId = atk1.sessionId;
  totalCostUsd += atk1.costUsd;

  if (!atk1.text.trim() || abortController.signal.aborted) {
    debug(`red-team: attacker produced no text or aborted — exiting early`);
    return makeResult(mission, "", 0, startTime, totalCostUsd, resolvedTargetPath);
  }

  exchangeCount++;
  debug(`red-team: attacker opening (${atk1.text.length} chars):\n${atk1.text}`);

  // Send attacker's opening to target
  debug(`red-team: calling target with attacker's opening`);
  const tgt1 = await callSDK(atk1.text, targetBaseOpts, abortController, "target[1]");
  targetSessionId = tgt1.sessionId;
  totalCostUsd += tgt1.costUsd;

  if (abortController.signal.aborted) {
    debug(`red-team: aborted after first target call`);
    return makeResult(mission, targetSessionId, exchangeCount, startTime, totalCostUsd, resolvedTargetPath);
  }

  debug(`red-team: target response (${tgt1.text.length} chars):\n${tgt1.text}`);
  let lastTargetText = tgt1.text;

  // ── Exchanges 2..N: Resume both sessions alternately ──────────────────────

  while (exchangeCount < maxExchanges && !abortController.signal.aborted) {
    debug(`red-team: === Exchange ${exchangeCount + 1}/${maxExchanges} ===`);

    // If target produced no text, conversation stalled
    if (!lastTargetText.trim()) {
      printWarning("Target produced no text response, ending conversation");
      break;
    }

    // Resume attacker with target's response
    debug(`red-team: resuming attacker with target's response (${lastTargetText.length} chars)`);
    const atkResult = await callSDK(lastTargetText, {
      ...attackerBaseOpts,
      resume: attackerSessionId,
    }, abortController, `attacker[${exchangeCount + 1}]`);
    totalCostUsd += atkResult.costUsd;

    if (!atkResult.text.trim() || abortController.signal.aborted) {
      debug(`red-team: attacker produced no text or aborted — stopping relay`);
      break;
    }

    exchangeCount++;
    debug(`red-team: attacker msg (${atkResult.text.length} chars):\n${atkResult.text}`);

    // Resume target with attacker's next message
    debug(`red-team: resuming target with attacker's message`);
    const tgtResult = await callSDK(atkResult.text, {
      ...targetBaseOpts,
      resume: targetSessionId,
    }, abortController, `target[${exchangeCount}]`);
    totalCostUsd += tgtResult.costUsd;

    lastTargetText = tgtResult.text;
    debug(`red-team: target response (${tgtResult.text.length} chars):\n${tgtResult.text}`);

    if (tgtResult.errorSubtype) {
      debug(`red-team: target error — ${tgtResult.errorSubtype}, stopping relay`);
      break;
    }
    if (abortController.signal.aborted) {
      debug(`red-team: aborted`);
      break;
    }
    debug(`red-team: exchange ${exchangeCount} complete, total cost so far: $${totalCostUsd.toFixed(3)}`);
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
