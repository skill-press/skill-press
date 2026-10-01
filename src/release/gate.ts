import { checkNativeReleaseGate, type NativeReleaseGateReport } from "./native-evidence.js";
import {
  checkTesslReleaseGate,
  type TesslReleaseGateOptions,
  type TesslReleaseGateReport,
} from "./tessl-gate.js";

export interface ReleaseGateOptions extends TesslReleaseGateOptions {
  readonly provider?: "native";
}

export type ReleaseGateReport = NativeReleaseGateReport | TesslReleaseGateReport;

/** Explicit protocol selection; failed native checks never fall back to Tessl. */
export function checkReleaseGate(
  projectDirectory: string,
  options: ReleaseGateOptions,
): Promise<ReleaseGateReport> {
  return options.provider === "native"
    ? checkNativeReleaseGate(projectDirectory, options)
    : checkTesslReleaseGate(projectDirectory, options);
}
