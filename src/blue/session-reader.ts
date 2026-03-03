const MAX_RAW_BYTES = 300 * 1024; // 300 KB

/**
 * Scans the first lines of a JSONL session file for the init message
 * and returns the session_id. Returns empty string if not found.
 */
export async function extractSessionId(filePath: string): Promise<string> {
  const raw = await Deno.readTextFile(filePath);
  const lines = raw.split("\n");
  const limit = Math.min(lines.length, 10);

  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        return msg.session_id as string;
      }
    } catch {
      continue;
    }
  }
  return "";
}

/**
 * Reads a JSONL session file. If under 300KB, returns it verbatim.
 * If over, applies head+tail truncation (first 40% + last 40% of lines)
 * with a truncation notice in between.
 */
export async function readSessionJSONL(filePath: string): Promise<string> {
  const raw = await Deno.readTextFile(filePath);

  if (new TextEncoder().encode(raw).byteLength <= MAX_RAW_BYTES) {
    return raw;
  }

  const lines = raw.split("\n");
  const headCount = Math.floor(lines.length * 0.4);
  const tailCount = Math.floor(lines.length * 0.4);
  const omitted = lines.length - headCount - tailCount;

  const head = lines.slice(0, headCount);
  const tail = lines.slice(lines.length - tailCount);
  const notice = JSON.stringify({
    type: "truncation_notice",
    message: `${omitted} lines omitted from middle of session`,
  });

  return [...head, notice, ...tail].join("\n");
}
