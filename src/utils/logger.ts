// ─── Verbose / Debug Logging ─────────────────────────────────────────────────

let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

/** Print a debug line only when --verbose is active. Prefixed with timestamp. */
export function debug(message: string): void {
  if (!_verbose) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`  [DEBUG ${ts}] ${message}`);
}

/** Return a timer function — call it to get elapsed ms string. */
export function startTimer(): () => string {
  const t0 = performance.now();
  return () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
}

export function printWarning(message: string): void {
  console.log(`  [WARN] ${message}`);
}
