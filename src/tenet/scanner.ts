import type { Component, ComponentType, Inventory } from "../types.ts";
import { join, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

export async function scanProject(projectPath: string): Promise<Inventory> {
  const absPath = resolve(projectPath);
  const components: Component[] = [];

  // 1. CLAUDE*.md files
  await scanClaudeMd(absPath, components);

  // 2. Skills
  await scanSkills(absPath, components);

  // 3. Commands
  await scanCommands(absPath, components);

  // 4. Agents
  await scanAgents(absPath, components);

  // 5. Knowledges
  await scanKnowledges(absPath, components);

  // 6. Settings (hooks + MCP servers)
  await scanSettings(absPath, components);

  // 7. Other root .md files
  await scanOtherMd(absPath, components);

  return {
    projectPath: absPath,
    scannedAt: new Date().toISOString(),
    components,
  };
}

async function scanClaudeMd(
  projectPath: string,
  components: Component[],
): Promise<void> {
  for await (const entry of walkGlob(projectPath, /^CLAUDE.*\.md$/i)) {
    const content = await readFileHead(join(projectPath, entry), 200);
    const name = entry.replace(/\.md$/i, "").toLowerCase();
    components.push({
      id: `claude_md:${name}`,
      type: "claude_md",
      name: entry,
      filePath: entry,
      description: content,
    });
  }
}

async function scanSkills(
  projectPath: string,
  components: Component[],
): Promise<void> {
  const skillsDir = join(projectPath, ".claude", "skills");
  if (!(await dirExists(skillsDir))) return;

  for await (const entry of Deno.readDir(skillsDir)) {
    if (!entry.isDirectory) continue;
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    let description = "";
    try {
      description = await readFileHead(skillMd, 200);
    } catch {
      // No SKILL.md, try to read any .md in the directory
      try {
        for await (const f of Deno.readDir(join(skillsDir, entry.name))) {
          if (f.name.endsWith(".md")) {
            description = await readFileHead(
              join(skillsDir, entry.name, f.name),
              200,
            );
            break;
          }
        }
      } catch {
        // empty
      }
    }
    components.push({
      id: `skill:${entry.name}`,
      type: "skill",
      name: entry.name,
      filePath: `.claude/skills/${entry.name}`,
      description,
    });
  }
}

async function scanCommands(
  projectPath: string,
  components: Component[],
): Promise<void> {
  const commandsDir = join(projectPath, ".claude", "commands");
  if (!(await dirExists(commandsDir))) return;

  for await (const entry of Deno.readDir(commandsDir)) {
    if (!entry.name.endsWith(".md")) continue;
    const content = await readFileHead(
      join(commandsDir, entry.name),
      200,
    );
    const name = entry.name.replace(/\.md$/, "");
    components.push({
      id: `command:${name}`,
      type: "command",
      name,
      filePath: `.claude/commands/${entry.name}`,
      description: content,
    });
  }
}

async function scanAgents(
  projectPath: string,
  components: Component[],
): Promise<void> {
  const agentsDir = join(projectPath, ".claude", "agents");
  if (!(await dirExists(agentsDir))) return;

  for await (const entry of Deno.readDir(agentsDir)) {
    if (!entry.name.endsWith(".md")) continue;
    const content = await readFileHead(
      join(agentsDir, entry.name),
      200,
    );
    const name = entry.name.replace(/\.md$/, "");
    components.push({
      id: `agent:${name}`,
      type: "agent",
      name,
      filePath: `.claude/agents/${entry.name}`,
      description: content,
    });
  }
}

async function scanKnowledges(
  projectPath: string,
  components: Component[],
): Promise<void> {
  const knowledgesDir = join(projectPath, ".claude", "knowledges");
  if (!(await dirExists(knowledgesDir))) return;

  for await (const entry of Deno.readDir(knowledgesDir)) {
    if (!entry.name.endsWith(".md")) continue;
    const content = await readFileHead(
      join(knowledgesDir, entry.name),
      200,
    );
    const name = entry.name.replace(/\.md$/, "");
    components.push({
      id: `knowledge:${name}`,
      type: "knowledge",
      name,
      filePath: `.claude/knowledges/${entry.name}`,
      description: content,
    });
  }
}

async function scanSettings(
  projectPath: string,
  components: Component[],
): Promise<void> {
  const settingsPath = join(projectPath, ".claude", "settings.json");
  let settings: Record<string, unknown>;
  try {
    const raw = await Deno.readTextFile(settingsPath);
    settings = JSON.parse(raw);
  } catch {
    return;
  }

  // Hooks
  const hooks = settings.hooks as
    | Record<string, unknown[]>
    | undefined;
  if (hooks && typeof hooks === "object") {
    for (const [eventName, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) continue;
      for (let i = 0; i < matchers.length; i++) {
        const matcher = matchers[i] as Record<string, unknown>;
        const hookCmd = (matcher.command as string) || "unknown";
        components.push({
          id: `hook:${eventName}:${i}`,
          type: "hook",
          name: `${eventName} hook`,
          filePath: ".claude/settings.json",
          description: `Hook on ${eventName}: ${hookCmd}`.slice(0, 200),
        });
      }
    }
  }

  // MCP Servers
  const mcpServers = settings.mcpServers as
    | Record<string, unknown>
    | undefined;
  if (mcpServers && typeof mcpServers === "object") {
    for (const [serverName, config] of Object.entries(mcpServers)) {
      const cfg = config as Record<string, unknown>;
      const cmd = (cfg.command as string) || "";
      components.push({
        id: `mcp_server:${serverName}`,
        type: "mcp_server",
        name: serverName,
        filePath: ".claude/settings.json",
        description: `MCP server: ${serverName} (${cmd})`.slice(0, 200),
      });
    }
  }
}

async function scanOtherMd(
  projectPath: string,
  components: Component[],
): Promise<void> {
  const claudeMdPattern = /^CLAUDE.*\.md$/i;
  const skipFiles = new Set(["SPEC.md", "idea.md"]);

  for await (const entry of Deno.readDir(projectPath)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (claudeMdPattern.test(entry.name)) continue;
    if (skipFiles.has(entry.name)) continue;

    const content = await readFileHead(
      join(projectPath, entry.name),
      200,
    );
    const name = entry.name.replace(/\.md$/, "");
    components.push({
      id: `other_md:${name}`,
      type: "other_md",
      name,
      filePath: entry.name,
      description: content,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

async function readFileHead(path: string, maxChars: number): Promise<string> {
  try {
    const content = await Deno.readTextFile(path);
    return content.slice(0, maxChars).trim();
  } catch {
    return "";
  }
}

async function* walkGlob(
  dir: string,
  pattern: RegExp,
): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && pattern.test(entry.name)) {
        yield entry.name;
      }
    }
  } catch {
    // Directory doesn't exist
  }
}
