import { TrustedInstallError } from "./errors.js";
import type { ExactSkillLocator } from "./types.js";

const LOCATOR_PATTERN =
  /^(?<namespace>[a-z0-9]+(?:-[a-z0-9]+)*)\/(?<skill>[a-z0-9]+(?:-[a-z0-9]+)*)@(?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isSkillPressName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && NAME_PATTERN.test(value);
}

export function isExactSemver(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && SEMVER_PATTERN.test(value);
}

/** Parse only a canonical namespace/name@exact-semver locator. */
export function parseExactSkillLocator(value: unknown): ExactSkillLocator {
  if (typeof value !== "string" || value.length > 258) {
    throw new TrustedInstallError(
      "locator_invalid",
      "A Skill Press locator must be namespace/skill@exact-semver.",
    );
  }
  const match = LOCATOR_PATTERN.exec(value);
  if (match?.groups === undefined) {
    throw new TrustedInstallError(
      "locator_invalid",
      "A Skill Press locator must be namespace/skill@exact-semver.",
    );
  }
  const namespace = match.groups.namespace;
  const skill = match.groups.skill;
  const version = match.groups.version;
  if (!isSkillPressName(namespace) || !isSkillPressName(skill) || !isExactSemver(version)) {
    throw new TrustedInstallError(
      "locator_invalid",
      "A Skill Press locator must use bounded canonical names and an exact version.",
    );
  }
  return Object.freeze({ locator: value, namespace, skill, version });
}

export function releaseApiPath(locator: ExactSkillLocator): string {
  return `${encodeURIComponent(locator.namespace)}/${encodeURIComponent(locator.skill)}/${encodeURIComponent(locator.version)}`;
}
