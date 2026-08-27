import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withPrivateProviderHome } from "../src/process/provider-home.js";

describe("private provider home", () => {
  it("overrides ambient credential paths and removes the private home after success", async () => {
    let observedHome = "";
    const value = await withPrivateProviderHome(
      { HOME: "/ambient", USERPROFILE: "C:\\ambient", PROVIDER_TOKEN: "secret" },
      async (environment) => {
        observedHome = environment.HOME as string;
        expect(observedHome).not.toBe("/ambient");
        expect(environment.USERPROFILE).toBe(observedHome);
        expect(environment.XDG_CONFIG_HOME).toBe(join(observedHome, "config"));
        expect(environment.XDG_DATA_HOME).toBe(join(observedHome, "data"));
        expect(environment.XDG_STATE_HOME).toBe(join(observedHome, "state"));
        expect(environment.XDG_CACHE_HOME).toBe(join(observedHome, "cache"));
        expect(environment.APPDATA).toBe(join(observedHome, "appdata", "roaming"));
        expect(environment.LOCALAPPDATA).toBe(join(observedHome, "appdata", "local"));
        expect(environment.PROVIDER_TOKEN).toBe("secret");
        if (process.platform !== "win32") {
          expect((await stat(observedHome)).mode & 0o777).toBe(0o700);
        }
        return "complete";
      },
    );

    expect(value).toBe("complete");
    await expect(access(observedHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the private home when the provider operation throws", async () => {
    let observedHome = "";
    await expect(
      withPrivateProviderHome({}, async (environment) => {
        observedHome = environment.HOME as string;
        throw new Error("provider failure");
      }),
    ).rejects.toThrow("provider failure");
    await expect(access(observedHome)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
