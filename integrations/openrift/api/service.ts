import { createHash } from "node:crypto";

import { legendDisplayName, normalizeNameForIdentity } from "@openrift/shared/card-name";
import type {
  RifterCandidate,
  RifterDestination,
  RifterImportRow,
  RifterPreviewRequest,
  RifterReplaceDiff,
  RifterReplaceLine,
} from "@openrift/shared/contracts/rifter";
import postgres from "postgres";

import { parseInput } from "./parse.js";

// Parse-time warning kept separately so a review choice cannot erase it.
type StoredRow = RifterImportRow & { parseWarning?: string | null };
// Tokens (SFD-T01 and the like, double-sided "A // B" names, catalog type token) are not
// cards a collection tracks, so they start excluded. Runes (RAD-R03) are ordinary cards.
const TOKEN_CODE = /^[A-Z]{2,8}-T\d+/iu;
async function isTokenRow(
  sql: DB,
  row: { code?: string; name?: string },
  found: RifterCandidate[],
): Promise<boolean> {
  if (row.code && TOKEN_CODE.test(row.code.trim())) return true;
  if (row.name?.includes(" // ")) return true;
  if (found.length && found.every((c) => TOKEN_CODE.test(c.code))) return true;
  if (!found.length) return false;
  const ids = [...new Set(found.map((c) => c.cardId))];
  return (await sql`SELECT 1 FROM cards WHERE id IN ${sql(ids)} AND type::text='token' LIMIT 1`).length > 0;
}
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const MAX_PENDING_IMPORTS = 50;
const DISCARD_AFTER_DAYS = 30;
// Default printing rule for ambiguous rows. Values are the catalog slugs from
// OpenRift migration 001 (languages.code, finishes.slug, art_variants.slug).
const DEFAULT_LANGUAGE = "EN"; // languages: EN, FR, SC
const DEFAULT_FINISH = "normal"; // finishes: normal, foil, metal, metal-deluxe
const DEFAULT_ART_VARIANT = "normal"; // art_variants: normal, altart, ultimate
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
// Replace mode asks for an explicit extra acknowledgement above this share of removed copies.
export const REMOVAL_ACK_SHARE = 0.5;
/**
 * Parse what is typed after a set picker: `12`, `012`, `r3`, `T5`, `149a`, `4-p`.
 * Plain numbers pad to three digits (RAD-012); rune/token numbers (R03, T05) to two.
 * Returns the code base (without letter modifier or promo suffix) and the full exact code.
 */
