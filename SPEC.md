# SPEC.md — claude-tenet

## Context

Markdown-based Claude agent projects (CLAUDE.md, skills, commands, agents, hooks) have no traditional test suite. There's no way to systematically verify that an agent behaves correctly across its full feature set. **claude-tenet** solves this by running adversarial simulations — a red team "user" pushes the agent to its limits, then a blue team analyst reads the session transcript, identifies issues, and fixes them. An orchestrator ("tenet") drives this loop across multiple rounds until coverage is achieved. Inspired by the movie Tenet (forward/backward) and Monte Carlo simulation (run many trials, find patterns).

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    TENET (Orchestrator)                  │
│                                                         │
│  1. Scan project → build Inventory                      │
│  2. Generate Mission (targeting uncovered components)    │
│  3. Launch Red Team ──────────────┐                     │
│  4. Launch Blue Team ◄────────────┤ (session file)      │
│  5. Read Blue Report, update coverage                   │
│  6. Report round results to stdout                      │
│  7. Loop to step 2 (or stop if done)                    │
└─────────────────────────────────────────────────────────┘

Red Team (1 Deno process, 2 SDK query() calls):
  ┌────────────┐     message relay     ┌────────────────┐
  │  Attacker  │ ◄──────────────────► │  Target Agent  │
  │  (no tools)│                       │  (full Claude  │
  │            │                       │   Code in cwd) │
  └────────────┘                       └────────────────┘
  Attacker sees only text.             Produces session JSONL.

Blue Team (1 SDK query() call):
  Reads session JSONL + project files → fixes issues → outputs BlueTeamReport JSON
```

### Execution Flow Per Round

1. **Tenet** scans the target project, builds/updates `Inventory`
2. **Tenet** generates a `Mission` targeting uncovered components
3. **Red Team** receives the mission, spawns Attacker + Target Agent, they converse
4. Red team finishes → session JSONL exists on disk → `RedTeamResult` returned
5. **Blue Team** receives session file path + mission context, analyzes + fixes → `BlueTeamReport` returned
6. **Tenet** updates coverage map, prints round report to stdout
7. If rounds remain and coverage incomplete → next round

---

## 2. CLI Interface

Single binary compiled via `deno compile`. User runs from their project directory.

```
tenet [options]

Options:
  -r, --rounds <n>          Number of competition rounds (default: 3)
  -e, --max-exchanges <n>   Max conversation turns per red team session (default: 15)
  -t, --target <path>       Target project path (default: cwd)
  -v, --verbose             Show full session transcripts in output
      --dry-run             Scan and generate first mission only, don't execute
      --help                Print usage
```

**Entry point**: `src/main.ts`
**Compile**: `deno compile --allow-all --output tenet src/main.ts`

---

## 3. Project Structure

```
claude-tenet/
├── deno.json
├── init.md
├── SPEC.md                    ← this file
│
├── src/
│   ├── main.ts                -- CLI entry, arg parsing, signal handling
│   ├── types.ts               -- All shared TypeScript interfaces
│   │
│   ├── tenet/
│   │   ├── orchestrator.ts    -- Main loop: scan → mission → red → blue → report
│   │   ├── scanner.ts         -- Filesystem scan → Inventory (no LLM needed)
│   │   ├── mission.ts         -- Generate Mission from coverage gaps (uses SDK)
│   │   └── coverage.ts        -- Track what's been tested across rounds
│   │
│   ├── red/
│   │   └── red-team.ts        -- Dual-SDK conversation loop (Attacker ↔ Target)
│   │
│   ├── blue/
│   │   ├── blue-team.ts       -- Blue team SDK invocation
│   │   └── session-reader.ts  -- Parse session JSONL → readable summary
│   │
│   └── utils/
│       ├── logger.ts          -- Structured stdout reporting
│       └── session-path.ts    -- Session file path helpers
│
└── prompts/
    ├── tenet.md               -- Orchestrator system prompt
    ├── red-team.md            -- Attacker system prompt
    └── blue-team.md           -- Blue team debugger system prompt
```

---

## 4. Data Schemas

All types live in `src/types.ts`.

### 4.1 Inventory (produced by scanner)

```typescript
interface Inventory {
  projectPath: string;
  scannedAt: string; // ISO timestamp
  components: Component[];
}

