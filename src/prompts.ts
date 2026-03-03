// Embed prompt files for compiled binary.
// When compiled with `deno compile --include prompts/`, files are accessible
// relative to import.meta.dirname. At dev time, they're read from the repo root.

import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

function getPromptsDir(): string {
  const dir = import.meta.dirname;
  if (!dir) throw new Error("Cannot resolve prompts directory");
  // src/prompts.ts -> go up one level to repo root, then into prompts/
  return resolve(dir, "..", "prompts");
}

function loadSync(filename: string): string {
  return Deno.readTextFileSync(resolve(getPromptsDir(), filename));
}

// Load once at module init
export const PROMPTS = {
  tenet: loadSync("tenet.md"),
  redTeam: loadSync("red-team.md"),
  blueTeam: loadSync("blue-team.md"),
} as const;
