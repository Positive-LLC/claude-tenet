import type { Component, Fix, Inventory, UnitTestPlan } from "../types.ts";
import { join, dirname, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { copy } from "https://deno.land/std@0.224.0/fs/copy.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { debug } from "../utils/logger.ts";

/**
 * Create a sandbox directory as a sibling of the target project.
 */
export async function createSandbox(targetPath: string): Promise<string> {
  const parent = dirname(resolve(targetPath));
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const sandboxPath = join(parent, `.tenet-sandbox-${id}`);
  await Deno.mkdir(sandboxPath, { recursive: true });
  debug(`sandbox: created ${sandboxPath}`);
  return sandboxPath;
}

/**
 * Populate sandbox based on the test plan's setup type.
 *
 * - **complete**: Copy entire project structure (for CLAUDE.md testing)
 * - **focus**: Copy only listed components, preserving directory structure
 */
export async function populateSandbox(
  sandboxPath: string,
  targetPath: string,
  plan: UnitTestPlan,
  inventory: Inventory,
): Promise<void> {
  const absTarget = resolve(targetPath);

  if (plan.setupType === "complete") {
    debug(`sandbox: complete copy from ${absTarget} to ${sandboxPath}`);
    await copyProjectStructure(absTarget, sandboxPath);
  } else {
    debug(`sandbox: focus copy — ${plan.componentsToCopy.length} components`);
    // Always copy .claude directory structure basics
    await ensureDir(join(sandboxPath, ".claude"));

    // Copy settings.json if it exists (needed for hooks/MCP config)
    try {
      const settingsSrc = join(absTarget, ".claude", "settings.json");
      await Deno.stat(settingsSrc);
      await ensureDir(join(sandboxPath, ".claude"));
      await Deno.copyFile(settingsSrc, join(sandboxPath, ".claude", "settings.json"));
    } catch {
      // No settings.json
    }

    // Copy each listed component
    const componentMap = new Map(inventory.components.map((c) => [c.id, c]));
    for (const compId of plan.componentsToCopy) {
      const comp = componentMap.get(compId);
      if (!comp) {
        debug(`sandbox: component ${compId} not found in inventory, skipping`);
        continue;
      }
      await copyComponent(absTarget, sandboxPath, comp);
    }
  }
}

/**
 * Clean up sandbox directory.
 */
export async function cleanupSandbox(sandboxPath: string): Promise<void> {
  try {
    await Deno.remove(sandboxPath, { recursive: true });
    debug(`sandbox: cleaned up ${sandboxPath}`);
  } catch (err) {
    debug(`sandbox: cleanup failed — ${err}`);
  }
}

/**
 * Sync modified files from sandbox back to original project.
 */
export async function syncFixesBack(
  sandboxPath: string,
  targetPath: string,
  fixesApplied: Fix[],
): Promise<void> {
  const absTarget = resolve(targetPath);
  const absSandbox = resolve(sandboxPath);

  for (const fix of fixesApplied) {
    const relativePath = fix.filePath.startsWith("/")
      ? fix.filePath.slice(absSandbox.length + 1)
      : fix.filePath;

    const srcFile = join(absSandbox, relativePath);
    const destFile = join(absTarget, relativePath);

    try {
      await Deno.stat(srcFile);
      await ensureDir(dirname(destFile));
      await Deno.copyFile(srcFile, destFile);
      debug(`sandbox: synced fix ${relativePath} back to project`);
    } catch {
      debug(`sandbox: could not sync ${relativePath} — file not found in sandbox`);
    }
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

async function copyProjectStructure(
  src: string,
  dest: string,
): Promise<void> {
  // Copy key project files/dirs, skipping node_modules, .git, etc.
  const skipDirs = new Set([".git", "node_modules", ".tenet-sandbox"]);

  for await (const entry of Deno.readDir(src)) {
    if (skipDirs.has(entry.name)) continue;
    if (entry.name.startsWith(".tenet-sandbox")) continue;

    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory) {
      await copy(srcPath, destPath, { overwrite: true });
    } else if (entry.isFile) {
      await Deno.copyFile(srcPath, destPath);
    }
  }
}

async function copyComponent(
  projectPath: string,
  sandboxPath: string,
  component: Component,
): Promise<void> {
  const srcBase = join(projectPath, component.filePath);

  try {
    const stat = await Deno.stat(srcBase);

    if (stat.isDirectory) {
      // Component is a directory (e.g., skill folder)
      const destDir = join(sandboxPath, component.filePath);
      await copy(srcBase, destDir, { overwrite: true });
      debug(`sandbox: copied directory ${component.filePath}`);
    } else {
      // Component is a single file
      const destFile = join(sandboxPath, component.filePath);
      await ensureDir(dirname(destFile));
      await Deno.copyFile(srcBase, destFile);
      debug(`sandbox: copied file ${component.filePath}`);
    }
  } catch {
    // For skills, the filePath might be the parent dir (e.g., .claude/skills/my-skill)
    // Try copying the directory
    try {
      const dirPath = join(projectPath, component.filePath);
      const destDir = join(sandboxPath, component.filePath);
      await copy(dirPath, destDir, { overwrite: true });
      debug(`sandbox: copied component dir ${component.filePath}`);
    } catch {
      debug(`sandbox: could not copy ${component.id} (${component.filePath})`);
    }
  }
}
