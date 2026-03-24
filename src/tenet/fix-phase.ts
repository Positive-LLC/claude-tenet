import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProposedFix, TaskResult } from "../types.ts";
import { debug, printWarning, startTimer } from "../utils/logger.ts";
import { PROMPTS } from "../prompts.ts";
import { getClaudePath } from "../utils/claude-path.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Collect all proposed fixes from task results, deduplicate, and sort by priority.
 */
export function collectAndDedup(results: TaskResult[]): ProposedFix[] {
  const allFixes: ProposedFix[] = [];
  for (const result of results) {
    if (result.blueReport?.proposedFixes) {
      allFixes.push(...result.blueReport.proposedFixes);
    }
  }

  if (allFixes.length === 0) return [];

  // Deduplicate: group by targetFilePath + issueId, keep highest priority
  const seen = new Map<string, ProposedFix>();
  for (const fix of allFixes) {
    const key = `${fix.targetFilePath}::${fix.issueId}`;
    const existing = seen.get(key);
    if (!existing || (SEVERITY_ORDER[fix.priority] ?? 3) < (SEVERITY_ORDER[existing.priority] ?? 3)) {
      seen.set(key, fix);
    }
  }

  // Also deduplicate by targetFilePath + similar description (fuzzy)
  const byFile = new Map<string, ProposedFix[]>();
  for (const fix of seen.values()) {
    const existing = byFile.get(fix.targetFilePath) ?? [];
    // Skip if there's already a fix for this file with very similar description
    const isDupe = existing.some((f) => {
      const a = f.description.toLowerCase();
      const b = fix.description.toLowerCase();
      return a === b || a.includes(b) || b.includes(a);
    });
    if (!isDupe) {
      existing.push(fix);
      byFile.set(fix.targetFilePath, existing);
    }
  }

  const deduped = Array.from(byFile.values()).flat();

  // Sort by severity (critical first)
  deduped.sort((a, b) => (SEVERITY_ORDER[a.priority] ?? 3) - (SEVERITY_ORDER[b.priority] ?? 3));

  debug(`fix-phase: collected ${allFixes.length} fixes, deduped to ${deduped.length}`);
  return deduped;
}

/**
 * Apply proposed fixes via a single SDK call with tool access to the target project.
 * Returns the number of fixes applied.
 */
export async function applyFixes(
  fixes: ProposedFix[],
  targetPath: string,
  abortController: AbortController,
): Promise<number> {
  if (fixes.length === 0) return 0;

  const claudePath = getClaudePath();
  const resolvedPath = resolve(targetPath);
  const { CLAUDECODE: _, ...cleanEnv } = Deno.env.toObject();

  const fixDescriptions = fixes.map((f, i) =>
    `${i + 1}. [${f.priority.toUpperCase()}] ${f.targetFilePath}\n   Issue: ${f.description}\n   Change: ${f.suggestedChange}`
  ).join("\n\n");

  const prompt = [
    `# Fix Application Task`,
    ``,
    `Apply the following fixes to the project files. Each fix has been analyzed and proposed by the blue team.`,
    `Apply them surgically — change only what's necessary, preserve existing code structure and comments.`,
    ``,
    `## Fixes to Apply (${fixes.length} total, ordered by priority)`,
    ``,
    fixDescriptions,
    ``,
    `## Instructions`,
    ``,
    `1. Read each target file before editing`,
    `2. Apply the suggested change as described`,
    `3. If a fix cannot be applied (file doesn't exist, change is unclear), skip it`,
    `4. Do NOT make additional changes beyond what's specified`,
    `5. Do NOT modify test files or configuration unless specified`,
  ].join("\n");

  debug(`fix-phase: applying ${fixes.length} fixes to ${resolvedPath}`);
  const elapsed = startTimer();

  const fixQuery = query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      pathToClaudeCodeExecutable: claudePath,
      env: cleanEnv,
      cwd: resolvedPath,
      systemPrompt: PROMPTS.tenet,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
      abortController,
    } as never,
  });

  try {
    let msgCount = 0;
    for await (const msg of fixQuery) {
      msgCount++;
      if (abortController.signal.aborted) {
        debug(`fix-phase: aborted after ${msgCount} messages [${elapsed()}]`);
        break;
      }

      const subtype = "subtype" in msg ? `:${msg.subtype}` : "";
      debug(`fix-phase: msg #${msgCount} type=${msg.type}${subtype} [${elapsed()}]`);

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          debug(`fix-phase: completed successfully [${elapsed()}]`);
        } else {
          printWarning(`Fix phase ended with: ${msg.subtype}`);
        }
        break;
      }
    }
    debug(`fix-phase: stream ended — ${msgCount} messages [${elapsed()}]`);
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`Fix phase error: ${err}`);
      debug(`fix-phase: EXCEPTION — ${err} [${elapsed()}]`);
    }
  } finally {
    await fixQuery.return(undefined as never);
    debug(`fix-phase: query closed [${elapsed()}]`);
  }

  return fixes.length;
}
