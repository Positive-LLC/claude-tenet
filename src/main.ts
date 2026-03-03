import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import type { TenetConfig } from "./types.ts";
import { runTenet } from "./tenet/orchestrator.ts";
import { printBanner } from "./utils/logger.ts";

function printUsage(): void {
  console.log(`
Usage: tenet [options]

Adversarial testing framework for markdown-based Claude agent projects.

Options:
  -r, --rounds <n>          Number of competition rounds (default: 3)
  -e, --max-exchanges <n>   Max conversation turns per red team session (default: 3)
  -t, --target <path>       Target project path (default: cwd)
  -v, --verbose             Show full session transcripts in output
      --dry-run             Scan and generate first mission only, don't execute
      --help                Print usage
`);
}

function parseConfig(): TenetConfig {
  const args = parseArgs(Deno.args, {
    string: ["rounds", "r", "max-exchanges", "e", "target", "t"],
    boolean: ["verbose", "v", "dry-run", "help"],
    alias: {
      r: "rounds",
      e: "max-exchanges",
      t: "target",
      v: "verbose",
    },
  });

  if (args.help) {
    printUsage();
    Deno.exit(0);
  }

  const rounds = parseInt(String(args.rounds || "3"), 10);
  const maxExchanges = parseInt(
    String(args["max-exchanges"] || "3"),
    10,
  );
  const targetPath = String(args.target || Deno.cwd());
  const verbose = Boolean(args.verbose);
  const dryRun = Boolean(args["dry-run"]);

  if (isNaN(rounds) || rounds < 1) {
    console.error("Error: --rounds must be a positive integer");
    Deno.exit(1);
  }
  if (isNaN(maxExchanges) || maxExchanges < 1) {
    console.error("Error: --max-exchanges must be a positive integer");
    Deno.exit(1);
  }

  return { rounds, maxExchanges, targetPath, verbose, dryRun };
}

// ─── Main ───────────────────────────────────────────────────────────────────

const abortController = new AbortController();

Deno.addSignalListener("SIGINT", () => {
  console.log("\n  Received SIGINT, shutting down gracefully...");
  abortController.abort();
});

printBanner();
const config = parseConfig();

try {
  await runTenet(config, abortController);
} catch (error) {
  if (abortController.signal.aborted) {
    console.log("  Aborted by user.");
  } else {
    console.error(
      "  Fatal error:",
      error instanceof Error ? error.message : error,
    );
    Deno.exit(1);
  }
}
