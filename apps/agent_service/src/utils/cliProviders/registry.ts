import type { CliProvider } from "@scheduling-agent/types";
import type { CliProviderAdapter } from "./types";
import { claudeAdapter } from "./claudeAdapter";
import { codexAdapter } from "./codexAdapter";

/**
 * Single source of truth for which CLI providers exist. Adding a new one
 * means: write the adapter, register it here, add the value to
 * `CliProvider` in @scheduling-agent/types, and (optionally) seed a
 * `run_<provider>_cli` tool.
 *
 * The cross-provider busy check pgreps every binary in this registry, so
 * registering an adapter is enough to put it under the lock automatically.
 */
const ADAPTERS: Record<CliProvider, CliProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function getCliAdapter(provider: CliProvider): CliProviderAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`Unknown CLI provider: ${provider}`);
  }
  return adapter;
}

/** Every provider's binary name — used by the busy-check pgrep loop. */
export const KNOWN_CLI_BINARIES: ReadonlyArray<{
  provider: CliProvider;
  binary: string;
}> = Object.values(ADAPTERS).map((a) => ({
  provider: a.name,
  binary: a.binary,
}));
