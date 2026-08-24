/* Generated from schemas/package-provenance.schema.json. Do not edit by hand. */

/**
 * This interface was referenced by `SkillPressPackageProvenance`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;

export interface SkillPressPackageProvenance {
  schemaVersion: 1;
  provenanceType: "skillpress.package";
  project: {
    name: string;
    version: string;
    skillName: string;
  };
  sourceCommit: string;
  projectConfigSha256: Digest;
  skillSha256: Digest;
  tool: {
    name: "@mushanyoung/skillpress";
    version: string;
  };
  archive: {
    format: "zip";
    compression: "store";
    timestamp: "1980-01-01T00:00:00.000Z";
    ordering: "utf8-bytewise";
    regularMode: "0644";
    executableMode: "0755";
  };
  /**
   * @minItems 2
   * @maxItems 2
   */
  artifacts: [
    {
      name: string;
      bytes: number;
      sha256: Digest;
      mediaType: "application/zip";
    },
    {
      name: string;
      bytes: number;
      sha256: Digest;
      mediaType: "application/zip";
    },
  ];
}
