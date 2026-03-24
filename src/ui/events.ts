import type {
  BlueTeamReport,
  CoverageState,
  Inventory,
  Mission,
  OwnershipAssignment,
  RedTeamResult,
  TaskResult,
} from "../types.ts";

// ─── Event Definitions ──────────────────────────────────────────────────────

export type UIEvent =
  // Simple status messages (replaces inline console.log in orchestrators)
  | { type: "status"; message: string; spinner?: boolean }

  // Scan
  | { type: "scan-result"; inventory: Inventory }

  // Round lifecycle (single-worker integration mode)
  | { type: "round-start"; round: number; totalRounds: number; mission: Mission }
  | { type: "red-team-result"; result: RedTeamResult }
  | { type: "blue-team-result"; report: BlueTeamReport }
  | {
      type: "round-complete";
      round: number;
      totalRounds: number;
      mission: Mission;
      redResult: RedTeamResult;
      blueReport: BlueTeamReport;
      coverage: CoverageState;
      inventory: Inventory;
    }

  // Iteration lifecycle (multi-worker integration mode)
  | {
      type: "iteration-start";
      iteration: number;
      totalIterations: number;
      missions: Mission[];
      workerCount: number;
    }
  | { type: "worker-result"; workerId: number; result: TaskResult }
  | { type: "worker-phase"; workerId: number; phase: "red" | "blue" | "done" }
  | { type: "fix-phase-result"; appliedCount: number; totalProposed: number }
  | {
      type: "iteration-complete";
      iteration: number;
      totalIterations: number;
      results: TaskResult[];
      coverage: CoverageState;
      fixesApplied: number;
    }

  // Unit test batch lifecycle
  | {
      type: "unit-batch-start";
      iteration: number;
      componentIds: string[];
      totalRemaining: number;
    }
  | {
      type: "unit-batch-complete";
      iteration: number;
      results: UnitBatchResultItem[];
      coverage: CoverageState;
    }

  // Dry run
  | { type: "dry-run-mission"; mission: Mission }
  | { type: "dry-run-iteration-plan"; missions: Mission[] }

  // Summaries
  | { type: "final-summary"; coverage: CoverageState }
  | { type: "final-summary-v2"; coverage: CoverageState }

  // Ownership (unit mode dry run)
  | { type: "ownership-assignments"; assignments: OwnershipAssignment[] }

  // Errors and warnings
  | { type: "error"; context: string; error: unknown }
  | { type: "warning"; message: string };

// Matches the shape printUnitBatchComplete expects
export interface UnitBatchResultItem {
  plan: { targetComponent: string };
  redResult?: {
    conversationTurns: number;
    durationMs: number;
    costUsd: number;
  };
  blueReport?: {
    issuesFound: { length: number };
    fixesApplied: { length: number };
    conversationSummary: { totalToolCalls: number };
  };
}

// ─── Multi-Select Prompt ────────────────────────────────────────────────────

export interface MultiSelectOptions {
  title: string;
  hint: string;
  items: { label: string; value: string }[];
}

// ─── UI Interface ───────────────────────────────────────────────────────────

export interface TenetUI {
  emit(event: UIEvent): void;
  multiSelect(options: MultiSelectOptions): Promise<string[]>;
}
