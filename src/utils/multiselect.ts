/**
 * Interactive multi-select TUI component.
 * Uses raw terminal mode to capture keystrokes for arrow navigation and space toggling.
 * Scrollable viewport for long lists, Ctrl+C exits the process.
 */

const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const MAX_VISIBLE = 15;

interface MultiSelectItem {
  label: string;
  value: string;
}

interface MultiSelectOptions {
  title: string;
  hint: string;
  items: MultiSelectItem[];
}

function write(text: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(text));
}

function clearLines(count: number): void {
  write(`\r`); // move to start of current line
  // Move up to the first line
  if (count > 1) write(`${ESC}${count - 1}A`);
  // Clear from the first line downward
  for (let i = 0; i < count; i++) {
    write(`${ESC}2K`); // clear entire line
    if (i < count - 1) write(`${ESC}1B`); // move down
  }
  // Move back up to the first line
  if (count > 1) write(`${ESC}${count - 1}A`);
  write(`\r`);
}

function render(
  options: MultiSelectOptions,
  cursor: number,
  selected: Set<number>,
  scrollOffset: number,
): number {
  const lines: string[] = [];
  const total = options.items.length;
  const visible = Math.min(total, MAX_VISIBLE);

  lines.push(`  ${options.title}`);
  lines.push(`  ${options.hint}`);
  lines.push("");

  for (let vi = 0; vi < visible; vi++) {
    const i = scrollOffset + vi;
    const item = options.items[i];
    const pointer = i === cursor ? ">" : " ";
    const check = selected.has(i) ? "[x]" : "[ ]";
    const dim = i === cursor ? "" : "\x1b[2m";
    const reset = i === cursor ? "" : "\x1b[0m";
    lines.push(`  ${dim}${pointer} ${check} ${item.label}${reset}`);
  }

  // Scroll indicators
  if (total > MAX_VISIBLE) {
    const above = scrollOffset;
    const below = total - scrollOffset - visible;
    const indicator = [
      above > 0 ? `${above} more above` : "",
      below > 0 ? `${below} more below` : "",
    ].filter(Boolean).join(" · ");
    lines.push(`\x1b[2m  ${indicator}\x1b[0m`);
  }

  lines.push("");
  const count = selected.size;
  lines.push(
    count > 0
      ? `  ${count} selected — press Enter to confirm`
      : `  Select components or press Esc to skip`,
  );

  write(lines.join("\n"));
  return lines.length;
}

/** Read a single keypress from raw stdin. Returns the byte sequence. */
async function readKey(): Promise<Uint8Array> {
  const buf = new Uint8Array(8);
  const n = await Deno.stdin.read(buf);
  return n ? buf.subarray(0, n) : new Uint8Array();
}

/**
 * Show an interactive multi-select list.
 * - Up/Down (or j/k) to navigate
 * - Space to toggle selection
 * - Enter to confirm
 * - Esc or q to skip (select nothing)
 * - Ctrl+C to exit the process
 *
 * Returns the selected values (empty array = skip).
 */
export async function multiSelect(
  options: MultiSelectOptions,
): Promise<string[]> {
  if (options.items.length === 0) return [];

  // If stdin is not a TTY, fall back to selecting nothing
  if (!Deno.stdin.isTerminal()) return [];

  const total = options.items.length;
  let cursor = 0;
  let scrollOffset = 0;
  const selected = new Set<number>();
  let renderedLines = 0;

  write(HIDE_CURSOR);
  Deno.stdin.setRaw(true);

  try {
    // Initial render
    renderedLines = render(options, cursor, selected, scrollOffset);

    while (true) {
      const key = await readKey();
      if (key.length === 0) break;

      // Ctrl+C — exit immediately
      if (key[0] === 0x03) {
        clearLines(renderedLines);
        write(SHOW_CURSOR);
        Deno.stdin.setRaw(false);
        Deno.exit(130);
      }

      // Decode key
      const seq = new TextDecoder().decode(key);

      if (seq === "\r" || seq === "\n") {
        // Enter — confirm only when something is selected
        if (selected.size > 0) break;
      } else if (seq === "q" || seq === "\x1b" && key.length === 1) {
        // q or bare Esc — skip
        selected.clear();
        break;
      } else if (seq === " ") {
        // Space — toggle
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
      } else if (
        seq === `\x1b[A` || seq === "k" // Up arrow or k
      ) {
        cursor = cursor > 0 ? cursor - 1 : total - 1;
      } else if (
        seq === `\x1b[B` || seq === "j" // Down arrow or j
      ) {
        cursor = cursor < total - 1 ? cursor + 1 : 0;
      }

      // Keep cursor within the visible viewport
      const visible = Math.min(total, MAX_VISIBLE);
      if (cursor < scrollOffset) {
        scrollOffset = cursor;
      } else if (cursor >= scrollOffset + visible) {
        scrollOffset = cursor - visible + 1;
      }

      // Re-render
      clearLines(renderedLines);
      renderedLines = render(options, cursor, selected, scrollOffset);
    }
  } finally {
    Deno.stdin.setRaw(false);
    write(SHOW_CURSOR);
  }

  // Clear the interactive UI and print final state
  clearLines(renderedLines);

  const selectedItems = [...selected]
    .sort((a, b) => a - b)
    .map((i) => options.items[i]);

  if (selectedItems.length === 0) {
    console.log("  No priority set — all components will be tested equally.\n");
  } else {
    console.log(`  Priority components (${selectedItems.length}):`);
    for (const item of selectedItems) {
      console.log(`    > ${item.label}`);
    }
    console.log();
  }

  return selectedItems.map((item) => item.value);
}
