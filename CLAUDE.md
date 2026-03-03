# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

claude-tenet is an adversarial testing framework for markdown-based Claude agent projects. It runs competitive red team vs blue team simulations across multiple rounds to systematically test agent functionality and automatically fix issues found. Built with Deno and the Claude Agent SDK.

## Commands

```bash
# Type-check
deno task check

# Run directly
deno task start -- [options]

# Compile to binary
deno task compile

# Install binary to ~/.local/bin/tenet
make install

# CLI usage
tenet -t <target-project-path> -r <rounds> -e <max-exchanges> [--verbose] [--dry-run]
```

There is no test suite. Verify changes with `deno task check` for type-checking.

## Architecture

Three-layer agent system running in a loop of rounds:

1. **Orchestrator** (`src/tenet/`) — Manages the competition loop: scan → generate mission → run red team → run blue team → update coverage → report.
2. **Red Team** (`src/red/red-team.ts`) — Dual-SDK conversation relay. An "attacker" session (no tools, persona from `prompts/red-team.md`) generates adversarial user messages, which are relayed to a "target" session (full Claude Code running in the target project). Both sessions use `resume: sessionId` to maintain state across exchanges.
3. **Blue Team** (`src/blue/`) — Reads the target's JSONL session file, parses conversation turns and tool calls, then calls the SDK with a structured output schema to produce a `BlueTeamReport` (issues found, fixes applied, recommendations).

### Key modules

- `src/types.ts` — All shared interfaces and JSON schemas (Inventory, Mission, RedTeamResult, BlueTeamReport, CoverageState). Schemas are exported as `const` for SDK structured output.
- `src/tenet/scanner.ts` — Scans target project filesystem for components: CLAUDE.md files, `.claude/skills/`, `.claude/commands/`, `.claude/agents/`, `.claude/knowledges/`, hooks, MCP servers (from `.claude/settings.json`), and other root `.md` files.
- `src/tenet/mission.ts` — Generates missions via SDK structured output, targeting uncovered components. Falls back to a basic mission if LLM generation fails.
- `src/tenet/coverage.ts` — Tracks per-component coverage state (covered, issueCount, fixCount) and supports early exit when full coverage is achieved.
- `src/blue/session-reader.ts` — Parses JSONL session files from `~/.claude/projects/{encodedPath}/{sessionId}.jsonl`.
- `prompts/` — System prompts for each agent role (tenet.md, red-team.md, blue-team.md).

### Patterns

- All SDK calls use `AbortController` for graceful SIGINT handling.
- SDK structured output uses explicit JSON schemas from `types.ts` with `outputFormat`.
- Error handling degrades gracefully: SDK failures log warnings and continue to the next phase/round.
- The red team relay alternates between attacker and target SDK sessions, never giving the attacker access to tools or source code.