interface Component {
  id: string;           // e.g., "skill:product-lookup", "command:commit", "claude-md:main"
  type: ComponentType;
  name: string;
  filePath: string;     // relative to project root
  description: string;  // first ~200 chars or heading extracted from file
}

type ComponentType =
  | "claude_md"         // CLAUDE.md, CLAUDE.dev.md, CLAUDE.sdk.md
  | "skill"            // .claude/skills/*
  | "command"          // .claude/commands/*
  | "agent"            // .claude/agents/*
  | "knowledge"        // .claude/knowledges/*
  | "hook"             // hooks from settings.json
  | "mcp_server"       // MCP servers from settings.json
  | "other_md";        // other meaningful .md files
```

### 4.2 Mission (produced by tenet, consumed by red team)

```typescript
interface Mission {
  missionId: string;                // UUID
  round: number;
  objective: string;                // plain language primary goal
  targetComponents: string[];       // component IDs to exercise
  persona: string;                  // what kind of user to roleplay
  conversationStarters: string[];   // 2-3 example openers
  edgeCasesToProbe: string[];       // specific failure modes to attempt
  successCriteria: string[];        // what counts as tested
  estimatedTurns: number;
}
```

### 4.3 RedTeamResult (produced by red team)

```typescript
interface RedTeamResult {
  missionId: string;
  sessionId: string;
  sessionFilePath: string;          // absolute path to JSONL
  conversationTurns: number;
  durationMs: number;
  costUsd: number;
}
```

### 4.4 BlueTeamReport (structured output from blue team)

```typescript
interface BlueTeamReport {
  sessionId: string;
  missionId: string;

  conversationSummary: {
    totalTurns: number;
    totalToolCalls: number;
    skillsInvoked: string[];
    commandsInvoked: string[];
  };

  componentsTested: ComponentTestResult[];
  issuesFound: Issue[];
  fixesApplied: Fix[];
  recommendations: Recommendation[];
}

interface ComponentTestResult {
  componentId: string;
  wasInvoked: boolean;
  behaviorCorrect: boolean;
  notes: string;
}

interface Issue {
  issueId: string;
  severity: "critical" | "high" | "medium" | "low";
  category: IssueCategory;
  description: string;
  evidence: string;              // relevant excerpt from session
  rootCauseFile: string;         // which project file caused the issue
}

type IssueCategory =
  | "wasted_turns"               // unnecessary tool calls or detours
  | "wrong_skill"                // used the wrong skill
  | "missing_skill"              // should have triggered a skill but didn't
  | "hallucination"              // produced info not grounded in tool results
  | "prompt_gap"                 // CLAUDE.md / skill instructions unclear/missing
  | "error_recovery"             // handled an error poorly
  | "instruction_violation"      // violated explicit CLAUDE.md instruction
  | "excessive_tool_calls"       // far more tool calls than necessary
  | "knowledge_gap";             // lacked knowledge that should exist

interface Fix {
  fixId: string;
  issueId: string;               // references the issue
  filePath: string;
  changeType: "modified" | "created";
  description: string;
}

interface Recommendation {
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  requiresHumanReview: boolean;
}
```

### 4.5 CoverageState (maintained across rounds)

```typescript
interface CoverageState {
  components: Record<string, CoverageStatus>;  // keyed by component ID
  rounds: RoundSummary[];
}

interface CoverageStatus {
  covered: boolean;
  coveredInRound?: number;
  issueCount: number;
  fixCount: number;
}

interface RoundSummary {
  round: number;
  missionId: string;
  redResult: RedTeamResult;
  blueReport: BlueTeamReport;
  timestamp: string;
}
```

---

## 5. Red Team — Dual-SDK Conversation Loop

This is the core technical innovation. One Deno process hosts two concurrent `query()` calls connected by async message relay.

### SDK API (confirmed from type definitions)

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// query() accepts string OR AsyncIterable<SDKUserMessage> as prompt
const q: Query = query({
  prompt: string | AsyncIterable<SDKUserMessage>,
  options?: Options
});

// Query extends AsyncGenerator<SDKMessage, void>
// Control: q.interrupt(), q.return()
// No close() method — use return() to terminate
```

