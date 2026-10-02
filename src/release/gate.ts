import { checkNativeReleaseGate, type NativeReleaseGateReport } from "./native-evidence.js";
import {
  checkReviewedTextReleaseGate,
  type ReviewedTextReleaseGateReport,
} from "./reviewed-text-gate.js";
import {
  checkTesslReleaseGate,
  type TesslReleaseGateOptions,
  type TesslReleaseGateReport,
} from "./tessl-gate.js";

export interface ReleaseGateOptions extends TesslReleaseGateOptions {
  readonly provider?: "native" | "reviewed-text";
}

export type ReleaseGateReport =
  | NativeReleaseGateReport
  | ReviewedTextReleaseGateReport
  | TesslReleaseGateReport;

/** Explicit protocol selection; failed native checks never fall back to Tessl. */
export function checkReleaseGate(
  projectDirectory: string,
  options: ReleaseGateOptions,
): Promise<ReleaseGateReport> {
  if (options.provider === "reviewed-text")
    return checkReviewedTextReleaseGate(projectDirectory, options);
  return options.provider === "native"
    ? checkNativeReleaseGate(projectDirectory, options)
    : checkTesslReleaseGate(projectDirectory, options);
}
