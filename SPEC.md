# SPEC.md — claude-tenet

## Context

Markdown-based Claude agent projects (CLAUDE.md, skills, commands, agents, hooks) have no traditional test suite. There's no way to systematically verify that an agent behaves correctly across its full feature set. **claude-tenet** solves this by running adversarial simulations — a red team "user" pushes the agent to its limits, then a blue team analyst reads the session transcript, identifies issues, and fixes them. An orchestrator ("tenet") drives this loop across multiple rounds until coverage is achieved. Inspired by the movie Tenet (forward/backward) and Monte Carlo simulation (run many trials, find patterns).

Tenet supports two test modes:
- **Integration test** (`tenet integration`): Tests whether the parent agent calls each component smoothly in an end-to-end session.
- **Unit test** (`tenet unit`): Isolates each component in a sandbox and pressure-tests it with edge cases, adversarial inputs, and boundary conditions.

---

## 1. Architecture Overview

### Integration Test Flow

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

### Unit Test Flow

```
┌─────────────────────────────────────────────────────────────┐
│                   TENET (Unit Orchestrator)                   │
│                                                             │
│  1. Scan project → build Inventory                          │
│  2. LLM Ownership Analysis → determine component owners     │
│  3. Build UnitTestPlan per component                        │
│  4. For each component:                                     │
│     a. Create sandbox (sibling dir)                         │
│     b. Populate sandbox (complete or focus setup)           │
│     c. For each round:                                      │
│        - Generate unit mission (deep behavioral testing)    │
│        - Red Team against sandbox (custom systemPrompt)     │
│        - Blue Team analyzes + fixes in sandbox              │
│        - Sync fixes back to original project                │
│     d. Cleanup sandbox                                      │
│  5. Final report                                            │
└─────────────────────────────────────────────────────────────┘
```

### Integration Execution Flow Per Round

1. **Tenet** scans the target project, builds/updates `Inventory`
2. **Tenet** generates a `Mission` targeting uncovered components
3. **Red Team** receives the mission, spawns Attacker + Target Agent, they converse
4. Red team finishes → session JSONL exists on disk → `RedTeamResult` returned
5. **Blue Team** receives session file path + mission context, analyzes + fixes → `BlueTeamReport` returned
6. **Tenet** updates coverage map, prints round report to stdout
7. If rounds remain and coverage incomplete → next round

### Unit Execution Flow

1. **Tenet** scans project → `Inventory`
2. **LLM Ownership Analysis** — a dedicated SDK call determines which agent owns each tool component and what dependencies it needs
3. **Build UnitTestPlans** — one plan per component with setup type (complete/focus), system prompt source, and components to copy
4. **Per component**: create isolated sandbox → run N rounds of mission generation + red team + blue team → sync fixes → cleanup sandbox
5. MCP servers are skipped (cannot be unit tested in isolation)

---

## 2. CLI Interface

Single binary compiled via `deno compile`. User runs from their project directory.

```
tenet <command> [options]

Commands:
  integration    Integration test — does the parent agent call components smoothly? (default)
  unit           Unit test — does each component handle diverse scenarios correctly?

Options:
  -r, --rounds <n>          Number of competition rounds (default: 3)
  -e, --max-exchanges <n>   Max conversation turns per red team session (default: 3)
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
│   ├── main.ts                -- CLI entry, subcommand parsing, signal handling
│   ├── types.ts               -- All shared TypeScript interfaces
│   ├── prompts.ts             -- Load prompt files at module init
│   │
│   ├── tenet/
│   │   ├── orchestrator.ts    -- Integration test loop: scan → mission → red → blue → report
│   │   ├── unit-orchestrator.ts -- Unit test loop: scan → ownership → sandbox → rounds → sync
│   │   ├── scanner.ts         -- Filesystem scan → Inventory (no LLM needed)
│   │   ├── mission.ts         -- Generate Mission from coverage gaps (uses SDK)
│   │   ├── coverage.ts        -- Track what's been tested across rounds
│   │   ├── sandbox.ts         -- Sandbox lifecycle: create, populate, cleanup, sync fixes
│   │   └── ownership.ts       -- LLM ownership analysis + UnitTestPlan builder
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
│       ├── multiselect.ts     -- Interactive component selection
│       ├── claude-path.ts     -- Claude executable path resolution
│       └── session-path.ts    -- Session file path helpers
│
└── prompts/
    ├── tenet.md               -- Orchestrator system prompt
    ├── red-team.md            -- Attacker system prompt
    ├── blue-team.md           -- Blue team debugger system prompt
    ├── ownership.md           -- Ownership analyzer system prompt
    └── unit-test.md           -- Unit test mission generator system prompt
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
  testMode?: TestMode;              // "integration" | "unit" (set for unit missions)
  setupType?: SetupType;            // "complete" | "focus" (unit test sandbox setup)
  systemPromptComponentId?: string; // component ID used as systemPrompt source
}

type TestMode = "integration" | "unit";
type SetupType = "complete" | "focus";
```

