import type { Component, ComponentType, Inventory, PluginConfig } from "../types.ts";
import { join, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { homedir } from "node:os";
import { debug, printWarning } from "../utils/logger.ts";

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

  // 6. Settings (hooks + MCP servers + plugins)
  const plugins = await scanSettings(absPath, components);

  // 7. Other root .md files
  await scanOtherMd(absPath, components);

  return {
    projectPath: absPath,
    scannedAt: new Date().toISOString(),
    components,
    plugins,
  };
}

async function scanClaudeMd(
  projectPath: string,
  components: Component[],
): Promise<void> {
  for await (const entry of walkGlob(projectPath, /^CLAUDE\.md$/i)) {
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
): Promise<PluginConfig[]> {
  const settingsPath = join(projectPath, ".claude", "settings.json");
  let settings: Record<string, unknown>;
  try {
    const raw = await Deno.readTextFile(settingsPath);
    settings = JSON.parse(raw);
  } catch {
    return [];
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

  // Plugins
  const plugins = await discoverPlugins(projectPath, settings, components);
  return plugins;
}

async function discoverPlugins(
  projectPath: string,
  settings: Record<string, unknown>,
  components: Component[],
): Promise<PluginConfig[]> {
  // 1. Merge enabledPlugins from settings.json and settings.local.json
  const enabledKeys = new Set<string>();

  const mainEnabled = settings.enabledPlugins as Record<string, boolean> | undefined;
  if (mainEnabled && typeof mainEnabled === "object") {
    for (const [key, val] of Object.entries(mainEnabled)) {
      if (val) enabledKeys.add(key);
    }
  }

  // Read settings.local.json for additional enabledPlugins
  const localSettingsPath = join(projectPath, ".claude", "settings.local.json");
  try {
    const raw = await Deno.readTextFile(localSettingsPath);
    const localSettings = JSON.parse(raw) as Record<string, unknown>;
    const localEnabled = localSettings.enabledPlugins as Record<string, boolean> | undefined;
    if (localEnabled && typeof localEnabled === "object") {
      for (const [key, val] of Object.entries(localEnabled)) {
        if (val) enabledKeys.add(key);
      }
    }
  } catch {
    // No local settings file
  }

  debug(`plugins: enabled keys from settings: [${[...enabledKeys].join(", ")}]`);

  if (enabledKeys.size === 0) {
    debug(`plugins: no enabledPlugins found in settings files`);
    return [];
  }

  // 2. Read installed_plugins.json
  const home = homedir();
  if (!home) {
    debug(`plugins: could not determine home directory`);
    return [];
  }
  const installedPath = join(home, ".claude", "plugins", "installed_plugins.json");

  let installedData: {
    plugins: Record<string, Array<{
      scope: string;
      installPath: string;
      projectPath?: string;
    }>>;
  };
  try {
    const raw = await Deno.readTextFile(installedPath);
    installedData = JSON.parse(raw);
    debug(`plugins: loaded installed_plugins.json — ${Object.keys(installedData.plugins || {}).length} installed keys`);
  } catch {
    debug(`plugins: could not read ${installedPath}`);
    return [];
  }

  if (!installedData.plugins || typeof installedData.plugins !== "object") {
    debug(`plugins: installed_plugins.json has no plugins object`);
    return [];
  }

  // 3. Match enabled keys against installed entries
  const pluginConfigs: PluginConfig[] = [];
  const absProjectPath = resolve(projectPath);

  for (const [installedKey, entries] of Object.entries(installedData.plugins)) {
    if (!Array.isArray(entries)) continue;

    // Check if this installed key matches any enabled key
    // Match: exact match OR name prefix (before @) matches an enabled key without registry
    const namePrefix = installedKey.split("@")[0];
    const isEnabled = enabledKeys.has(installedKey) ||
      enabledKeys.has(namePrefix);

    if (!isEnabled) {
      debug(`plugins: skipping installed key "${installedKey}" — not enabled`);
      continue;
    }

    for (const entry of entries) {
      // Scope filtering: local plugins must match project path
      if (entry.scope === "local" && entry.projectPath) {
        const entryProjectPath = resolve(entry.projectPath);
        if (entryProjectPath !== absProjectPath) {
          debug(`plugins: skipping "${installedKey}" (scope=local) — projectPath mismatch: ${entryProjectPath} !== ${absProjectPath}`);
          continue;
        }
      }

      if (!entry.installPath) {
        debug(`plugins: skipping "${installedKey}" — no installPath`);
        continue;
      }

      debug(`plugins: matched "${installedKey}" (scope=${entry.scope}) → ${entry.installPath}`);
      pluginConfigs.push({ type: "local", path: entry.installPath });

      // Extract granular sub-components (skills, commands, agents) from the plugin
      const before = components.length;
      await scanPluginContents(namePrefix, entry.installPath, components);
      if (components.length === before) {
        printWarning(`Plugin "${installedKey}" has no discoverable components (skills, commands, agents)`);
      }
    }
  }

  debug(`plugins: discovered ${pluginConfigs.length} plugin(s) total`);
  return pluginConfigs;
}

async function scanOtherMd(
  projectPath: string,
  components: Component[],
): Promise<void> {
  const claudeMdPattern = /^CLAUDE(\..*)?\.md$/i;
  const skipFiles = new Set(["README.md", "SPEC.md", "idea.md"]);

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

// ─── Plugin Contents Scanner ────────────────────────────────────────────────

async function scanPluginContents(
  pluginName: string,
  installPath: string,
  components: Component[],
): Promise<void> {
  // Read plugin.json for optional skills path override
  let skillsRelPath = "skills";
  const manifestPath = join(installPath, ".claude-plugin", "plugin.json");
  try {
    const raw = await Deno.readTextFile(manifestPath);
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    if (typeof manifest.skills === "string") {
      skillsRelPath = manifest.skills;
      debug(`plugin[${pluginName}]: skills path override from plugin.json: "${skillsRelPath}"`);
    }
  } catch {
    // No plugin.json or not readable — use defaults
  }

  // Scan skills
  const skillsDir = join(installPath, skillsRelPath);
  if (await dirExists(skillsDir)) {
    try {
      for await (const entry of Deno.readDir(skillsDir)) {
        if (!entry.isDirectory) continue;
        const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
        const description = await readFileHead(skillMdPath, 200);
        components.push({
          id: `skill:${pluginName}:${entry.name}`,
          type: "skill",
          name: `${pluginName}:${entry.name}`,
          filePath: `${skillsRelPath}/${entry.name}`,
          description,
        });
        debug(`plugin[${pluginName}]: found skill "${entry.name}"`);
      }
    } catch {
      // Could not read skills directory
    }
  }

  // Scan commands
  const commandsDir = join(installPath, "commands");
  if (await dirExists(commandsDir)) {
    try {
      for await (const entry of Deno.readDir(commandsDir)) {
        if (!entry.name.endsWith(".md")) continue;
        const cmdName = entry.name.replace(/\.md$/, "");
        const description = await readFileHead(join(commandsDir, entry.name), 200);
        components.push({
          id: `command:${pluginName}:${cmdName}`,
          type: "command",
          name: `${pluginName}:${cmdName}`,
          filePath: `commands/${entry.name}`,
          description,
        });
        debug(`plugin[${pluginName}]: found command "${cmdName}"`);
      }
    } catch {
      // Could not read commands directory
    }
  }

  // Scan agents
  const agentsDir = join(installPath, "agents");
  if (await dirExists(agentsDir)) {
    try {
      for await (const entry of Deno.readDir(agentsDir)) {
        if (!entry.name.endsWith(".md")) continue;
        const agentName = entry.name.replace(/\.md$/, "");
        const description = await readFileHead(join(agentsDir, entry.name), 200);
        components.push({
          id: `agent:${pluginName}:${agentName}`,
          type: "agent",
          name: `${pluginName}:${agentName}`,
          filePath: `agents/${entry.name}`,
          description,
        });
        debug(`plugin[${pluginName}]: found agent "${agentName}"`);
      }
    } catch {
      // Could not read agents directory
    }
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
