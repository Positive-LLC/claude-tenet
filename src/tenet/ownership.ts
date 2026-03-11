import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Component,
  Inventory,
  OwnershipResult,
  UnitTestPlan,
} from "../types.ts";
import { OWNERSHIP_SCHEMA } from "../types.ts";
import { resolve, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { debug, printWarning, startTimer } from "../utils/logger.ts";
import { PROMPTS } from "../prompts.ts";
import { getClaudePath } from "../utils/claude-path.ts";

/**
 * Run a dedicated SDK call to analyze ownership relationships between components.
 * Returns which agent owns each tool component and what dependencies it has.
 */
export async function analyzeOwnership(
  inventory: Inventory,
  targetPath: string,
  abortController: AbortController,
): Promise<OwnershipResult> {
  const absTarget = resolve(targetPath);
  const claudePath = getClaudePath();
  const elapsed = startTimer();

  // Build prompt with full file contents for all components
  const sections: string[] = [
    `# Component Ownership Analysis`,
    ``,
    `Analyze the following components and determine ownership relationships.`,
    ``,
    `## Components`,
    ``,
  ];

  for (const comp of inventory.components) {
    if (comp.type === "mcp_server") continue; // Skip MCP servers

    let content = "";
    try {
      const filePath = comp.filePath.startsWith("/")
        ? comp.filePath
        : join(absTarget, comp.filePath);
      const stat = await Deno.stat(filePath);

      if (stat.isDirectory) {
        // For directories (skills), read the main .md file
        try {
          content = await Deno.readTextFile(join(filePath, "SKILL.md"));
        } catch {
          // Try any .md file
          for await (const entry of Deno.readDir(filePath)) {
            if (entry.name.endsWith(".md")) {
              content = await Deno.readTextFile(join(filePath, entry.name));
              break;
            }
          }
        }
      } else {
        content = await Deno.readTextFile(filePath);
      }
    } catch {
      content = comp.description;
    }

    sections.push(
      `### [${comp.type}] ${comp.id}`,
      `File: ${comp.filePath}`,
      ``,
      "```",
      content.slice(0, 3000), // Cap at 3000 chars per component
      "```",
      ``,
    );
  }

  sections.push(
    `## Available Component IDs`,
    ``,
    ...inventory.components
      .filter((c) => c.type !== "mcp_server")
      .map((c) => `- ${c.id} (${c.type})`),
    ``,
    `## Instructions`,
    ``,
    `For each skill, command, hook, knowledge, and other_md component, determine:`,
    `1. Which claude_md or agent component is its primary owner`,
    `2. Which other components should be copied alongside it for isolated testing`,
    ``,
    `Output the assignments as structured JSON.`,
  );

  const prompt = sections.join("\n");
  debug(`ownership: prompt built — ${prompt.length} chars`);

  const { CLAUDECODE: _, ...cleanEnv } = Deno.env.toObject();

  const ownershipQuery = query({
    prompt,
    options: {
      model: "claude-opus-4-6",
      pathToClaudeCodeExecutable: claudePath,
      env: cleanEnv,
      systemPrompt: PROMPTS.ownership,
      tools: [],
      outputFormat: { type: "json_schema", schema: OWNERSHIP_SCHEMA },
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      abortController,
    },
  });

  let result: OwnershipResult | null = null;

  try {
    let msgCount = 0;
    for await (const msg of ownershipQuery) {
      msgCount++;
      if (abortController.signal.aborted) {
        debug(`ownership: aborted after ${msgCount} messages [${elapsed()}]`);
        break;
      }

      const subtype = "subtype" in msg ? `:${msg.subtype}` : "";
      debug(`ownership: msg #${msgCount} type=${msg.type}${subtype} [${elapsed()}]`);

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          result = msg.structured_output as OwnershipResult;
          debug(`ownership: got ${result.assignments.length} assignments [${elapsed()}]`);
        } else if (msg.subtype !== "success") {
          printWarning(`Ownership analysis ended with: ${msg.subtype}`);
        }
        break;
      }
    }
    debug(`ownership: stream ended — ${msgCount} messages [${elapsed()}]`);
  } catch (err) {
    if (!abortController.signal.aborted) {
      printWarning(`Ownership analysis error: ${err}`);
      debug(`ownership: EXCEPTION — ${err} [${elapsed()}]`);
    }
  } finally {
    await ownershipQuery.return(undefined as never);
    debug(`ownership: query closed [${elapsed()}]`);
  }

  if (!result) {
    debug(`ownership: using fallback — all components owned by claude_md`);
    result = buildFallbackOwnership(inventory);
  }

  return result;
}

/**
 * Build UnitTestPlans from inventory and ownership analysis.
 */
export function buildUnitTestPlans(
  inventory: Inventory,
  ownershipResult: OwnershipResult,
): UnitTestPlan[] {
  const plans: UnitTestPlan[] = [];
  const assignmentMap = new Map(
    ownershipResult.assignments.map((a) => [a.componentId, a]),
  );
  const allIds = new Set(inventory.components.map((c) => c.id));

  for (const comp of inventory.components) {
    // Skip MCP servers — cannot unit test
    if (comp.type === "mcp_server") continue;

    if (comp.type === "claude_md") {
      // Complete setup: copy everything, systemPrompt = self
      plans.push({
        targetComponent: comp.id,
        setupType: "complete",
        systemPromptSource: comp.id,
        componentsToCopy: inventory.components
          .filter((c) => c.type !== "mcp_server")
          .map((c) => c.id),
      });
    } else if (comp.type === "agent") {
      // Focus setup: systemPrompt = self (agent .md), copy all tools
      plans.push({
        targetComponent: comp.id,
        setupType: "focus",
        systemPromptSource: comp.id,
        componentsToCopy: inventory.components
          .filter((c) =>
            c.type !== "mcp_server" && c.type !== "claude_md" && c.type !== "agent",
          )
          .map((c) => c.id),
      });
    } else {
      // skill, command, hook, knowledge, other_md → use LLM ownership
      const assignment = assignmentMap.get(comp.id);
      const owner = assignment?.ownerComponentId || findDefaultOwner(inventory);
      const deps = assignment?.componentsToCopy?.filter((id) => allIds.has(id)) || [];

      // Always include self in componentsToCopy
      const toCopy = new Set([comp.id, ...deps]);

      plans.push({
        targetComponent: comp.id,
        setupType: "focus",
        systemPromptSource: owner,
        componentsToCopy: [...toCopy],
      });
    }
  }

  return plans;
}

function findDefaultOwner(inventory: Inventory): string {
  const claudeMd = inventory.components.find((c) => c.type === "claude_md");
  return claudeMd?.id || "claude_md:claude";
}

function buildFallbackOwnership(inventory: Inventory): OwnershipResult {
  const defaultOwner = findDefaultOwner(inventory);
  const assignments = inventory.components
    .filter((c) =>
      c.type !== "claude_md" &&
      c.type !== "agent" &&
      c.type !== "mcp_server",
    )
    .map((c) => ({
      componentId: c.id,
      ownerComponentId: defaultOwner,
      componentsToCopy: [c.id],
      reasoning: "Fallback: assigned to main CLAUDE.md",
    }));

  return { assignments };
}