### Conversation Relay Pattern

```typescript
// Pseudocode for src/red/red-team.ts

async function runRedTeam(mission: Mission, targetPath: string, maxExchanges: number): Promise<RedTeamResult> {

  // Shared state
  let targetSessionId: string;
  let exchangeCount = 0;
  let finished = false;

  // Async queues connecting the two agents
  const toTarget: AsyncQueue<string> = new AsyncQueue();
  const toAttacker: AsyncQueue<string> = new AsyncQueue();

  // --- Attacker SDK (no tools, just talks) ---
  const attackerQuery = query({
    prompt: buildAttackerInputStream(mission, toAttacker, () => finished),
    options: {
      model: "claude-opus-4-6",
      systemPrompt: loadPrompt("prompts/red-team.md"),
      allowedTools: [],                          // NO tools
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,                     // ephemeral
      maxTurns: maxExchanges * 2,
    }
  });

  // --- Target Agent SDK (full Claude Code, target project) ---
  const targetQuery = query({
    prompt: buildTargetInputStream(toTarget, () => finished),
    options: {
      model: "claude-opus-4-6",
      cwd: targetPath,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],               // loads CLAUDE.md, skills, etc.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
    }
  });

  // --- Message relay ---
  // Process attacker output → push text to toTarget queue
  // Process target output → push text to toAttacker queue
  // Both run concurrently via Promise.allSettled()
  // When either produces a "result" message or maxExchanges reached → set finished = true

  // Capture targetSessionId from target's SDKSystemMessage (type: "system", subtype: "init")
  // Build and return RedTeamResult
}
```

**Key design decisions:**
- Attacker gets **zero tools** — purely conversational, simulates a real user
- Target Agent gets **full Claude Code preset** with project settings loaded — behaves exactly like a real session
- Attacker only sees the **text portion** of Target's responses (not tool use details)
- `persistSession: false` on Attacker (ephemeral), `true` on Target (session JSONL is the artifact)
- Both use `bypassPermissions` for unattended execution

### Async Input Generator

```typescript
// Yields SDKUserMessage objects on demand
async function* buildAttackerInputStream(
  mission: Mission,
  inbox: AsyncQueue<string>,
  isDone: () => boolean
): AsyncIterable<SDKUserMessage> {
  // First message: mission brief
  yield { type: "user", message: { role: "user", content: mission.objective + "\n\n" + formatMissionContext(mission) } };

  // Subsequent messages: target agent's responses relayed back
  while (!isDone()) {
    const text = await inbox.dequeue();
    if (!text) break;
    yield { type: "user", message: { role: "user", content: text } };
  }
}
```

---

## 6. Blue Team — Session Analysis & Fix

### Session Reader (`src/blue/session-reader.ts`)

Parses the raw JSONL into a token-efficient readable summary for the blue team prompt:

```typescript
interface ParsedSession {
  sessionId: string;
  turns: ParsedTurn[];
  toolsUsed: string[];       // deduplicated
  filesAccessed: string[];   // deduplicated
  errors: string[];
}

interface ParsedTurn {
  turnNumber: number;
  role: "user" | "assistant";
  text: string;
  toolCalls?: { name: string; inputSummary: string; outputSummary: string }[];
  timestamp: string;
}
```

Only extracts essential information from potentially large JSONL files (hundreds of lines). Tool call inputs/outputs are summarized to save tokens.

### Blue Team SDK Call

```typescript
const blueQuery = query({
  prompt: buildBlueTeamPrompt(parsedSession, mission, inventory),
  options: {
    model: "claude-opus-4-6",
    cwd: targetPath,
    systemPrompt: loadPrompt("prompts/blue-team.md"),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    outputFormat: { type: "json_schema", schema: BLUE_TEAM_REPORT_SCHEMA },
    maxTurns: 50,
  }
});
```

Blue team gets full tool access (Read, Edit, Write, Glob, Grep, Bash) because it needs to read project files and apply fixes.

---

## 7. Tenet Orchestrator

### Scanner (`src/tenet/scanner.ts`)

Pure filesystem scan — no LLM needed:

