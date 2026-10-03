/** Native units are success fractions and percentage-point gain, not Tessl scores. */
export const NATIVE_REVIEW_POLICY = Object.freeze({
  id: "skillpress.native-review" as const,
  version: 1 as const,
  readinessMinimum: 90,
  minimumSuccessRate: 0.9,
  minimumImpactDelta: 0.1,
  minimumRepetitions: 3,
  evidenceMaxAgeHours: 168,
});
