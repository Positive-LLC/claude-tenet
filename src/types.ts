// ─── Component Types ────────────────────────────────────────────────────────

export type ComponentType =
  | "claude_md"
  | "skill"
  | "command"
  | "agent"
  | "knowledge"
  | "hook"
  | "mcp_server"
  | "other_md";

export const DEFAULT_TYPE_PRIORITY: Record<ComponentType, number> = {
  skill: 8,
  claude_md: 7,
  knowledge: 6,
  agent: 5,
  other_md: 4,
  hook: 3,
  command: 2,
  mcp_server: 1,
};

export const FIX_GUIDANCE: Partial<Record<IssueCategory, string[]>> = {
  missing_skill: [
    "The SKILL.md frontmatter `description` field is what the agent uses to decide whether to load a skill. If a skill was not invoked, the fix should target this `description` — make it clearly match the user intent/keywords that should trigger it. Do NOT fix the body of the SKILL.md or other files as the primary fix; the body is only seen after the skill is already loaded.",
  ],
};

export const MIN_OK_GUIDANCE: Partial<Record<ComponentType, string>> = {
  mcp_server:
    "As long as the MCP server was invoked and returned a result without error, " +
    "mark it as behaviorCorrect=true. There are too many tools to verify each one. " +
    "Only flag behaviorCorrect=false if the server produced an explicit error or failed to respond.",
};

export interface Component {
  id: string;
  type: ComponentType;
  name: string;
  filePath: string;
  description: string;
}

export interface PluginConfig {
  type: "local";
  path: string;
}

export interface Inventory {
  projectPath: string;
  scannedAt: string;
  components: Component[];
  plugins: PluginConfig[];
}

// ─── Mission ────────────────────────────────────────────────────────────────

export interface Mission {
  missionId: string;
  round: number;
  objective: string;
  targetComponents: string[];
  persona: string;
  conversationStarters: string[];
  edgeCasesToProbe: string[];
  successCriteria: string[];
  estimatedTurns: number;
  testMode?: TestMode;
  setupType?: SetupType;
  systemPromptComponentId?: string;
}

// ─── Red Team ───────────────────────────────────────────────────────────────

export interface RedTeamResult {
  missionId: string;
  sessionId: string;
  sessionFilePath: string;
  conversationTurns: number;
  durationMs: number;
  costUsd: number;
}

// ─── Blue Team ──────────────────────────────────────────────────────────────

