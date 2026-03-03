export function getSessionFilePath(
  projectPath: string,
  sessionId: string,
): string {
  const encoded = projectPath.replace(/\//g, "-");
  const home = Deno.env.get("HOME")!;
  return `${home}/.claude/projects/${encoded}/${sessionId}.jsonl`;
}

export function generateSessionId(): string {
  return crypto.randomUUID();
}
