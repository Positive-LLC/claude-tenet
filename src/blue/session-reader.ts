import type { ParsedSession, ParsedTurn } from "../types.ts";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: ContentBlock[] | string;
  tool_use_id?: string;
}

interface SessionMessage {
  type: string;
  subtype?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  session_id?: string;
  uuid?: string;
  timestamp?: string;
  tool_use_result?: unknown;
}

function summarize(value: unknown, maxLen: number = 150): string {
  if (value === undefined || value === null) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}

function extractToolCalls(
  content: string | ContentBlock[],
): { name: string; inputSummary: string; outputSummary: string }[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      name: b.name || "unknown",
      inputSummary: summarize(b.input),
      outputSummary: "",
    }));
}

export async function parseSessionFile(
  filePath: string,
): Promise<ParsedSession> {
  const raw = await Deno.readTextFile(filePath);
  const lines = raw.trim().split("\n").filter((l) => l.trim());

  let sessionId = "";
  const turns: ParsedTurn[] = [];
  const toolsUsed = new Set<string>();
  const filesAccessed = new Set<string>();
  const errors: string[] = [];
  let turnNumber = 0;

  // Map tool_use_id → pending tool call for attaching results later
  const pendingToolCalls = new Map<
    string,
    { name: string; inputSummary: string; outputSummary: string }
  >();

  for (const line of lines) {
    let msg: SessionMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Capture session ID from init message
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      sessionId = msg.session_id;
      continue;
    }

    // User messages (may contain tool results)
    if (msg.type === "user" && msg.message) {
      // Attach tool result summaries to matching tool calls
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const pending = pendingToolCalls.get(block.tool_use_id);
            if (pending) {
              pending.outputSummary = summarize(block.content);
              pendingToolCalls.delete(block.tool_use_id);
            }
          }
        }
      } else if (msg.tool_use_result !== undefined) {
        // Inline tool_use_result format — match by most recent pending
        // (some JSONL formats attach result directly on the user message)
      }

      // Only count as a conversation turn if it has real user text
      const text = extractText(msg.message.content);
      if (text.trim()) {
        turnNumber++;
        turns.push({
          turnNumber,
          role: "user",
          text: text.slice(0, 500),
          timestamp: msg.timestamp || "",
        });
      }
      continue;
    }

    // Assistant messages
    if (msg.type === "assistant" && msg.message) {
      turnNumber++;
      const text = extractText(msg.message.content);
      const toolCalls = extractToolCalls(msg.message.content);

      // Track tool uses and register pending tool calls for result matching
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            toolsUsed.add(block.name || "unknown");
            // Register for result matching
            if (block.tool_use_id) {
              const tc = toolCalls.find((t) => t.name === (block.name || "unknown"));
              if (tc) {
                pendingToolCalls.set(block.tool_use_id, tc);
              }
            }
            // Track file access from common tool patterns
            const input = block.input as Record<string, unknown> | undefined;
            if (input) {
              const fp = (input.file_path || input.path || input.filePath) as string | undefined;
              if (fp && typeof fp === "string") {
                filesAccessed.add(fp);
              }
            }
          }
        }
      }

      turns.push({
        turnNumber,
        role: "assistant",
        text: text.slice(0, 500),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: msg.timestamp || "",
      });
      continue;
    }

    // Result messages (errors)
    if (msg.type === "result" && msg.subtype && msg.subtype.startsWith("error")) {
      errors.push(msg.subtype);
    }
  }

  return {
    sessionId,
    turns,
    toolsUsed: [...toolsUsed],
    filesAccessed: [...filesAccessed],
    errors,
  };
}

export function formatSessionForPrompt(session: ParsedSession): string {
  const lines: string[] = [
    `# Session Transcript (${session.sessionId})`,
    ``,
    `Tools used: ${session.toolsUsed.join(", ") || "none"}`,
    `Files accessed: ${session.filesAccessed.slice(0, 20).join(", ") || "none"}`,
    `Errors: ${session.errors.join(", ") || "none"}`,
    ``,
    `## Conversation`,
    ``,
  ];

  for (const turn of session.turns) {
    const roleLabel = turn.role === "user" ? "USER" : "ASSISTANT";
    lines.push(`### Turn ${turn.turnNumber} (${roleLabel})`);
    lines.push(turn.text);

    if (turn.toolCalls && turn.toolCalls.length > 0) {
      lines.push(`\nTool calls:`);
      for (const tc of turn.toolCalls) {
        lines.push(`  - ${tc.name}: ${tc.inputSummary}`);
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}