export interface BlueTeamReport {
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

export interface ComponentTestResult {
  componentId: string;
  wasInvoked: boolean;
  behaviorCorrect: boolean;
  notes: string;
}

export type IssueCategory =
  | "wasted_turns"
  | "wrong_skill"
  | "missing_skill"
  | "hallucination"
  | "prompt_gap"
  | "error_recovery"
  | "instruction_violation"
  | "excessive_tool_calls"
  | "knowledge_gap";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Issue {
  issueId: string;
  severity: Severity;
  category: IssueCategory;
  description: string;
  evidence: string;
  rootCauseFile: string;
}

export interface Fix {
  fixId: string;
  issueId: string;
  filePath: string;
  changeType: "modified" | "created";
  description: string;
}

export interface Recommendation {
  description: string;
  priority: Severity;
  requiresHumanReview: boolean;
}

// ─── Coverage ───────────────────────────────────────────────────────────────

export interface CoverageState {
  components: Record<string, CoverageStatus>;
  rounds: RoundSummary[];
}

export interface CoverageStatus {
  covered: boolean;
  coveredInRound?: number;
  issueCount: number;
  fixCount: number;
}

export interface RoundSummary {
  round: number;
  missionId: string;
  missionObjective: string;
  redResult: RedTeamResult;
  blueReport: BlueTeamReport;
  timestamp: string;
}

// ─── Test Mode ──────────────────────────────────────────────────────────────

export type TestMode = "integration" | "unit";
export type SetupType = "complete" | "focus";

export interface UnitTestPlan {
  targetComponent: string;
  setupType: SetupType;
  systemPromptSource: string; // component ID whose .md is the systemPrompt
  componentsToCopy: string[]; // component IDs to include in sandbox
  sandboxPath?: string; // set at runtime
}

export interface OwnershipAssignment {
  componentId: string;
  ownerComponentId: string;
  componentsToCopy: string[];
  reasoning: string;
}

export interface OwnershipResult {
  assignments: OwnershipAssignment[];
}

// ─── CLI Config ─────────────────────────────────────────────────────────────

export interface TenetConfig {
  testMode: TestMode;
  rounds: number;
  maxExchanges: number;
  targetPath: string;
  verbose: boolean;
  dryRun: boolean;
}

// ─── JSON Schemas (for SDK structured output) ───────────────────────────────

export const MISSION_SCHEMA = {
  type: "object" as const,
  properties: {
    missionId: { type: "string" as const },
    round: { type: "number" as const },
    objective: { type: "string" as const },
    targetComponents: { type: "array" as const, items: { type: "string" as const } },
    persona: { type: "string" as const },
    conversationStarters: { type: "array" as const, items: { type: "string" as const } },
    edgeCasesToProbe: { type: "array" as const, items: { type: "string" as const } },
    successCriteria: { type: "array" as const, items: { type: "string" as const } },
    estimatedTurns: { type: "number" as const },
  },
  required: [
    "missionId",
    "round",
    "objective",
    "targetComponents",
    "persona",
    "conversationStarters",
    "edgeCasesToProbe",
    "successCriteria",
    "estimatedTurns",
  ],
  additionalProperties: false,
};

export const BLUE_TEAM_REPORT_SCHEMA = {
  type: "object" as const,
  properties: {
    sessionId: { type: "string" as const },
    missionId: { type: "string" as const },
    conversationSummary: {
      type: "object" as const,
      properties: {
        totalTurns: { type: "number" as const },
        totalToolCalls: { type: "number" as const },
        skillsInvoked: { type: "array" as const, items: { type: "string" as const } },
        commandsInvoked: { type: "array" as const, items: { type: "string" as const } },
      },
      required: ["totalTurns", "totalToolCalls", "skillsInvoked", "commandsInvoked"],
      additionalProperties: false,
    },
    componentsTested: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          componentId: { type: "string" as const },
          wasInvoked: { type: "boolean" as const },
          behaviorCorrect: { type: "boolean" as const },
          notes: { type: "string" as const },
        },
        required: ["componentId", "wasInvoked", "behaviorCorrect", "notes"],
        additionalProperties: false,
      },
    },
    issuesFound: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          issueId: { type: "string" as const },
          severity: { type: "string" as const, enum: ["critical", "high", "medium", "low"] },
          category: {
            type: "string" as const,
            enum: [
              "wasted_turns", "wrong_skill", "missing_skill", "hallucination",
              "prompt_gap", "error_recovery", "instruction_violation",
              "excessive_tool_calls", "knowledge_gap",
            ],
          },
          description: { type: "string" as const },
          evidence: { type: "string" as const },
          rootCauseFile: { type: "string" as const },
        },
        required: ["issueId", "severity", "category", "description", "evidence", "rootCauseFile"],
        additionalProperties: false,
      },
    },
    fixesApplied: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          fixId: { type: "string" as const },
          issueId: { type: "string" as const },
          filePath: { type: "string" as const },
          changeType: { type: "string" as const, enum: ["modified", "created"] },
          description: { type: "string" as const },
        },
        required: ["fixId", "issueId", "filePath", "changeType", "description"],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          description: { type: "string" as const },
          priority: { type: "string" as const, enum: ["critical", "high", "medium", "low"] },
          requiresHumanReview: { type: "boolean" as const },
        },
        required: ["description", "priority", "requiresHumanReview"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "sessionId", "missionId", "conversationSummary",
    "componentsTested", "issuesFound", "fixesApplied", "recommendations",
  ],
  additionalProperties: false,
};

export const OWNERSHIP_SCHEMA = {
  type: "object" as const,
  properties: {
    assignments: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          componentId: { type: "string" as const },
          ownerComponentId: { type: "string" as const },
          componentsToCopy: {
            type: "array" as const,
            items: { type: "string" as const },
          },
          reasoning: { type: "string" as const },
        },
        required: ["componentId", "ownerComponentId", "componentsToCopy", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["assignments"],
  additionalProperties: false,
};
