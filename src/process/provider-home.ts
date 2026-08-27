import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run one provider operation with no access to ambient user-level credential directories. */
export async function withPrivateProviderHome<T>(
  providerEnvironment: Readonly<Record<string, string>>,
  operation: (environment: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "skill-press-provider-home-"));
  await chmod(home, 0o700);
  const environment = Object.freeze({
    ...providerEnvironment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    APPDATA: join(home, "appdata", "roaming"),
    LOCALAPPDATA: join(home, "appdata", "local"),
  });
  try {
    return await operation(environment);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
