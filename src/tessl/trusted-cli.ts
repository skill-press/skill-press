/**
 * Executable SHA-256 values extracted from Tessl's signed 0.101.0 release archives.
 * The corresponding archive hashes are published in the ECDSA-verified SHA256SUMS at
 * https://install.tessl.io/binaries/0.101.0/SHA256SUMS.
 */
const TRUSTED_EXECUTABLES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "0.101.0": new Set([
    "9494050a66ec8a6f3f82405f7d7c5afccbdc03c1a195a823e07b6bfc5dea2f6c", // darwin-arm64
    "a8a71b43399998cbafa787503c6a51b0e212e0c2883f5bcc2cf094d141d7993a", // darwin-x64
    "405aac95750048ec31c4026cf38b389442a6dbe5eecce9908a399c615e2ea386", // linux-arm64
    "316819d34dbf200f07c605abdceda2ae920581c26da51a5f21b93b56e2b1a6b2", // linux-arm64-musl
    "67b974938e244edf0e24523be84dcb55b56ef41c4813bf86be8715d7055a4e0e", // linux-x64
    "fd2cf07b81f408c648013b76e92b5e8eea1565f54dca46adeda0ec8cc6a59098", // linux-x64-musl
    "283d1df9bc8c6a12a5511979d6de5b1524703e7bd8cc99c77963ff29f4cd31ce", // win32-arm64-winget
    "4816ce6bea0188a3a61480e43807a0ffe588c114d224d027dcc2798d7bbd63b7", // win32-arm64
    "ed1c04bd0e2242f2950e14acec99bb20d33b946af792c8133049bd72a7734601", // win32-x64-winget
    "a922e16f58e223ddc5ef7d38f33138250548bc78b30668a27af9974159b12129", // win32-x64
  ]),
});

export function isTrustedTesslCli(version: string, executableSha256: string): boolean {
  return TRUSTED_EXECUTABLES[version]?.has(executableSha256) === true;
}
