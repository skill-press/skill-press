/** Public launch contract mirrored by the private registry validator. */
export const SERVER_REVIEW_POLICY = Object.freeze({
  id: "skillpress.server-review" as const,
  version: 1 as const,
  tesslVersion: "0.101.0" as const,
  trustedExecutableSetSha256:
    "1aa903f10c31339575eebde949bdd724dde13a7a8427b350641de599ba74515d" as const,
  qualityMinimum: 90 as const,
  impactMinimum: 90 as const,
  evidenceMaxAgeHours: 168 as const,
});
