/**
 * Resolves the path to the native `claude` binary.
 * Required because deno-compiled binaries can't use the SDK's bundled cli.js
 * (it resolves to a virtual path inside the compile temp dir that Node can't access).
 */
export function getClaudePath(): string {
  // Check if explicitly set via env var
  const envPath = Deno.env.get("CLAUDE_PATH");
  if (envPath) return envPath;

  // Look in common install locations
  const home = Deno.env.get("HOME") || "";
  const candidates = [
    `${home}/.local/bin/claude`,
    `/usr/local/bin/claude`,
    `/opt/homebrew/bin/claude`,
  ];

  for (const candidate of candidates) {
    try {
      Deno.statSync(candidate);
      return candidate;
    } catch {
      // continue
    }
  }

  // Fallback: try which
  try {
    const cmd = new Deno.Command("which", { args: ["claude"], stdout: "piped", stderr: "null" });
    const output = cmd.outputSync();
    const path = new TextDecoder().decode(output.stdout).trim();
    if (path) return path;
  } catch {
    // continue
  }

  throw new Error(
    "Could not find 'claude' binary. Install Claude Code or set CLAUDE_PATH env var.",
  );
}