export function parseCardNumber(
  setCode: string,
  raw: string,
): { base: string; exact: string; suffixed: boolean; set: string } | null {
  const m = /^([A-Za-z]?)(\d{1,4})([A-Za-z*]?)(?:-([A-Za-z]+))?$/u.exec(raw.trim());
  if (!m || !/^[A-Za-z]{2,8}$/u.test(setCode)) return null;
  const [, letter = "", digits = "", modifier = "", promo = ""] = m;
  const set = setCode.toUpperCase();
  const base = `${set}-${letter.toUpperCase()}${digits.padStart(letter ? 2 : 3, "0")}`;
  const exact = base + modifier.toUpperCase() + (promo ? "-" + promo.toUpperCase() : "");
  return { base, exact, suffixed: Boolean(modifier || promo), set };
}
function toCandidate(value: unknown): RifterCandidate {
  const { type, tags, ...candidate } = value as RifterCandidate & { type: string; tags: string[] };
  return { ...candidate, name: legendDisplayName({ name: candidate.name, types: [type], tags }) };
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
/**
 * Visible, deterministic default for a row with several candidates: narrow to
 * English, then the normal finish, then the standard art. A step is skipped when
 * the file stated that attribute or when it would leave nothing. Returns the
 * single remaining printing only when exactly one printing of one card is left.
 */
export function defaultPrinting(
  found: RifterCandidate[],
  explicit: { finish?: string; language?: string; artVariant?: string },
): { candidate: RifterCandidate; note: string } | null {
  if (found.length < 2 || new Set(found.map((c) => c.cardId)).size !== 1) return null;
  let left = found;
  const applied: string[] = [];
  const steps: [boolean, (c: RifterCandidate) => boolean, string][] = [
    [!explicit.language, (c) => c.language === DEFAULT_LANGUAGE, "English"],
    [!explicit.finish, (c) => c.finish === DEFAULT_FINISH, "normal finish"],
    [!explicit.artVariant, (c) => c.artVariant === DEFAULT_ART_VARIANT, "standard art"],
  ];
  for (const [enabled, keep, label] of steps) {
    if (!enabled) continue;
    const narrowed = left.filter(keep);
    if (narrowed.length && narrowed.length < left.length) {
      left = narrowed;
      applied.push(label);
    }
  }
  return left.length === 1 && applied.length
    ? {
        candidate: left[0]!,
        note:
          applied.join(", ") +
          ` (${found.length - 1} other printing${found.length === 2 ? "" : "s"})`,
      }
    : null;
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
    return found.slice(0, 100).map(toCandidate);
  }
  /**
   * Quick entry by set + number: the exact number first, then its lettered / promo
   * variants. Never returns other numbers (12 is not 120). The default rule marks
   * one exact printing; ambiguity among exact printings stays visible.
   */
  async function searchByNumber(setCode: string, number: string): Promise<RifterCandidate[]> {
    const parsed = parseCardNumber(setCode, number);
    if (!parsed) return [];
    // set and base are letters, digits and "-" only, so the pattern needs no escaping.
    const pattern = `^${parsed.base}[A-Z*]?(-[A-Z]+)?$`;
    const found = await db`
      SELECT * FROM (
        SELECT p.id AS "printingId", c.id AS "cardId", c.name, f.short_code AS code,
          f.finish, f.language, f.art_variant AS "artVariant", c.type, c.tags,
          upper(split_part(coalesce(f.public_code,''),'/',1)) AS pub, upper(f.short_code) AS sc
        FROM printings p JOIN faces f ON f.id=p.face1_id JOIN cards c ON c.id=f.card_id
        WHERE p.size='standard'
          AND (upper(f.short_code) ~ ${pattern} OR upper(split_part(coalesce(f.public_code,''),'/',1)) ~ ${pattern})
      ) x
      ORDER BY (coalesce(nullif(pub,''),sc)=${parsed.exact} OR (${parsed.suffixed}::boolean AND sc=${parsed.exact})) DESC,
        coalesce(nullif(pub,''),sc), finish, language, "printingId" LIMIT 101`;
    const rows = found.slice(0, 100).map((v) => {
      const { pub, sc, ...rest } = v as Record<string, unknown>;
      const exact =
        (pub || sc) === parsed.exact || (parsed.suffixed && sc === parsed.exact);
      return { candidate: toCandidate(rest), exact };
    });
    const out = rows.map(({ candidate, exact }) => ({
      ...candidate,
      match: exact ? ("exact" as const) : ("variant" as const),
    }));
    const exactOnes = out.filter((c) => c.match === "exact");
    const pick =
      exactOnes.length === 1
        ? { candidate: exactOnes[0]!, note: "only printing of this number" }
        : defaultPrinting(exactOnes, {});
    for (const c of out)
      if (pick && c.printingId === pick.candidate.printingId) {
        c.isDefault = true;
        c.defaultNote = pick.note;
      }
    return out;
  }
  async function search(q: { q?: string; set?: string; number?: string }) {
    if (q.set && q.number) return await searchByNumber(q.set, q.number);
    const text = q.q ?? "";
    const code = /^([A-Za-z]{2,8})-(.+)$/u.exec(text);
    if (code && parseCardNumber(code[1]!, code[2]!)) {
      const found = await searchByNumber(code[1]!, code[2]!);
      if (found.length) return found;
    }
    return await candidates(
      db,
      /^[A-Z]{2,8}-[A-Z]?\d+[a-z*]?$/iu.test(text) ? { code: text } : { name: text },
      true,
    );
  }
  async function sets() {
    return await db`SELECT upper(split_part(f.short_code,'-',1)) AS code, min(s.name) AS name,
        count(DISTINCT f.card_id)::int AS cards
      FROM printings p JOIN faces f ON f.id=p.face1_id JOIN sets s ON s.id=f.set_id
      WHERE p.size='standard' AND f.short_code ~ '^[A-Za-z]{2,8}-'
      GROUP BY 1 ORDER BY min(s.sort_order), 1`;
  }
  /**
   * Target state of a collection after a "replace" import, as a difference from its
   * current copies. The file's quantities apply per resolved printing. Copies of the
   * same card in a printing the file does not name stay; copies of cards the file
   * never mentions are removed. Unresolved or excluded rows protect every card they
   * could stand for. Existing copies keep their notes and grading: only surplus copies
   * go (plain ones first, newest first) and only shortfalls are added.
   */
  async function planReplace(sql: DB, collectionId: string, all: StoredRow[], lock = false) {
    const included = all.filter(
      (r) =>
        !r.excluded &&
        r.printingId &&
        !r.warning &&
        r.candidates.some((c) => c.printingId === r.printingId),
    );
    const skippedRows = all.length - included.length;
    const target = new Map<string, { quantity: number; row: StoredRow; info: RifterCandidate }>();
    const mentioned = new Set<string>();
    for (const row of included) {
      const info = row.candidates.find((c) => c.printingId === row.printingId)!;
      mentioned.add(info.cardId);
      const entry = target.get(info.printingId);
      if (entry) entry.quantity += row.quantity;
      else target.set(info.printingId, { quantity: row.quantity, row, info });
    }
    // A row with no catalog candidates cannot stand for any card the user owns.
    for (const row of all)
      if (!included.includes(row)) for (const c of row.candidates) mentioned.add(c.cardId);
    const query = lock
      ? sql`SELECT cp.id,cp.printing_id AS "printingId",cp.created_at,f.card_id AS "cardId",c.name,f.short_code AS code,f.finish,f.language,
          (cp.notes_public IS NOT NULL OR cp.notes_private IS NOT NULL OR cp.grader IS NOT NULL OR cp.is_altered OR jsonb_array_length(cp.links)>0) AS rich
        FROM copies cp JOIN printings p ON p.id=cp.printing_id JOIN faces f ON f.id=p.face1_id JOIN cards c ON c.id=f.card_id
        WHERE cp.collection_id=${collectionId} ORDER BY cp.created_at DESC,cp.id DESC FOR UPDATE OF cp`
      : sql`SELECT cp.id,cp.printing_id AS "printingId",cp.created_at,f.card_id AS "cardId",c.name,f.short_code AS code,f.finish,f.language,
          (cp.notes_public IS NOT NULL OR cp.notes_private IS NOT NULL OR cp.grader IS NOT NULL OR cp.is_altered OR jsonb_array_length(cp.links)>0) AS rich
        FROM copies cp JOIN printings p ON p.id=cp.printing_id JOIN faces f ON f.id=p.face1_id JOIN cards c ON c.id=f.card_id
        WHERE cp.collection_id=${collectionId} ORDER BY cp.created_at DESC,cp.id DESC`;
    const current = (await query) as unknown as {
      id: string;
      printingId: string;
      cardId: string;
      name: string;
      code: string;
      finish: string;
      language: string;
      rich: boolean;
    }[];
    const byPrinting = new Map<string, typeof current>();
    for (const copy of current) byPrinting.set(copy.printingId, [...(byPrinting.get(copy.printingId) ?? []), copy]);
    const diff: RifterReplaceDiff = {
      printings: { added: 0, removed: 0, changed: 0, unchanged: 0 },
      copies: { added: 0, removed: 0, total: current.length, untouched: 0 },
      lines: [],
      skippedRows,
      removalShare: 0,
      needsRemovalAcknowledgement: false,
      refusal: null,
    };
    const removeIds: string[] = [];
    const additions: { row: StoredRow; count: number }[] = [];
    if (!included.length) {
      diff.refusal =
        "Replace refused: the file has no resolvable rows, so nothing would be left to compare against. No cards were changed.";
      return { diff, removeIds, additions };
    }
    for (const printingId of new Set([...target.keys(), ...byPrinting.keys()])) {
      const have = byPrinting.get(printingId) ?? [];
      const want = target.get(printingId);
      if (!want && have[0] && mentioned.has(have[0].cardId)) {
        diff.copies.untouched += have.length; // another finish/language of a card the file lists
        continue;
      }
      const to = want?.quantity ?? 0;
      const info = want?.info ?? have[0]!;
      const line = (kind: RifterReplaceLine["kind"]): RifterReplaceLine => ({
        kind,
        printingId,
        cardId: info.cardId,
        name: info.name,
        code: info.code,
        finish: info.finish,
        language: info.language,
        from: have.length,
        to,
      });
      if (have.length === to) {
        diff.printings.unchanged++;
        continue;
      }
      if (have.length > to) {
        // Surplus: copies without notes or grading first, newest first within each group.
        const order = [...have].sort((a, b) => Number(a.rich) - Number(b.rich));
        const surplus = order.slice(0, have.length - to);
        removeIds.push(...surplus.map((c) => c.id));
        diff.copies.removed += surplus.length;
      } else {
        additions.push({ row: want!.row, count: to - have.length });
        diff.copies.added += to - have.length;
      }
      const kind = have.length === 0 ? "added" : to === 0 ? "removed" : "changed";
      diff.printings[kind]++;
      diff.lines.push(line(kind));
    }
    diff.removalShare = current.length ? diff.copies.removed / current.length : 0;
    diff.needsRemovalAcknowledgement = diff.removalShare > REMOVAL_ACK_SHARE;
    return { diff, removeIds, additions };
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
      let found = await candidates(db, row);
      // Code wins: a code that matches exactly keeps its printings as candidates when only
      // the name differs. A spelling that differs by punctuation or case alone is accepted
      // like any match; any other difference leaves the row unresolved with a visible
      // warning, so the user must choose the printing (accepting the card) before confirming.
      let nameDiffers: string | null = null;
      if (!found.length && row.code && row.name) {
        const byCode = await candidates(db, { ...row, name: undefined });
        if (byCode.length) {
          found = byCode;
          if (new Set(byCode.map((c) => squash(c.name))).size !== 1 || squash(byCode[0]!.name) !== squash(row.name))
            nameDiffers = `Name differs from the catalog (${row.name} vs ${byCode[0]!.name}); check it is the right card, then choose the printing`;
        }
      }
      const token = await isTokenRow(db, row, found);
      const filtered = Boolean(row.finish || row.language || row.artVariant);
      const reason: string | null = nameDiffers
        ? nameDiffers
        : found.length === 0
          ? (row.code
              ? `Code ${row.code} not found in the catalog${filtered ? " with the requested finish, language or art" : ""} (rune, token and promo codes may differ)`
              : `No card named "${row.name}" in the catalog${filtered ? " with the requested finish, language or art" : ""}`) +
            "; search and resolve or exclude this row"
          : found.length > 1
            ? "Choose a printing"
            : null;
      // The default printing rule applies to collection destinations only. A deck
      // confirm would store the pick as preferred_printing_id, silently pinning the
      // card to one printing for strict-mode ownership, so deck rows keep every
      // choice visible and need an explicit selection.
      const auto =
        input.destination.kind === "collection" && !nameDiffers ? defaultPrinting(found, row) : null;
      rows.push({
        input: row.input,
        quantity: row.quantity,
        zone: row.zone,
        condition: row.condition,
        metadata: row.metadata,
        candidates: found,
        printingId: nameDiffers
          ? null
          : found.length === 1
            ? found[0]!.printingId
            : (auto?.candidate.printingId ?? null),
        ...(auto ? { autoChosen: auto.note } : {}),
        excluded: token,
        ...(token ? { autoExcluded: "token" as const } : {}),
        parseWarning: row.warning ?? null,
        ...(reason && !(auto && found.length > 1) ? { reason } : {}),
        warning: token
          ? "Ignored: token"
          : (row.warning ?? (auto && !nameDiffers ? null : reason)),
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
        // Taking a token row back is the user's explicit decision: it is tracked like any card.
        if (!choice.excluded) delete row.autoExcluded;
        // Any change of printing is the user's own choice, not the default rule.
        if (choice.printingId !== row.printingId) delete row.autoChosen;
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
        if (choice.zone && row.parseWarning?.startsWith("Unknown section")) row.parseWarning = null;
        if (choice.zone) row.zone = choice.zone;
        if (choice.condition !== undefined) row.condition = choice.condition;
        row.warning = choice.excluded
          ? row.autoExcluded
            ? "Ignored: token"
            : "Explicitly excluded"
          : row.parseWarning
            ? row.parseWarning
            : choice.printingId
            ? null
            : (row.reason ?? "Unresolved");
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
    input: {
      revision: number;
      acknowledgeDuplicate: boolean;
      acknowledgeRemoval?: boolean;
      expectedChange?: { added: number; removed: number };
    },
  ) {
    return await transaction(user, "Apply import / acquisition", async (tx) => {
      const item = await getImport(tx, user, id, true);
      if (item.status === "applied") return { id, status: "applied", alreadyApplied: true };
      if (item.revision !== input.revision) fail("Import changed; reload before confirming");
      const destination = item.destination as RifterDestination;
      // Replace sets a target state, so applying the same file again is harmless; the
      // duplicate acknowledgement belongs to add mode only.
      const replacing = destination.kind !== "new-deck" && destination.mode === "replace";
      const duplicates = replacing
        ? []
        : await tx`SELECT id FROM rifter_imports WHERE user_id=${user} AND fingerprint=${item.fingerprint} AND status='applied' AND id<>${id}`;
      if (duplicates.length && !input.acknowledgeDuplicate)
        fail("This input was applied before. Explicit duplicate acknowledgement required.");
      await authorize(tx, user, destination);
      const rows = (item.rows as RifterImportRow[]).filter((r) => !r.excluded);
      if (replacing && destination.kind === "collection" && !rows.length)
        fail(
          "Replace refused: the file has no resolvable rows, so nothing would be left to compare against. No cards were changed.",
        );
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
      let change: { added: number; removed: number } | undefined;
      const addCopies = async (collectionId: string, row: RifterImportRow, quantity: number) => {
        // Copy metadata constraints are enforced by PostgreSQL in the same transaction.
        await tx`INSERT INTO copies(collection_id,printing_id,condition,grader,grade,is_altered,notes_public,notes_private,links)
          SELECT ${collectionId},${row.printingId},${row.condition},${row.metadata.grader ?? null},${row.metadata.grade ?? null},
            ${row.metadata.isAltered ?? false},${row.metadata.notesPublic ?? null},${row.metadata.notesPrivate ?? null},${tx.json(row.metadata.links ?? [])}
          FROM generate_series(1,${quantity}::int)`;
      };
      if (destination.kind === "collection" && destination.mode === "replace") {
        const plan = await planReplace(tx, destination.id, item.rows, true);
        const { diff } = plan;
        if (diff.refusal) fail(diff.refusal);
        change = { added: diff.copies.added, removed: diff.copies.removed };
        if (
          input.expectedChange &&
          (input.expectedChange.added !== change.added || input.expectedChange.removed !== change.removed)
        )
          fail("The collection changed since the preview; review the replacement again");
        if (diff.needsRemovalAcknowledgement && !input.acknowledgeRemoval)
          fail(
            `This import would remove ${diff.copies.removed} of ${diff.copies.total} copies (${Math.round(diff.removalShare * 100)}%). Explicit removal acknowledgement required.`,
          );
        await tx`SELECT set_config('rifter.label','Replace collection import',true)`;
        if (plan.removeIds.length) await tx`DELETE FROM copies WHERE id IN ${tx(plan.removeIds)}`;
        for (const add of plan.additions) await addCopies(destination.id, add.row, add.count);
      } else if (destination.kind === "collection") {
        for (const row of rows) await addCopies(destination.id, row, row.quantity);
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
      return { id, status: "applied", deckId, actionId: action?.id, change };
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
    search,
    sets,
    import: async (user: string, id: string) => {
      const item = await getImport(db, user, id);
      const destination = item.destination as RifterDestination;
      const replacing = destination.kind === "collection" && destination.mode === "replace";
      const duplicates =
        await db`SELECT id,status,created_at FROM rifter_imports WHERE user_id=${user} AND fingerprint=${item.fingerprint} AND id<>${id} ORDER BY created_at DESC`;
      let replaceDiff: RifterReplaceDiff | null = null;
      if (replacing && item.status === "pending") {
        try {
          await authorize(db, user, destination);
          replaceDiff = (await planReplace(db, destination.id, item.rows)).diff;
        } catch {
          replaceDiff = null; // collection deleted since the preview; confirm will refuse
        }
      }
      return { ...item, duplicates: replacing ? [] : duplicates, replaceDiff };
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
