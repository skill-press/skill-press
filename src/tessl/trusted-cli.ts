/**
 * Executable SHA-256 values extracted from Tessl's signed 0.99.0 release archives.
 * The corresponding archive hashes are published in the ECDSA-verified SHA256SUMS at
 * https://install.tessl.io/binaries/0.99.0/SHA256SUMS.
 */
const TRUSTED_EXECUTABLES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "0.99.0": new Set([
    "60db8f2be553fd2221d097dca6f748f9372f54af42ad1329149ae4c180d7dd39", // darwin-arm64
    "0c4da3dafaddb97080d5e47078328c55284fbde48160c151a2b88b4137d701bf", // darwin-x64
    "91f5c3f36b2897337ba1266ea3f98df7dd06f4ffc456208b4cbe4ee0577dc317", // linux-arm64
    "318b668ad0ad693f8833531259db0bbddb2779d0b9d84c2fd340f6715fe15b47", // linux-arm64-musl
    "3d8a0b75d32c059199874193bc706d8ef26826e860a8882ef3648182918ba97e", // linux-x64
    "0c4b8dab2280eff86870d28bada8fc6cbc90305c2ad33ac4ef2bc7b618b5c6c4", // linux-x64-musl
    "010154d14b7c86ed10bf12f625aca1aaba958030ca2a6ad4dabcd6d97cbbdb6e", // win32-arm64
    "08be756cdc528b78fe02ab3d4c94fc6e2fbc2354fd1d9131c48129468ffa36eb", // win32-x64
  ]),
});

export function isTrustedTesslCli(version: string, executableSha256: string): boolean {
  return TRUSTED_EXECUTABLES[version]?.has(executableSha256) === true;
}
