export function getSessionFilePath(
  projectPath: string,
  sessionId: string,
): string {
  // Claude Code encodes project paths by replacing all non-alphanumeric chars with '-'
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, "-");
  const home = Deno.env.get("HOME")!;
  return `${home}/.claude/projects/${encoded}/${sessionId}.jsonl`;
}

export function generateSessionId(): string {
  return crypto.randomUUID();
}