### 4.6 UnitTestPlan (produced by ownership analysis)

```typescript
interface UnitTestPlan {
  targetComponent: string;          // component ID to test
  setupType: SetupType;             // "complete" for CLAUDE.md, "focus" for tools
  systemPromptSource: string;       // component ID whose .md is the systemPrompt
  componentsToCopy: string[];       // component IDs to include in sandbox
  sandboxPath?: string;             // set at runtime
}
```

### 4.7 OwnershipResult (produced by LLM ownership analysis)

```typescript
interface OwnershipResult {
  assignments: OwnershipAssignment[];
}

interface OwnershipAssignment {
  componentId: string;
  ownerComponentId: string;         // which claude_md or agent owns this component
  componentsToCopy: string[];       // IDs of dependent components to include
  reasoning: string;
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
- In unit test mode, the target can receive a **custom systemPrompt** (e.g., a sub-agent's .md) instead of the `claude_code` preset
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

### Integration Loop (`src/tenet/orchestrator.ts`)

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

### Unit Test Loop (`src/tenet/unit-orchestrator.ts`)

```
1. inventory = scan(targetPath)
2. ownershipResult = analyzeOwnership(inventory)     // dedicated SDK call
3. plans = buildUnitTestPlans(inventory, ownershipResult)
4. for each plan (prioritized):
   a. sandbox = createSandbox(targetPath)
   b. populateSandbox(sandbox, plan)                 // complete or focus setup
   c. for round 1..N:
      - mission = generateUnitMission(plan, ...)     // SDK call, deep behavioral testing
      - redResult = runRedTeam(mission, sandbox, customSystemPrompt)
      - blueReport = runBlueTeam(redResult, mission, sandbox)
      - syncFixesBack(sandbox, targetPath, fixes)
      - updateCoverage(coverage, blueReport, round)
   d. cleanupSandbox(sandbox)
