import { catalogResponseSchema } from "@openrift/shared/contracts/catalog";
import { initResponseSchema } from "@openrift/shared/contracts/init";

import { readSyncState, writeCatalogSync } from "../../db/catalog-sync-writer.js";
import { buildCatalogSync } from "../../db/catalog-sync.js";
import { createDb } from "../../db/connect.js";

// The live public catalog no longer sends the deprecated singular `type`.
// Supply that legacy storage field from the first canonical type, then retain
// strict upstream validation and its transactional writer for everything else.
export function normalizeCatalog(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("cards" in payload)) return payload;
  const data = payload as { cards: Record<string, { type?: string; types?: string[] }> };
  return {
    ...data,
    cards: Object.fromEntries(
      Object.entries(data.cards).map(([id, card]) => [
        id,
        { ...card, type: card.type ?? card.types?.[0] },
      ]),
    ),
  };
}
export async function syncCatalog(options: { allowHosted?: boolean; snapshot?: { init: unknown; catalog: unknown } } = {}) {
  const url = process.env.DATABASE_URL;
  const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  if (!url || (!local && !(options.allowHosted && process.env.RIFTER_DATABASE_PURPOSE === "rifter")))
    throw Error("Catalog sync requires an explicitly configured local database");
  const source = (process.env.CATALOG_SOURCE_URL || "https://openrift.app").replace(/\/$/u, "");
  if (!source.startsWith("https://")) throw Error("Catalog source must use verified HTTPS");
  const { db } = createDb(url);
  try {
    const state = await readSyncState(db);
    if (state.markerSource === null && (state.cards > 0 || state.ruleVersions > 0))
      throw Error("Refusing to overwrite an unmanaged catalog");
    if (state.markerSource !== null && state.markerSource !== source)
      throw Error("Catalog source changed; review required");
    const fetchJson = async (path: string) => {
      const response = await fetch(source + path, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error("Catalog request failed: " + response.status);
      return response.json();
    };
    const [rawInit, rawCatalog] = options.snapshot
      ? [options.snapshot.init, options.snapshot.catalog]
      : await Promise.all([fetchJson("/api/v1/init"), fetchJson("/api/v1/catalog")]);
    const rows = buildCatalogSync(
      initResponseSchema.parse(rawInit),
      catalogResponseSchema.parse(normalizeCatalog(rawCatalog)),
    );
    await writeCatalogSync(db, rows, source);
    console.log(
      `Catalog synchronized: ${rows.sets.length} sets, ${rows.cards.length} cards, ${rows.printings.length} printings. Personal data unchanged.`,
    );
  } finally {
    await db.destroy();
  }
}
if (import.meta.main) await syncCatalog();
