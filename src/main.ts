import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import type { TenetConfig, TestMode } from "./types.ts";
import { runTenet } from "./tenet/orchestrator.ts";
import { runUnitTenet } from "./tenet/unit-orchestrator.ts";
import { printBanner } from "./utils/logger.ts";

function printUsage(): void {
  console.log(`
Usage: tenet <command> [options]

Adversarial testing framework for markdown-based Claude agent projects.

Commands:
  integration    Integration test — does the parent agent call components smoothly?
  unit           Unit test — does each component handle diverse scenarios correctly?

Options:
  -r, --rounds <n>          Max iterations (default: 3)
  -e, --max-exchanges <n>   Max conversation turns per red team session (default: 3)
  -w, --workers <n>         Number of parallel workers per iteration (default: 1)
  -t, --target <path>       Target project path (default: cwd)
  -v, --verbose             Show full session transcripts in output
      --dry-run             Scan and generate missions only, don't execute
      --help                Print usage

Examples:
  tenet integration -t ./my-project -r 5 -w 3
  tenet unit -t ./my-project -r 3 -e 5
  tenet -t ./my-project                    # defaults to integration
`);
}

function parseConfig(): TenetConfig {
  const args = parseArgs(Deno.args, {
    string: ["rounds", "r", "max-exchanges", "e", "workers", "w", "target", "t"],
    boolean: ["verbose", "v", "dry-run", "help"],
    alias: {
      r: "rounds",
      e: "max-exchanges",
      w: "workers",
      t: "target",
      v: "verbose",
    },
  });

  if (args.help) {
    printUsage();
    Deno.exit(0);
  }

  // Parse subcommand from positional args
  const positional = args._ as string[];
  let testMode: TestMode = "integration";
  if (positional.length > 0) {
    const cmd = String(positional[0]);
    if (cmd === "unit" || cmd === "integration") {
      testMode = cmd;
    } else {
      console.error(`Error: unknown command "${cmd}". Use "integration" or "unit".`);
      printUsage();
      Deno.exit(1);
    }
  }

  const rounds = parseInt(String(args.rounds || "3"), 10);
  const maxExchanges = parseInt(
    String(args["max-exchanges"] || "3"),
    10,
  );
  const workers = parseInt(String(args.workers || "1"), 10);
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
  if (isNaN(workers) || workers < 1) {
    console.error("Error: --workers must be a positive integer");
    Deno.exit(1);
  }

  return { testMode, rounds, maxExchanges, targetPath, verbose, dryRun, workers };
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
  if (config.testMode === "unit") {
    await runUnitTenet(config, abortController);
  } else {
    await runTenet(config, abortController);
  }
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