1. Glob `**/CLAUDE*.md` → claude_md components
2. List `.claude/skills/*/` directories → skill components (read SKILL.md for each)
3. List `.claude/commands/*.md` → command components
4. List `.claude/agents/*.md` → agent components
5. List `.claude/knowledges/*.md` → knowledge components
6. Parse `.claude/settings.json` → hooks and MCP server components
7. Glob other `*.md` files at root → other_md components

### Mission Generation (`src/tenet/mission.ts`)

Uses a single SDK `query()` call with structured output to generate creative missions:

```typescript
const missionQuery = query({
  prompt: buildMissionPrompt(inventory, coverageState, round),
  options: {
    model: "claude-opus-4-6",
    systemPrompt: loadPrompt("prompts/tenet.md"),
    outputFormat: { type: "json_schema", schema: MISSION_SCHEMA },
    persistSession: false,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 5,
  }
});
```

Input to mission generation: current inventory with coverage status + previous missions (to avoid repetition).

### Main Loop (`src/tenet/orchestrator.ts`)

```
for round 1..N:
  1. inventory = scan(targetPath)               // filesystem only, fast
  2. mission = generateMission(inventory, coverage, round)  // SDK call
  3. print(roundStartReport)
  4. redResult = runRedTeam(mission, targetPath) // dual-SDK
  5. blueReport = runBlueTeam(redResult, mission, inventory, targetPath) // SDK call
  6. updateCoverage(coverage, blueReport, round)
  7. print(roundCompleteReport)                  // stdout after EVERY round
```

### Coverage Tracking (`src/tenet/coverage.ts`)

After each blue team report:
- Mark `componentsTested[].componentId` as covered if `wasInvoked && behaviorCorrect`
- Increment `issueCount` and `fixCount` per component
- Components with `wasInvoked && !behaviorCorrect` remain uncovered (need retest after fix)

---

## 8. System Prompts

### 8.1 `prompts/tenet.md` — Orchestrator

**Role**: You generate testing missions for a red team that will converse with a Claude agent.

**Static content**:
- What constitutes a Claude agent project (CLAUDE.md, skills, commands, agents, hooks, MCP)
- How to interpret coverage data
- Rules for mission generation (focused scope, one primary objective, creative personas, avoid repetition)

**Dynamic context** (via prompt parameter):
- MODE: GENERATE_MISSION
- Current inventory JSON with coverage status
- Previous mission briefs (to avoid repetition)
- Round number

**Output**: Mission JSON (structured output)

### 8.2 `prompts/red-team.md` — Attacker

**Role**: You are a user interacting with a Claude agent. You do NOT know how it works internally.

**Static content**:
- Never reveal you are a testing agent
- Conversation tactics: start simple → escalate complexity, test ambiguity, test boundaries, test error recovery
- Self-termination rules: stop when success criteria met, stuck in loop, or exhausted test angles
- No tools allowed — you only type messages
- End naturally (e.g., "Thanks, that's all I need")

**Dynamic context** (via prompt parameter, as first message):
- Mission objective, target components, persona, conversation starters, edge cases, success criteria

**Output**: Natural conversation (no structured output). The session JSONL is the artifact.

### 8.3 `prompts/blue-team.md` — Debugger

**Role**: You are a debugging analyst. You read session transcripts and project files to find and fix issues.

**Static content**:
- Session JSONL format explanation (message types, how to trace conversation flow)
- Issue detection patterns: wasted turns, wrong/missing skill invocation, hallucination, prompt gaps, instruction violations, excessive tool calls, knowledge gaps
- Fix protocol: read before editing, minimal surgical fixes, never change agent personality
- Output format: BlueTeamReport JSON schema

**Dynamic context** (via prompt parameter):
- Parsed session transcript
- Mission that was given to red team
- Current inventory
- Project path

**Output**: BlueTeamReport JSON (structured output)

---

## 9. Reporter / Stdout Output

After **every round**, print a structured report to stdout:

