import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import priceRegistryJson from "./price-registry.json" with { type: "json" };

export type PriceEntry = Readonly<{
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  effectiveFrom: string;
  snapshotId: string;
}>;

export type PriceRegistry = Readonly<{
  version: number;
  prices: readonly PriceEntry[];
}>;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- json import needs narrowing to PriceRegistry
const bundled: PriceRegistry = priceRegistryJson as unknown as PriceRegistry;

let overridesCache: readonly PriceEntry[] | undefined;
let overridesCacheDir: string | undefined;

function loadOverridesSyncInternal(directory: string): readonly PriceEntry[] {
  if (overridesCache !== undefined && overridesCacheDir === directory) return overridesCache;
  try {
    const raw = readFileSync(join(directory, "price-overrides.json"), "utf8");
    const parsed = JSON.parse(raw) as { prices?: PriceEntry[] };
    overridesCache = parsed.prices ?? [];
    overridesCacheDir = directory;
    return overridesCache;
  } catch {
    overridesCache = [];
    overridesCacheDir = directory;
    return overridesCache;
  }
}

export function clearPriceOverridesCache(): void {
  overridesCache = undefined;
  overridesCacheDir = undefined;
}

/** Resolve price for model at timestamp. Returns undefined when not in registry. */
export function getPrice(model: string, at: Date = new Date(), directory?: string): PriceEntry | undefined {
  const needle = at.toISOString();
  const candidates: readonly PriceEntry[] = directory ? [...loadOverridesSyncInternal(directory), ...bundled.prices] : bundled.prices;
  // Find latest effectiveFrom <= at for this model
  let best: PriceEntry | undefined;
  for (const entry of candidates) {
    if (entry.model !== model) continue;
    if (entry.effectiveFrom > needle) continue;
    if (best === undefined || entry.effectiveFrom > best.effectiveFrom) best = entry;
  }
  return best;
}

export function snapshotIdFor(model: string, at: Date = new Date(), directory?: string): string {
  return getPrice(model, at, directory)?.snapshotId ?? "price-unknown";
}

export function estimateCost(input: { model: string; inputTokens: number; outputTokens: number; at?: Date; directory?: string }): number {
  const price = getPrice(input.model, input.at, input.directory);
  if (!price) return 0;
  return (input.inputTokens * price.inputPerMillion + input.outputTokens * price.outputPerMillion) / 1_000_000;
}

/** Load overrides from ~/.rly/price-overrides.json if present (merged, not persisted to registry). */
export async function loadPriceOverrides(directory: string): Promise<readonly PriceEntry[]> {
  try {
    const raw = await readFile(join(directory, "price-overrides.json"), "utf8");
    const parsed = JSON.parse(raw) as { prices?: PriceEntry[] };
    overridesCache = parsed.prices ?? [];
    overridesCacheDir = directory;
    return overridesCache;
  } catch {
    overridesCache = [];
    overridesCacheDir = directory;
    return [];
  }
}
