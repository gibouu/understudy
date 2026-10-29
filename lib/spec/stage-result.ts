/**
 * Every stage of the pipeline reports one of these. The UI renders Retry,
 * Skip (degraded defaults) and Use-sample from it, and Export zips whatever
 * is `done`.
 */
export type LedgerEntry = {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  seconds: number;
  /** priced from GET /v1/models?verbose=true when known */
  usd?: number;
  /** a Tavily call: the credits it reported and its id for support */
  credits?: number;
  request_id?: string;
};

export type StageResult<T> =
  | { status: "idle" }
  | { status: "running"; progress?: number; note?: string }
  | { status: "done"; value: T; warnings: string[]; ledger?: LedgerEntry[] }
  /** a failure still reports the calls it paid for (#106) */
  | { status: "failed"; message: string; retryable: boolean; ledger?: LedgerEntry[] };

export const idle = <T>(): StageResult<T> => ({ status: "idle" });
export const running = <T>(note?: string, progress?: number): StageResult<T> => ({
  status: "running",
  note,
  progress,
});
export const done = <T>(
  value: T,
  warnings: string[] = [],
  ledger?: LedgerEntry[],
): StageResult<T> => ({ status: "done", value, warnings, ledger });
export const failed = <T>(message: string, retryable = true, ledger?: LedgerEntry[]): StageResult<T> => ({
  status: "failed",
  message,
  retryable,
  ...(ledger && ledger.length > 0 ? { ledger } : {}),
});

export const STAGES = [
  "watch",
  "label",
  "compile",
  "interview",
  "ground",
  "saboteur",
  "rehearsal",
  "notes",
  "reshoot",
  "export",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  watch: "Watch",
  label: "Label",
  compile: "Compile",
  interview: "Interview",
  ground: "Ground",
  saboteur: "Saboteur",
  rehearsal: "Rehearsal",
  notes: "Notes",
  reshoot: "Reshoot",
  export: "Export",
};
