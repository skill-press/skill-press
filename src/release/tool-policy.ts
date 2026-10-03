import { NATIVE_REVIEW_POLICY } from "./native-policy.js";

/** Reviewed server admission profile; never derive the interpreter from receipts. */
export const TOOL_REVIEW_POLICY = Object.freeze({
  ...NATIVE_REVIEW_POLICY,
  id: "skillpress.tool-review" as const,
  execution: "host-networked-model-isolated-python" as const,
  activationMeasurement: "harness-metadata-selection" as const,
  image: "python@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc" as const,
});
