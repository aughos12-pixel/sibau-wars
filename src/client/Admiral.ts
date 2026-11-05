/**
 * Sibau Wars has no ads. OpenFront loaded Admiral here (an ad-recovery
 * script that shows an "allow ads" popup to ad-blocker users); this stub
 * keeps the same API so callers compile, but never loads anything.
 */
export interface AdmiralMeasureResult {
  /** True when the visitor has an adblocker active. */
  adblocking?: boolean;
  subscribed?: boolean;
  /** True when the visitor has whitelisted this site in their blocker. */
  whitelisted?: boolean;
}

/** No-op: Sibau Wars never loads Admiral. */
export function loadAdmiral(): void {}

/** No-op: with no Admiral there is never a measurement to report. */
export function onAdmiralMeasured(
  _cb: (res: AdmiralMeasureResult) => void,
): void {}