```
═══════════════════════════════════════════════
  TENET — Round 2/5 Complete
═══════════════════════════════════════════════

  Mission: Test demand planning workflow with ambiguous product names
  Persona: Impatient logistics manager

  Red Team: 12 exchanges, 45.2s, $0.83
  Blue Team: 38 tool calls, $1.21

  Components Tested: 4
    ✓ skill:product-lookup — OK
    ✓ skill:forecast-data — OK
    ✗ command:commit — issue found (wrong_skill)
    - agent:debug-agent — not triggered

  Issues Found: 2
    [HIGH] wrong_skill: Agent used /commit when asked to save (command:commit)
    [LOW]  wasted_turns: 3 unnecessary Glob calls in forecast-data skill

  Fixes Applied: 1
    Modified: .claude/skills/commit/SKILL.md — clarified trigger conditions

  Coverage: 8/14 components (57%)
  Round Cost: $2.04 | Total Cost: $4.12
═══════════════════════════════════════════════
```

After all rounds, print a final summary with total coverage, total issues, total fixes, total cost.

---

## 10. Error Handling

- **AbortController**: Passed to all `query()` calls. `SIGINT` handler aborts gracefully.
- **SDK errors**: `SDKResultMessage` with subtype `error_max_turns`, `error_during_execution`, `error_max_budget_usd` → log warning, continue to blue team (partial sessions are still analyzable).
- **Session file missing**: If red team crashes before creating session → skip blue team for this round, report error, continue to next round.
- **Blue team structured output failure**: `error_max_structured_output_retries` → report raw output, continue.

---

## 11. Session Path Resolution

Session files live at `~/.claude/projects/{encodedPath}/{sessionId}.jsonl` where `encodedPath` replaces `/` with `-`:

```typescript
function getSessionFilePath(projectPath: string, sessionId: string): string {
  const encoded = projectPath.replace(/\//g, "-");
  const home = Deno.env.get("HOME")!;
  return `${home}/.claude/projects/${encoded}/${sessionId}.jsonl`;
}
```

The `sessionId` is captured from the Target Agent's `SDKSystemMessage` (type `"system"`, subtype `"init"`, field `session_id`).

---

## 12. What Tenet Scans (Target Project Structure)

A typical markdown-based Claude agent project:

```
target-project/
├── CLAUDE.md                    -- main agent personality & rules
├── CLAUDE.dev.md                -- dev-specific instructions (optional)
├── CLAUDE.sdk.md                -- SDK-specific instructions (optional)
├── .claude/
│   ├── settings.json            -- permissions, hooks, MCP servers
│   ├── skills/
│   │   └── product-lookup/
│   │       └── SKILL.md
│   ├── commands/
│   │   └── commit.md
│   ├── agents/
│   │   └── debug-agent.md
│   └── knowledges/
│       └── domain-knowledge.md
└── ... (business logic files)
```

---

## 13. Implementation Sequence

### Phase 1: Foundation
1. `src/types.ts` — all interfaces and types
2. `src/main.ts` — CLI skeleton with arg parsing and signal handling
3. `src/tenet/scanner.ts` — filesystem scan → Inventory
4. `src/utils/logger.ts` — stdout reporting functions
5. `src/utils/session-path.ts` — session file path helpers

### Phase 2: Prompts
6. `prompts/tenet.md` — orchestrator system prompt
7. `prompts/red-team.md` — attacker system prompt
8. `prompts/blue-team.md` — blue team system prompt

### Phase 3: Red Team
9. `src/red/red-team.ts` — dual-SDK conversation relay loop

### Phase 4: Blue Team
10. `src/blue/session-reader.ts` — JSONL parser
11. `src/blue/blue-team.ts` — blue team SDK invocation with structured output

### Phase 5: Orchestration
12. `src/tenet/mission.ts` — mission generation via SDK
13. `src/tenet/coverage.ts` — coverage tracking logic
14. `src/tenet/orchestrator.ts` — main loop tying everything together

### Phase 6: Polish
15. Error handling, graceful shutdown, edge cases
16. `deno compile` configuration and binary output
17. End-to-end test against `pg-logistics-agency`

---

## 14. Verification Plan

1. **Unit**: Scanner correctly identifies all component types from a sample project
2. **Integration**: Red team dual-SDK loop completes a 3-turn conversation
3. **Integration**: Blue team produces valid BlueTeamReport JSON from a real session file
4. **E2E**: Full `tenet --rounds 1 --target ../pg-logistics-agency` completes successfully
5. **E2E**: Multi-round (`--rounds 3`) shows coverage increasing across rounds
