import { createHash } from "node:crypto";

import { legendDisplayName, normalizeNameForIdentity } from "@openrift/shared/card-name";
import type {
  RifterCandidate,
  RifterDestination,
  RifterImportRow,
  RifterPreviewRequest,
} from "@openrift/shared/contracts/rifter";
import postgres from "postgres";

import { parseInput } from "./parse.js";

// Parse-time warning kept separately so a review choice cannot erase it.
type StoredRow = RifterImportRow & { parseWarning?: string | null };
const MAX_PENDING_IMPORTS = 50;
const DISCARD_AFTER_DAYS = 30;
type DB = postgres.Sql | postgres.TransactionSql;
interface ImportRecord {
  id: string;
  user_id: string;
  status: string;
  revision: number;
  rows: StoredRow[];
  fingerprint: string;
  destination: RifterDestination;
  source: string;
  raw_input: string;
  format: string;
  warnings: string[];
}
export class RifterError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(message: string): never {
  throw new RifterError(409, message);
}
function jsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
export function createRifterService(databaseUrl: string) {
  const db = postgres(databaseUrl, { max: 5, prepare: false });
  async function transaction<T>(
    user: string,
    label: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return (await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"rifter:" + user},0))`;
      await tx`SELECT set_config('rifter.label',${label},true)`;
      return await fn(tx);
    })) as T;
  }
  async function authorize(sql: DB, user: string, destination: RifterDestination) {
    if (destination.kind === "new-deck") return;
    const rows =
      destination.kind === "collection"
        ? await sql`SELECT id FROM collections WHERE id=${destination.id} AND user_id=${user} AND group_id IS NULL`
        : await sql`SELECT id FROM decks WHERE id=${destination.id} AND user_id=${user}`;
    if (!rows.length) throw new RifterError(404, "Destination not found");
  }
  async function candidates(
    sql: DB,
    query: {
      code?: string;
      name?: string;
      finish?: string;
      language?: string;
      artVariant?: string;
    },
    search = false,
  ): Promise<RifterCandidate[]> {
    const code = query.code?.trim().toUpperCase() || null;
    const name = query.name?.trim() || null;
    const normalizedName = name ? normalizeNameForIdentity(name) : null;
    const found = await sql`
      SELECT p.id AS "printingId", c.id AS "cardId", c.name, f.short_code AS code,
        f.finish, f.language, f.art_variant AS "artVariant",c.type,c.tags
      FROM printings p JOIN faces f ON f.id=p.face1_id JOIN cards c ON c.id=f.card_id
      WHERE p.size='standard'
        AND (${code}::text IS NULL OR upper(f.short_code)=${code} OR upper(f.public_code)=${code})
        AND (${name}::text IS NULL OR CASE WHEN ${search} THEN position(lower(${name}) in lower(c.name||' '||array_to_string(c.tags,' ')))>0
          ELSE c.norm_name=${normalizedName} OR lower(coalesce(f.printed_name,''))=lower(${name})
          OR regexp_replace(lower(coalesce(c.tags[1],'')||c.name),'[^[:alnum:]]','','g')=${normalizedName}
          OR EXISTS(SELECT 1 FROM card_name_aliases a WHERE a.card_id=c.id AND a.norm_name=${normalizedName}) END)
        AND (${query.finish ?? null}::text IS NULL OR f.finish=${query.finish ?? null})
        AND (${query.language ?? null}::text IS NULL OR f.language=${query.language ?? null})
        AND (${query.artVariant ?? null}::text IS NULL OR f.art_variant=${query.artVariant ?? null})
      ORDER BY f.short_code,f.finish,f.language,p.id LIMIT 101`;
    if (found.length > 100 && !search) return []; // require a narrower explicit selection
    return found.slice(0, 100).map((value) => {
      const { type, tags, ...candidate } = value as unknown as RifterCandidate & {
        type: string;
        tags: string[];
      };
      return {
        ...candidate,
        name: legendDisplayName({ name: candidate.name, types: [type], tags }),
      };
    });
  }
  async function preview(user: string, input: RifterPreviewRequest) {
    await authorize(db, user, input.destination);
    let parsed: ReturnType<typeof parseInput>;
    try {
      parsed = parseInput(input.format, input.rawInput);
    } catch (error) {
      parsed = {
        rows: [],
        warnings: [
          "Input could not be parsed: " +
            (error instanceof Error ? error.message : "Invalid input") +
            ". Correct the source and create a new preview; no cards were changed.",
        ],
      };
    }
    const rows: StoredRow[] = [];
    for (const row of parsed.rows) {
      const found = await candidates(db, row);
      // Decks are gameplay identities unless a collector constraint was supplied.
      // Keep all choices visible; never guess a collection printing from a name.
      rows.push({
        input: row.input,
        quantity: row.quantity,
        zone: row.zone,
        condition: row.condition,
        metadata: row.metadata,
        candidates: found,
        printingId: found.length === 1 ? found[0]!.printingId : null,
        excluded: false,
        parseWarning: row.warning ?? null,
        warning:
          row.warning ??
          (found.length
            ? found.length > 1
              ? "Choose a printing"
              : null
            : "No exact catalog match; search and resolve or exclude this row"),
      });
    }
    const fingerprint = createHash("sha256")
      .update(input.format + "\n" + input.rawInput.trim().replace(/\r\n/gu, "\n"))
      .digest("hex");
    return await transaction(user, "Quarantine import", async (tx) => {
      // Prune stale discarded drafts, then cap unconfirmed drafts per user.
      await tx`DELETE FROM rifter_imports WHERE user_id=${user} AND status='pending' AND created_at < now() - make_interval(days => ${DISCARD_AFTER_DAYS})`;
      const [pending] =
        await tx`SELECT count(*)::int AS n FROM rifter_imports WHERE user_id=${user} AND status='pending'`;
      if ((pending?.n ?? 0) >= MAX_PENDING_IMPORTS)
        throw new RifterError(
          429,
          `Too many unconfirmed imports (limit ${MAX_PENDING_IMPORTS}); apply or discard some first`,
        );
      const [item] =
        await tx`INSERT INTO rifter_imports(user_id,raw_input,source,fingerprint,format,destination,rows,warnings)
        VALUES(${user},${input.rawInput},${input.source},${fingerprint},${input.format},${tx.json(input.destination)},${tx.json(jsonValue(rows))},${tx.json(parsed.warnings)}) RETURNING *`;
      return item;
    });
  }
  async function getImport(sql: DB, user: string, id: string, lock = false) {
    const records = lock
      ? await sql<
          ImportRecord[]
        >`SELECT * FROM rifter_imports WHERE id=${id} AND user_id=${user} FOR UPDATE`
      : await sql<ImportRecord[]>`SELECT * FROM rifter_imports WHERE id=${id} AND user_id=${user}`;
    if (!records.length) throw new RifterError(404, "Import not found");
    return records[0]!;
  }
  async function review(
    user: string,
    id: string,
    input: {
      revision: number;
      choices: {
        index: number;
        printingId: string | null;
        excluded: boolean;
        zone?: string;
        condition?: string | null;
      }[];
    },
  ) {
    return await transaction(user, "Review import", async (tx) => {
      const item = await getImport(tx, user, id, true);
      if (item.status !== "pending" || item.revision !== input.revision)
        fail("Import changed; reload before reviewing");
      const rows: StoredRow[] = item.rows;
      if (new Set(input.choices.map((c) => c.index)).size !== input.choices.length)
        fail("Duplicate review row");
      for (const choice of input.choices) {
        const row = rows[choice.index];
        if (!row) fail("Unknown review row");
        row.excluded = choice.excluded;
        if (choice.printingId) {
          // Explicit resolution may select a different search result, but it must
          // be a real standard printing; no arbitrary client-supplied card IDs.
          const found =
            await tx`SELECT p.id AS "printingId",c.id AS "cardId",c.name,f.short_code AS code,f.finish,f.language,f.art_variant AS "artVariant"
            FROM printings p JOIN faces f ON f.id=p.face1_id JOIN cards c ON c.id=f.card_id WHERE p.id=${choice.printingId} AND p.size='standard'`;
          if (!found.length) fail("Printing no longer exists");
          if (!row.candidates.some((c) => c.printingId === choice.printingId))
            row.candidates.push(found[0] as unknown as RifterCandidate);
        }
        row.printingId = choice.printingId;
        // A zone change is the user's answer to an "Unknown section" warning.
        if (choice.zone && choice.zone !== row.zone) row.parseWarning = null;
        if (choice.zone) row.zone = choice.zone;
        if (choice.condition !== undefined) row.condition = choice.condition;
        row.warning = choice.excluded
          ? "Explicitly excluded"
          : row.parseWarning
            ? row.parseWarning
            : choice.printingId
            ? null
            : "Unresolved";
        if (
          !row.excluded &&
          row.condition &&
          !(await tx`SELECT slug FROM conditions WHERE slug=${row.condition}`).length
        )
          row.warning =
            "Unrecognized condition; choose a valid condition or explicitly mark it unrecorded";
      }
      const [updated] =
        await tx`UPDATE rifter_imports SET rows=${tx.json(jsonValue(rows))},revision=revision+1 WHERE id=${id} RETURNING *`;
      return updated;
    });
  }
  async function confirm(
    user: string,
    id: string,
    input: { revision: number; acknowledgeDuplicate: boolean },
  ) {
    return await transaction(user, "Apply import / acquisition", async (tx) => {
      const item = await getImport(tx, user, id, true);
      if (item.status === "applied") return { id, status: "applied", alreadyApplied: true };
      if (item.revision !== input.revision) fail("Import changed; reload before confirming");
      const duplicates =
        await tx`SELECT id FROM rifter_imports WHERE user_id=${user} AND fingerprint=${item.fingerprint} AND status='applied' AND id<>${id}`;
      if (duplicates.length && !input.acknowledgeDuplicate)
        fail("This input was applied before. Explicit duplicate acknowledgement required.");
      const destination = item.destination as RifterDestination;
      await authorize(tx, user, destination);
      const rows = (item.rows as RifterImportRow[]).filter((r) => !r.excluded);
      if (
        !rows.length ||
        rows.some(
          (r) =>
            !r.printingId || r.warning || !r.candidates.some((c) => c.printingId === r.printingId),
        )
      )
        fail("Resolve or explicitly exclude every row before confirming");
      // Reject stale catalog references before any target changes.
      const ids = rows.map((r) => r.printingId!);
      const existing = await tx`SELECT id FROM printings WHERE id IN ${tx(ids)} FOR SHARE`;
      if (new Set(existing.map((p) => p.id)).size !== new Set(ids).size)
        fail("Catalog changed; review again");
      let deckId: string | null = null;
      if (destination.kind === "collection") {
        // Copy metadata constraints are enforced by PostgreSQL in the same transaction.
        if (destination.mode === "replace")
          await tx`DELETE FROM copies WHERE collection_id=${destination.id}`;
        for (const row of rows) {
          await tx`INSERT INTO copies(collection_id,printing_id,condition,grader,grade,is_altered,notes_public,notes_private,links)
            SELECT ${destination.id},${row.printingId},${row.condition},${row.metadata.grader ?? null},${row.metadata.grade ?? null},
              ${row.metadata.isAltered ?? false},${row.metadata.notesPublic ?? null},${row.metadata.notesPrivate ?? null},${tx.json(row.metadata.links ?? [])}
            FROM generate_series(1,${row.quantity})`;
        }
      } else {
        if (destination.kind === "new-deck") {
          const [deck] =
            await tx`INSERT INTO decks(user_id,name,format) VALUES(${user},${destination.name},'constructed') RETURNING id`;
          deckId = deck!.id;
          await tx`INSERT INTO rifter_deck_state(id,status,source) VALUES(${deckId},${destination.status},${item.source})`;
        } else {
          deckId = destination.id;
          if (destination.mode === "replace")
            await tx`DELETE FROM deck_cards WHERE deck_id=${deckId}`;
        }
        for (const row of rows) {
          const selected = row.candidates.find((c) => c.printingId === row.printingId)!;
          // The schema's unique key is (deck_id,card_id,zone).
          await tx`INSERT INTO deck_cards(deck_id,card_id,zone,quantity,preferred_printing_id)
            VALUES(${deckId},${selected.cardId},${row.zone},${row.quantity},${row.printingId})
            ON CONFLICT(deck_id,card_id,zone,preferred_printing_id) DO UPDATE SET quantity=deck_cards.quantity+EXCLUDED.quantity`;
        }
      }
      const [action] =
        await tx`SELECT id FROM rifter_actions WHERE user_id=${user} AND transaction_id=pg_current_xact_id()`;
      await tx`UPDATE rifter_imports SET status='applied',applied_at=now(),applied_action_id=${action?.id ?? null},revision=revision+1 WHERE id=${id}`;
      return { id, status: "applied", deckId, actionId: action?.id };
    });
  }
  async function overview(user: string) {
    const collections =
      await db`SELECT c.id,c.name,count(cp.id)::int AS quantity FROM collections c LEFT JOIN copies cp ON cp.collection_id=c.id WHERE c.user_id=${user} AND c.group_id IS NULL GROUP BY c.id ORDER BY c.sort_order,c.name`;
    const decks =
      await db`SELECT d.id,d.name,coalesce(s.status,'aspiring') AS status,coalesce(s.source,'') AS source FROM decks d LEFT JOIN rifter_deck_state s ON s.id=d.id WHERE d.user_id=${user} AND d.archived_at IS NULL ORDER BY d.name`;
    const imports =
      await db`SELECT id,source,format,destination,status,revision,created_at FROM rifter_imports WHERE user_id=${user} ORDER BY created_at DESC LIMIT 100`;
    const actions =
      await db`SELECT a.id,a.label,a.created_at,a.reverses,(SELECT id FROM rifter_actions r WHERE r.reverses=a.id) AS reversed_by,
      (SELECT count(*)::int FROM rifter_changes ch WHERE ch.action_id=a.id) AS changes FROM rifter_actions a WHERE user_id=${user} ORDER BY created_at DESC,id DESC LIMIT 100`;
    return { collections, decks, imports, actions };
  }
  async function gaps(user: string, deckId: string, sideboard: boolean, strict: boolean) {
    await authorize(db, user, { kind: "deck", id: deckId, mode: "add" });
    const rows = await db<
      {
        id: string;
        cardId: string;
        name: string;
        type: string;
        tags: string[];
        zone: string;
        quantity: number;
        preferredPrintingId: string | null;
      }[]
    >`SELECT dc.id,dc.card_id AS "cardId",c.name,c.type,c.tags,dc.zone,dc.quantity,dc.preferred_printing_id AS "preferredPrintingId"
      FROM deck_cards dc JOIN cards c ON c.id=dc.card_id WHERE dc.deck_id=${deckId} AND (${sideboard} OR dc.zone<>'sideboard') ORDER BY dc.card_id,dc.zone`;
    const lots =
      await db`SELECT cp.printing_id AS "printingId",array_remove(ARRAY[f.card_id,back.card_id],NULL) AS "cardIds",count(*)::int AS quantity
      FROM copies cp JOIN collections cl ON cl.id=cp.collection_id JOIN printings p ON p.id=cp.printing_id JOIN faces f ON f.id=p.face1_id
      LEFT JOIN faces back ON back.id=p.face2_id
      WHERE cl.user_id=${user} AND cl.group_id IS NULL GROUP BY cp.printing_id,f.card_id,back.card_id ORDER BY cp.printing_id`;
    // Constrained slots first, then unrestricted slots. Each physical copy is
    // consumed once within this calculation; other decks start from full lots.
    const allocations = new Map<string, number>();
    const ordered = [...rows].sort(
      (a, b) =>
        Number(strict && Boolean(b.preferredPrintingId)) -
        Number(strict && Boolean(a.preferredPrintingId)),
    );
    for (const row of ordered) {
      let needed = row.quantity;
      for (const lot of lots) {
        if (
          !lot.cardIds.includes(row.cardId) ||
          (strict && row.preferredPrintingId && row.preferredPrintingId !== lot.printingId)
        )
          continue;
        const take = Math.min(needed, lot.quantity);
        needed -= take;
        lot.quantity -= take;
      }
      allocations.set(row.id, row.quantity - needed);
    }
    return rows.map((row) => ({
      ...row,
      name: legendDisplayName({ name: row.name, types: [row.type], tags: row.tags }),
      owned: allocations.get(row.id) ?? 0,
      missing: row.quantity - (allocations.get(row.id) ?? 0),
    }));
  }
  return {
    db,
    preview,
    review,
    confirm,
    overview,
    gaps,
    search: (q: string) =>
      candidates(db, /^[A-Z]{2,8}-[A-Z]?\d+[a-z*]?$/iu.test(q) ? { code: q } : { name: q }, true),
    import: async (user: string, id: string) => {
      const item = await getImport(db, user, id);
      const duplicates =
        await db`SELECT id,status,created_at FROM rifter_imports WHERE user_id=${user} AND fingerprint=${item.fingerprint} AND id<>${id} ORDER BY created_at DESC`;
      return { ...item, duplicates };
    },
    setDeckStatus: (user: string, id: string, status: "active" | "aspiring") =>
      transaction(user, "Change deck status", async (tx) => {
        await authorize(tx, user, { kind: "deck", id, mode: "add" });
        await tx`INSERT INTO rifter_deck_state(id,status) VALUES(${id},${status}) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status`;
        return { id, status };
      }),
    undo: (user: string, id: string) =>
      // Tradeoff: rifter_undo takes a table-wide SHARE ROW EXCLUSIVE lock on the
      // audited tables, briefly blocking all users' writes, in exchange for a
      // simple race-free compare-and-restore. Revisit if undo volume grows.
      transaction(user, "Undo action", async (tx) => {
        const [row] = await tx`SELECT rifter_undo(${id}::uuid,${user}) AS id`;
        // Keep the import in step: undoing its apply action makes it re-appliable;
        // undoing that undo (redo) marks it applied again.
        await tx`UPDATE rifter_imports SET status='undone',revision=revision+1 WHERE user_id=${user} AND status='applied' AND applied_action_id=${id}::uuid`;
        await tx`UPDATE rifter_imports SET status='applied',revision=revision+1 WHERE user_id=${user} AND status='undone'
          AND applied_action_id=(SELECT reverses FROM rifter_actions WHERE id=${id}::uuid AND user_id=${user})`;
        return row;
      }),
  };
}