5. print(finalSummary)
```

### Sandbox (`src/tenet/sandbox.ts`)

All filesystem ops, no LLM. Creates a sibling folder next to the target project (`{parent}/.tenet-sandbox-{timestamp}/`).

- **Complete setup** (for CLAUDE.md): copies entire project structure (excluding .git, node_modules)
- **Focus setup** (for agents/tools): copies only listed components, preserving directory structure, plus .claude/settings.json

Fixes applied by blue team in the sandbox are synced back to the original project via `syncFixesBack()`.

### Ownership Analysis (`src/tenet/ownership.ts`)

A dedicated pre-processing SDK call that runs once before unit test rounds. Determines which agent owns each tool component.

- **Prompt**: Full content of all components, formatted for analysis
- **System prompt**: `prompts/ownership.md`
- **SDK options**: `tools: []`, structured output with `OWNERSHIP_SCHEMA`
- **Output**: `OwnershipResult` mapping each tool to its owner agent + dependencies
- **Fallback**: If SDK call fails, all tools default to CLAUDE.md ownership

Plan building rules:
- `claude_md` → complete setup, systemPrompt = self, copy all
- `agent` → focus setup, systemPrompt = self, copy all tools
- `skill/command/hook/knowledge/other_md` → focus setup, systemPrompt = owner from LLM, copy self + LLM-determined dependencies
- `mcp_server` → skip (no unit test)

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

In unit test mode, the blue team instructions are stricter: `behaviorCorrect=true` requires the component to handle ALL test scenarios correctly (including edge cases), not just be invoked.

### 8.4 `prompts/ownership.md` — Ownership Analyzer

**Role**: You analyze relationships between components in a Claude agent project to determine ownership.

**Static content**:
- How to determine ownership: explicit references, semantic domain, workflow context, default to CLAUDE.md
- How to determine dependencies: co-used components, referenced components, shared workflows
- Only produces assignments for tool-like components (skill, command, hook, knowledge, other_md)
- Skips MCP servers

**Dynamic context** (via prompt parameter):
- Full file content of every component (capped at 3000 chars each)
- List of all component IDs

**Output**: OwnershipResult JSON (structured output)

### 8.5 `prompts/unit-test.md` — Unit Test Mission Generator

**Role**: You generate missions for deep behavioral testing of individual components.

**Static content**:
- Depth over breadth: test ONE component thoroughly
- Edge cases & traps: ambiguous inputs, boundary conditions, adversarial inputs
- Behavioral correctness: component must produce correct output, follow its instructions
- Persona design: demanding, detail-oriented user who follows up

**Dynamic context** (via prompt parameter):
- Full content of the target component
- Coverage status, setup type, system prompt source
- Components in the sandbox

**Output**: Mission JSON (structured output) with exactly one targetComponent

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
2. `src/main.ts` — CLI skeleton with subcommand parsing and signal handling
3. `src/tenet/scanner.ts` — filesystem scan → Inventory
4. `src/utils/logger.ts` — stdout reporting functions
5. `src/utils/session-path.ts` — session file path helpers

### Phase 2: Prompts
6. `prompts/tenet.md` — orchestrator system prompt
7. `prompts/red-team.md` — attacker system prompt
8. `prompts/blue-team.md` — blue team system prompt
9. `prompts/ownership.md` — ownership analyzer system prompt
10. `prompts/unit-test.md` — unit test mission generator system prompt

### Phase 3: Red Team
11. `src/red/red-team.ts` — dual-SDK conversation relay loop (with optional custom systemPrompt)

### Phase 4: Blue Team
12. `src/blue/session-reader.ts` — JSONL parser
13. `src/blue/blue-team.ts` — blue team SDK invocation (stricter evaluation in unit mode)

### Phase 5: Integration Orchestration
14. `src/tenet/mission.ts` — mission generation via SDK
15. `src/tenet/coverage.ts` — coverage tracking logic
16. `src/tenet/orchestrator.ts` — integration test loop

### Phase 6: Unit Test Capability
17. `src/tenet/sandbox.ts` — sandbox lifecycle (create, populate, cleanup, sync)
18. `src/tenet/ownership.ts` — LLM ownership analysis + UnitTestPlan builder
19. `src/tenet/mission.ts` — unit mission generation (`generateUnitMission`)
20. `src/tenet/unit-orchestrator.ts` — unit test loop

### Phase 7: Polish
21. Error handling, graceful shutdown, edge cases
22. `deno compile` configuration and binary output
23. End-to-end tests

---

## 14. Verification Plan

1. **Unit**: Scanner correctly identifies all component types from a sample project
2. **Integration**: Red team dual-SDK loop completes a 3-turn conversation
3. **Integration**: Blue team produces valid BlueTeamReport JSON from a real session file
4. **E2E**: `tenet integration --rounds 1 --target ../pg-logistics-agency` completes successfully
5. **E2E**: Multi-round integration (`--rounds 3`) shows coverage increasing across rounds
6. **E2E**: `tenet unit --target ../pg-logistics-agency` creates sandbox per component, runs focused pressure tests, syncs fixes, cleans up
7. **Ownership**: Dedicated ownership SDK call produces sensible agent-tool assignments
8. **Sandbox**: Sandbox is created next to target and cleaned up after each component
9. **MCP skip**: MCP components are skipped in unit test mode
