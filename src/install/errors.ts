export type TrustedInstallErrorCode =
  | "artifact_invalid"
  | "artifact_oversized"
  | "artifact_unavailable"
  | "install_conflict"
  | "install_failed"
  | "install_path_unsafe"
  | "keyring_invalid"
  | "lock_invalid"
  | "lock_rollback"
  | "locator_invalid"
  | "registry_contract_invalid"
  | "registry_rejected"
  | "registry_unavailable"
  | "response_oversized"
  | "signature_invalid"
  | "trust_rejected";

/** A fail-closed installation error with a stable, non-secret diagnostic code. */
export class TrustedInstallError extends Error {
  readonly code: TrustedInstallErrorCode;

  constructor(code: TrustedInstallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrustedInstallError";
    this.code = code;
  }
}
