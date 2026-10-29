import { afterAll, beforeAll, expect, test } from "bun:test";

import { rifterSearchQuery } from "@openrift/shared/contracts/rifter";

import { parseInput, csvRows } from "./parse.js";
import { createRifterService, parseCardNumber } from "./service.js";
import { createShopping } from "./shopping.js";
import { normalizeCatalog } from "./sync-catalog.js";

const url = process.env.RIFTER_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("/rifter_test"))
  throw Error("Run scripts/test-rifter.py: tests require the separate rifter_test database");
const service = createRifterService(url),
  sql = service.db;
const user = "rifter-test-" + crypto.randomUUID(),
  other = "rifter-test-" + crypto.randomUUID();
let collection: string,
  card: string,
  backCard: string,
  printing: string,
  foil: string,
  setId: string,
  extraCards: string[] = [],
  enNormal: string,
  enFoil: string,
  frNormal: string,
  foilOnly: string,
  enFoilFr: string[],
  frBoth: string[],
  artNormal: string;
const defaultName = "Rifter default " + crypto.randomUUID();
const name = "Rifter fixture " + crypto.randomUUID();
beforeAll(async () => {
  await sql`INSERT INTO users(id,email,name,email_verified) VALUES(${user},${user + "@example.test"},'Rifter test',true),(${other},${other + "@example.test"},'Other',true)`;
  [collection] = (
    await sql`INSERT INTO collections(user_id,name) VALUES(${user},'Test binder') RETURNING id`
  ).map((r) => r.id);
  const [set] =
    await sql`INSERT INTO sets(name,slug) VALUES('Rifter fixture',${user}) RETURNING id`;
  setId = set!.id;
  const [c] =
    await sql`INSERT INTO cards(name,slug,type) VALUES(${name},${user},'unit') RETURNING id`;
  card = c!.id;
  const faces =
    await sql`INSERT INTO faces(card_id,set_id,short_code,public_code,art_variant,artist,rarity,finish)
    VALUES(${card},${setId},'TST-001','TST-001','normal','Fixture','common','normal'),
    (${card},${setId},'TST-001','TST-001','normal','Fixture','common','foil') RETURNING id,finish`;
  for (const f of faces) {
    const [p] = await sql`INSERT INTO printings(face1_id) VALUES(${f.id}) RETURNING id`;
    if (f.finish === "normal") printing = p!.id;
    else foil = p!.id;
  }
  const [back] =
    await sql`INSERT INTO cards(name,slug,type) VALUES(${name + " back"},${user + "-back"},'unit') RETURNING id`;
  backCard = back!.id;
  const [face] =
    await sql`INSERT INTO faces(card_id,set_id,short_code,public_code,art_variant,artist,rarity,finish) VALUES(${backCard},${setId},'TST-002','TST-002','normal','Fixture','common','normal') RETURNING id`;
  await sql`UPDATE printings SET face2_id=${face!.id} WHERE id=${printing}`;
});
beforeAll(async () => {
  const make = async (
    cardName: string,
    code: string,
    rows: { finish: string; language: string; art: string; markers?: string[] }[],
  ) => {
    const [c] =
      await sql`INSERT INTO cards(name,slug,type) VALUES(${cardName},${user + "-" + code},'unit') RETURNING id`;
    extraCards.push(c!.id);
    const ids: string[] = [];
    for (const r of rows) {
      const [f] =
        await sql`INSERT INTO faces(card_id,set_id,short_code,public_code,art_variant,artist,rarity,finish,language,marker_slugs)
        VALUES(${c!.id},${setId},${code},${code},${r.art},'Fixture','common',${r.finish},${r.language},${r.markers ?? []}) RETURNING id`;
      const [p] = await sql`INSERT INTO printings(face1_id) VALUES(${f!.id}) RETURNING id`;
      ids.push(p!.id);
    }
    return ids;
  };
  const en = await make(defaultName, "TST-010", [
    { finish: "normal", language: "EN", art: "normal" },
    { finish: "foil", language: "EN", art: "normal" },
    { finish: "normal", language: "FR", art: "normal" },
  ]);
  [enNormal, enFoil, frNormal] = [en[0]!, en[1]!, en[2]!];
  foilOnly = (
    await make(defaultName + " foil", "TST-030", [{ finish: "foil", language: "EN", art: "normal" }])
  )[0]!;
  enFoilFr = await make(defaultName + " b", "TST-050", [
    { finish: "foil", language: "EN", art: "normal" },
    { finish: "normal", language: "FR", art: "normal" },
  ]);
  frBoth = await make(defaultName + " c", "TST-051", [
    { finish: "foil", language: "FR", art: "normal" },
    { finish: "normal", language: "FR", art: "normal" },
  ]);
  await make(defaultName + " same", "TST-060", [{ finish: "normal", language: "EN", art: "normal" }]);
  await make(defaultName + " same", "TST-061", [{ finish: "normal", language: "EN", art: "normal" }]);
  artNormal = (await make(defaultName + " art", "TST-040", [
    { finish: "normal", language: "EN", art: "normal", markers: ["promo"] },
    { finish: "normal", language: "EN", art: "altart" },
    { finish: "foil", language: "EN", art: "altart" },
  ]))[0]!;
  await make(defaultName + " arts", "TST-021", [
    { finish: "normal", language: "EN", art: "altart" },
    { finish: "normal", language: "EN", art: "ultimate", markers: ["promo"] },
  ]);
});
afterAll(async () => {
  await sql`DELETE FROM users WHERE id IN (${user},${other})`;
  const owned = [card, backCard, ...extraCards];
  await sql`DELETE FROM printings WHERE face1_id IN (SELECT id FROM faces WHERE card_id IN ${sql(owned)})`;
  await sql`DELETE FROM faces WHERE card_id IN ${sql(owned)}`;
  await sql`DELETE FROM cards WHERE id IN ${sql(owned)}`;
  await sql`DELETE FROM sets WHERE id=${setId}`;
  await sql.end();
});
const dest = () => ({ kind: "collection" as const, id: collection, mode: "add" as const });
async function staged(rawInput = "2 TST-001", destination: any = dest(), condition?: string) {
  const p = await service.preview(user, {
    rawInput,
    source: "Fixture",
    format: "text",
    destination,
  });
  const r = await service.review(user, p!.id, {
    revision: p!.revision,
    choices: p!.rows.map((_: unknown, index: number) => ({
      index,
      printingId: printing,
      excluded: false,
    })),
  });
  if (condition) {
    const rows = r!.rows;
    rows[0].condition = condition;
    await sql`UPDATE rifter_imports SET rows=${sql.json(rows)} WHERE id=${r!.id}`;
  }
  return r!;
}
const count = async () =>
  Number((await sql`SELECT count(*) AS n FROM copies WHERE collection_id=${collection}`)[0]!.n);
test("strict parsing preserves sections, counts and metadata; rejects malformed CSV", () => {
  expect(csvRows('\ufeffcode,name,count\r\nOGN-001,"A, B",2')[1]).toEqual(["OGN-001", "A, B", "2"]);
  expect(() => csvRows('code,name\n"broken')).toThrow();
  const p = parseInput(
    "text",
    "[Champion]\n1 TST-001\n[Main Deck]\n3x A Card\n[Sideboard]\n2 Other",
  );
  expect(p.rows.map((r) => r.zone)).toEqual(["champion", "main", "sideboard"]);
  expect(p.rows.map((r) => r.quantity)).toEqual([1, 3, 2]);
  expect(() => parseInput("rifty", "code,name,count\nOGN-001,Card,2oops")).toThrow();
  expect(
    parseInput(
      "openrift",
      "Card ID,Card Name,Quantity,Finish,Language,Condition,Private Notes\nTST-001,Card,2,foil,FR,NM,Keep",
    ).rows[0],
  ).toMatchObject({
    finish: "foil",
    language: "FR",
    condition: "near-mint",
    metadata: { notesPrivate: "Keep" },
  });
  expect(
    parseInput("piltover-csv", "Variant Number,Card Name,Quantity,Foil\nTST-001-Foil,Card,2,true")
      .rows[0],
  ).toMatchObject({ code: "TST-001", finish: "foil" });
  expect(normalizeCatalog({ cards: { a: { types: ["spell", "gear"] } } })).toEqual({
    cards: { a: { types: ["spell", "gear"], type: "spell" } },
  });
});
test("CSV language names and condition vocabularies round-trip without invalid slugs", () => {
  for (const [language, code] of [
    ["English", "EN"],
    ["French", "FR"],
    ["Chinese (Simplified)", "SC"],
  ]) {
    const row = parseInput(
      "openrift",
      "Card ID,Card Name,Quantity,Language,Condition\nTST-001,Card,1," + language + ",LP",
    ).rows[0]!;
    expect(row.language).toBe(code);
    expect(row.condition).toBe("light-played");
  }
  expect(
    parseInput(
      "piltover-csv",
      "Variant Number,Card Name,Quantity,Foil,Condition\nTST-001,Card,1,false,EX",
    ).rows[0]!.condition,
  ).toBe("excellent");
});
test("quarantine does not mutate ownership; ambiguous code blocks confirmation", async () => {
  const before = await count();
  const p = await service.preview(user, {
    rawInput: "2 TST-021",
    source: "Test",
    format: "acquisition",
    destination: dest(),
  });
  expect(p!.rows[0].candidates.length).toBe(2);
  expect(p!.rows[0].printingId).toBeNull();
  expect(p!.rows[0].warning).toBe("Choose a printing");
  expect(p!.rows[0].autoChosen).toBeUndefined();
  await expect(
    service.confirm(user, p!.id, { revision: 1, acknowledgeDuplicate: false }),
  ).rejects.toThrow("Resolve");
  expect(await count()).toBe(before);
});
test("malformed imports remain quarantined with their original input and cannot apply", async () => {
  const raw = 'code,name,count\nTST-001,"unfinished,2';
  const p = await service.preview(user, {
    rawInput: raw,
    source: "Malformed fixture",
    format: "rifty",
    destination: dest(),
  });
  const record = await service.import(user, p!.id);
  expect(record.raw_input).toBe(raw);
  expect(record.rows.length).toBe(0);
  expect(record.warnings[0]).toContain("could not be parsed");
  await expect(
    service.confirm(user, p!.id, { revision: p!.revision, acknowledgeDuplicate: true }),
  ).rejects.toThrow("Resolve");
});
test("an unmatched Rifty code cannot silently select a same-name reprint", async () => {
  const p = await service.preview(user, {
    rawInput: "code,name,count\nMISSING-999," + name + ",1",
    source: "Fixture",
    format: "rifty",
    destination: { kind: "new-deck", name: "Strict code", status: "aspiring" },
  });
  expect(p!.rows[0].printingId).toBeNull();
  expect(p!.rows[0].candidates.length).toBe(0);
});
test("confirmation is atomic and idempotent under concurrent submissions; undo is durable", async () => {
  const before = await count(),
    p = await staged();
  const results = await Promise.all([
    service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: true }),
    service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: true }),
  ]);
  expect(await count()).toBe(before + 2);
  expect(results.some((r) => r.alreadyApplied)).toBe(true);
  const applied = results.find((r) => r.actionId)!;
  await service.undo(user, applied.actionId);
  expect(await count()).toBe(before);
  await expect(service.undo(user, applied.actionId)).rejects.toThrow("already reversed");
});
test("failed metadata write rolls back all copies and keeps the import pending", async () => {
  const before = await count(),
    p = await staged("3 TST-001", dest(), "not-a-condition");
  await expect(
    service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: true }),
  ).rejects.toThrow();
  expect(await count()).toBe(before);
  expect((await service.import(user, p.id)).status).toBe("pending");
});
test("duplicate import requires explicit acknowledgement; cross-user reads and writes fail", async () => {
  const p = await staged("1 TST-001");
  await service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: true });
  const duplicate = await staged("1 TST-001");
  await expect(
    service.confirm(user, duplicate.id, {
      revision: duplicate.revision,
      acknowledgeDuplicate: false,
    }),
  ).rejects.toThrow("duplicate");
  await expect(service.import(other, p.id)).rejects.toThrow("not found");
  await expect(
    service.preview(other, {
      rawInput: "1 TST-001",
      source: "",
      format: "text",
      destination: dest(),
    }),
  ).rejects.toThrow("not found");
});
test("undo refuses to overwrite a later native metadata edit, then succeeds after that edit is reversed", async () => {
  const p = await staged("2 TST-001");
  const result = await service.confirm(user, p.id, {
    revision: p.revision,
    acknowledgeDuplicate: true,
  });
  const [change] =
    await sql`SELECT row_id FROM rifter_changes WHERE action_id=${result.actionId} AND entity='copies' LIMIT 1`;
  await sql`UPDATE copies SET notes_private='Later native edit' WHERE id=${change!.row_id}`;
  const [edit] =
    await sql`SELECT a.id FROM rifter_actions a JOIN rifter_changes ch ON ch.action_id=a.id WHERE ch.row_id=${change!.row_id} ORDER BY ch.id DESC LIMIT 1`;
  await expect(service.undo(user, result.actionId)).rejects.toThrow("Later edits");
  await service.undo(user, edit!.id);
  await service.undo(user, result.actionId);
});
test("deck gaps allocate once across zones, reuse ownership across decks, and status is reversible", async () => {
  const make = async (name: string) => {
    const p = await staged("[Main Deck]\n3 TST-001\n[Sideboard]\n2 TST-001", {
      kind: "new-deck",
      name,
      status: "aspiring",
    });
    return await service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: true });
  };
  const a = await make("Test Evelynn"),
    b = await make("Alternative legend");
  const ga = await service.gaps(user, a.deckId!, true, false),
    gb = await service.gaps(user, b.deckId!, true, false);
  expect(ga.reduce((n, r) => n + r.missing, 0)).toBe(gb.reduce((n, r) => n + r.missing, 0));
  expect(ga.reduce((n, r) => n + r.owned, 0)).toBeLessThanOrEqual(await count());
  expect((await service.gaps(user, a.deckId!, false, false)).length).toBe(1);
  await service.setDeckStatus(user, a.deckId!, "active");
  expect((await service.overview(user)).decks.find((d) => d.id === a.deckId)!.status).toBe(
    "active",
  );
  const statusAction = (await service.overview(user)).actions.find(
    (a) => a.label === "Change deck status",
  )!;
  await service.undo(user, statusAction.id);
  await service.undo(user, a.actionId);
  expect((await service.overview(user)).decks.some((d) => d.id === a.deckId)).toBe(false);
});
test("undo deck creation blocks later child additions rather than cascading them away", async () => {
  const p = await staged("1 TST-001", {
    kind: "new-deck",
    name: "Later edits",
    status: "aspiring",
  });
  const result = await service.confirm(user, p.id, {
    revision: p.revision,
    acknowledgeDuplicate: true,
  });
  await sql`INSERT INTO deck_cards(deck_id,card_id,zone,quantity,preferred_printing_id) VALUES(${result.deckId!},${card},'sideboard',2,${foil})`;
  await expect(service.undo(user, result.actionId)).rejects.toThrow(/[Ll]ater edits/u);
});
test("native collection deletion records cascaded copies and restores both", async () => {
  const [c] =
    await sql`INSERT INTO collections(user_id,name) VALUES(${user},'Temporary binder') RETURNING id`;
  const p = await staged("2 TST-001", { kind: "collection", id: c!.id, mode: "add" });
  await service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: true });
  await sql.begin(async (tx) => {
    await tx`DELETE FROM copies WHERE collection_id=${c!.id}`;
    await tx`DELETE FROM collections WHERE id=${c!.id}`;
  });
  const [action] =
    await sql`SELECT a.id FROM rifter_actions a JOIN rifter_changes ch ON ch.action_id=a.id WHERE ch.entity='collections' AND ch.row_id=${c!.id} ORDER BY ch.id DESC LIMIT 1`;
  await service.undo(user, action!.id);
  expect(
    Number((await sql`SELECT count(*) AS n FROM copies WHERE collection_id=${c!.id}`)[0]!.n),
  ).toBe(2);
});
test("cross-owner moves do not leak donor before-images into recipient undo history", async () => {
  const [recipient] =
    await sql`INSERT INTO collections(user_id,name) VALUES(${other},'Recipient binder') RETURNING id`;
  const p = await staged("1 TST-001");
  const result = await service.confirm(user, p.id, {
    revision: p.revision,
    acknowledgeDuplicate: true,
  });
  const [copy] =
    await sql`SELECT row_id FROM rifter_changes WHERE action_id=${result.actionId} AND entity='copies' LIMIT 1`;
  await sql`UPDATE copies SET collection_id=${recipient!.id} WHERE id=${copy!.row_id}`;
  const leaked =
    await sql`SELECT ch.id FROM rifter_changes ch JOIN rifter_actions a ON a.id=ch.action_id WHERE a.user_id=${other} AND ch.entity='copies' AND ch.row_id=${copy!.row_id}`;
  expect(leaked.length).toBe(0);
  await expect(service.undo(user, result.actionId)).rejects.toThrow();
});
test("ABA edits block older undo until the later effective edits are explicitly reversed", async () => {
  const p = await staged("1 TST-001");
  const acquired = await service.confirm(user, p.id, {
    revision: p.revision,
    acknowledgeDuplicate: true,
  });
  const [copy] =
    await sql`SELECT row_id FROM rifter_changes WHERE action_id=${acquired.actionId} AND entity='copies' LIMIT 1`;
  const edit = async (value: string) => {
    await sql`UPDATE copies SET notes_private=${value} WHERE id=${copy!.row_id}`;
    return (
      await sql`SELECT action_id FROM rifter_changes WHERE entity='copies' AND row_id=${copy!.row_id} ORDER BY id DESC LIMIT 1`
    )[0]!.action_id;
  };
  const a = await edit("A"),
    b = await edit("B"),
    c = await edit("A");
  await expect(service.undo(user, a)).rejects.toThrow("Later edits");
  await service.undo(user, c);
  await service.undo(user, b);
  await service.undo(user, a);
});
test("stock snapshots reject invalid data and retain the last good snapshot after interrupted refresh", async () => {
  const shopping = createShopping(sql);
  const csv =
    "name,game,verification,url,evidence_url,checked_at,collector_number,version,finish,condition,price_cad,stock\n" +
    name +
    ",Riftbound,manual,https://www.gamekeeperverdun.com/card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,001,Base,Normal,NM,2.50,4\n";
  const snapshot = await shopping.snapshot(user, csv);
  await expect(shopping.snapshot(user, csv.replace("Riftbound", "Magic"))).rejects.toThrow();
  await sql`INSERT INTO rifter_stock_refreshes(user_id,status) VALUES(${user},'running')`;
  const status = await shopping.status(user);
  expect(status.snapshot!.id).toBe(snapshot!.id);
  expect(status.refresh!.status).toBe("failed");
  const comparison = await shopping.compare(user, [{ name, count: 3, section: "main" }]);
  expect(comparison.planned).toBe(3);
  expect(comparison.stale).toBe(true);
});
test("double-faced printings can cover either card without counting the physical copies twice", async () => {
  const owned = Number(
    (
      await sql`SELECT count(*) AS n FROM copies cp JOIN collections cl ON cl.id=cp.collection_id WHERE cl.user_id=${user} AND cp.printing_id=${printing}`
    )[0]!.n,
  );
  const [deck] =
    await sql`INSERT INTO decks(user_id,name,format) VALUES(${user},'Double face fixture','constructed') RETURNING id`;
  await sql`INSERT INTO deck_cards(deck_id,card_id,zone,quantity,preferred_printing_id) VALUES(${deck!.id},${card},'main',${owned + 1},${printing}),(${deck!.id},${backCard},'main',${owned + 1},${printing})`;
  const gaps = await service.gaps(user, deck!.id, true, true);
  expect(gaps.reduce((n, r) => n + r.owned, 0)).toBe(owned);
  expect(gaps.length).toBe(2);
});
test("undoing an applied import makes it re-appliable", async () => {
  const before = await count(),
    p = await staged("2 TST-001");
  const applied = await service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: true });
  await service.undo(user, applied.actionId);
  expect(await count()).toBe(before);
  const undone = await service.import(user, p.id);
  expect(undone.status).toBe("undone");
  const again = await service.confirm(user, p.id, {
    revision: undone.revision,
    acknowledgeDuplicate: true,
  });
  expect(again.status).toBe("applied");
  expect(await count()).toBe(before + 2);
});
test("choosing a printing keeps parse-time warnings unless the zone changes", async () => {
  const p = await service.preview(user, {
    rawInput: "[Bogus Section]\n1 TST-001",
    source: "Fixture",
    format: "text",
    destination: { kind: "new-deck", name: "Warn", status: "aspiring" },
  });
  expect(p!.rows[0].warning).toContain("Unknown section");
  const r = await service.review(user, p!.id, {
    revision: p!.revision,
    choices: [{ index: 0, printingId: printing, excluded: false }],
  });
  expect(r!.rows[0].warning).toContain("Unknown section");
  await expect(
    service.confirm(user, p!.id, { revision: r!.revision, acknowledgeDuplicate: true }),
  ).rejects.toThrow("Resolve or explicitly exclude");
  const fixed = await service.review(user, p!.id, {
    revision: r!.revision,
    choices: [{ index: 0, printingId: printing, excluded: false, zone: "main" }],
  });
  expect(fixed!.rows[0].warning).toBeNull();
});
test("pending imports are capped per user", async () => {
  await sql`DELETE FROM rifter_imports WHERE user_id=${other}`;
  for (let i = 0; i < 50; i++)
    await sql`INSERT INTO rifter_imports(user_id,raw_input,source,fingerprint,format,destination,rows,warnings)
      VALUES(${other},'x','s','f'||${i},'text','{}'::jsonb,'[]'::jsonb,'[]'::jsonb)`;
  await expect(
    service.preview(other, {
      rawInput: "1 TST-001",
      source: "Fixture",
      format: "text",
      destination: { kind: "new-deck", name: "Cap", status: "aspiring" },
    }),
  ).rejects.toThrow("Too many unconfirmed imports");
  await sql`DELETE FROM rifter_imports WHERE user_id=${other}`;
});

test("a CSV is read by its headers even when the wrong format was chosen", () => {
  const rifty = "code,name,count\nOGN-002,Brazen Buccaneer,1\nRAD-053,Strigian Oracle,10";
  for (const chosen of ["piltover-csv", "openrift", "rifty"] as const) {
    const parsed = parseInput(chosen, rifty);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1]!.quantity).toBe(10);
    expect(parsed.warnings.length).toBe(chosen === "rifty" ? 0 : 1);
  }
  expect(() => parseInput("rifty", "foo,bar\n1,2")).toThrow(/Missing or duplicate CSV headers/);
});

const previewDefault = (rawInput: string, format: "text" | "openrift" = "text", d: any = dest()) =>
  service.preview(user, { rawInput, source: "Fixture", format, destination: d });
test("default rule picks English, normal finish and keeps every candidate visible", async () => {
  const p = await previewDefault("2 TST-010");
  const row = p!.rows[0];
  expect(row.printingId).toBe(enNormal);
  expect(row.warning).toBeNull();
  expect(row.autoChosen).toBe("English, normal finish (2 other printings)");
  expect(row.candidates.map((c: any) => c.printingId).sort()).toEqual(
    [enNormal, enFoil, frNormal].sort(),
  );
  const deck = await previewDefault("1 TST-010", "text", {
    kind: "new-deck",
    name: "Auto deck",
    status: "aspiring",
  });
  // Deck rows are never auto-picked: that would silently pin preferred_printing_id.
  expect(deck!.rows[0].printingId).toBeNull();
  expect(deck!.rows[0].warning).toBe("Choose a printing");
  expect(deck!.rows[0].autoChosen).toBeUndefined();
});
test("an explicit finish or language in the file overrides the default rule", async () => {
  const foil = await previewDefault(
    "Card ID,Card Name,Quantity,Finish\nTST-010," + defaultName + ",1,foil",
    "openrift",
  );
  expect(foil!.rows[0].printingId).toBe(enFoil);
  const fr = await previewDefault(
    "Card ID,Card Name,Quantity,Language\nTST-010," + defaultName + ",1,French",
    "openrift",
  );
  expect(fr!.rows[0].printingId).toBe(frNormal);
});
test("a card with only a foil English printing still resolves", async () => {
  const p = await previewDefault("1 TST-030");
  expect(p!.rows[0].printingId).toBe(foilOnly);
  expect(p!.rows[0].warning).toBeNull();
});
test("confirming an auto-chosen import applies the right copies; changing it drops the note", async () => {
  const before = await count(),
    p = await previewDefault("3 TST-010");
  const applied = await service.confirm(user, p!.id, {
    revision: p!.revision,
    acknowledgeDuplicate: true,
  });
  expect(applied.status).toBe("applied");
  expect(await count()).toBe(before + 3);
  expect(
    Number(
      (
        await sql`SELECT count(*) AS n FROM copies WHERE collection_id=${collection} AND printing_id=${enNormal}`
      )[0]!.n,
    ),
  ).toBe(3);
  const q = await previewDefault("1 TST-010");
  const same = await service.review(user, q!.id, {
    revision: q!.revision,
    choices: [{ index: 0, printingId: enNormal, excluded: false }],
  });
  expect(same!.rows[0].autoChosen).toBe("English, normal finish (2 other printings)");
  const changed = await service.review(user, q!.id, {
    revision: same!.revision,
    choices: [{ index: 0, printingId: enFoil, excluded: false }],
  });
  expect(changed!.rows[0].autoChosen).toBeUndefined();
  expect(changed!.rows[0].printingId).toBe(enFoil);
});

test("default rule never picks across different cards and honours an explicit art variant", async () => {
  const p = await previewDefault("1 " + defaultName + " same");
  expect(p!.rows[0].candidates.length).toBe(2);
  expect(new Set(p!.rows[0].candidates.map((c: any) => c.cardId)).size).toBe(2);
  expect(p!.rows[0].printingId).toBeNull();
  expect(p!.rows[0].warning).toBe("Choose a printing");
  const art = await previewDefault(
    "Card ID,Card Name,Quantity,Art Variant\nTST-040," + defaultName + " art,1,altart",
    "openrift",
  );
  const row = art!.rows[0];
  expect(row.candidates.length).toBe(2);
  expect(row.candidates.every((c: any) => c.artVariant === "altart")).toBe(true);
  expect(row.autoChosen).toBe("normal finish (1 other printing)");
  expect(row.candidates.find((c: any) => c.printingId === row.printingId).artVariant).toBe("altart");
  // Without the explicit constraint the standard-art step applies.
  const free = await previewDefault("1 TST-040");
  expect(free!.rows[0].printingId).toBe(artNormal);
  expect(free!.rows[0].autoChosen).toBe("normal finish, standard art (2 other printings)");
});
test("a narrowing step that would leave nothing is skipped", async () => {
  const first = await previewDefault("1 TST-050");
  expect(first!.rows[0].candidates.length).toBe(2);
  expect(first!.rows[0].printingId).toBe(enFoilFr[0]);
  expect(first!.rows[0].autoChosen).toBe("English (1 other printing)");
  const second = await previewDefault("1 TST-051");
  expect(second!.rows[0].candidates.length).toBe(2);
  expect(second!.rows[0].printingId).toBe(frBoth[1]);
  expect(second!.rows[0].autoChosen).toBe("normal finish (1 other printing)");
});

// ---------------------------------------------------------------- quick entry by set + digits
let qe: Record<string, string> = {};
beforeAll(async () => {
  const card = async (label: string, rows: { code: string; pub: string; finish?: string; art?: string; markers?: string[] }[]) => {
    const [c] =
      await sql`INSERT INTO cards(name,slug,type) VALUES(${"Quick " + label + " " + user},${user + "-qe-" + label},'unit') RETURNING id`;
    extraCards.push(c!.id);
    for (const r of rows) {
      const [f] =
        await sql`INSERT INTO faces(card_id,set_id,short_code,public_code,art_variant,artist,rarity,finish,language,marker_slugs)
        VALUES(${c!.id},${setId},${r.code},${r.pub},${r.art ?? "normal"},'Fixture','common',${r.finish ?? "normal"},'EN',${r.markers ?? []}) RETURNING id`;
      const [p] = await sql`INSERT INTO printings(face1_id) VALUES(${f!.id}) RETURNING id`;
      qe[`${r.pub}/${r.finish ?? "normal"}`] = p!.id;
    }
  };
  await card("twelve", [
    { code: "TST-112", pub: "TST-112" }, // wrong card: ends in 12
    { code: "TST-120", pub: "TST-120" }, // wrong card: starts with 12
    { code: "TST-2120", pub: "TST-2120" }, // wrong card: 212 followed by another digit
  ]);
  await card("a", [
    { code: "TST-212", pub: "TST-212" },
    { code: "TST-212", pub: "TST-212", finish: "foil" },
    { code: "TST-212a", pub: "TST-212a", art: "altart" },
    { code: "TST-212", pub: "TST-212-P", markers: ["promo"] },
  ]);
  await card("rune", [{ code: "TST-R03", pub: "TST-R03" }]);
  await card("token", [{ code: "TST-T05", pub: "TST-T05" }]);
});
test("number parsing pads plain numbers to three digits and rune/token numbers to two", () => {
  expect(parseCardNumber("rad", "12")!.exact).toBe("RAD-012");
  expect(parseCardNumber("RAD", "012")!.exact).toBe("RAD-012");
  expect(parseCardNumber("RAD", "120")!.exact).toBe("RAD-120");
  expect(parseCardNumber("RAD", "r3")!.exact).toBe("RAD-R03");
  expect(parseCardNumber("UNL", "t5")!.exact).toBe("UNL-T05");
  expect(parseCardNumber("SFD", "149a")).toMatchObject({ base: "SFD-149", exact: "SFD-149A", suffixed: true });
  expect(parseCardNumber("RAD", "76-p")!.exact).toBe("RAD-076-P");
  expect(parseCardNumber("RAD", "abc")).toBeNull();
});
test("set + digits resolve exactly, with variants beneath and no unrelated numbers", async () => {
  const found = await service.search({ set: "tst", number: "212" });
  const exact = found.filter((c) => c.match === "exact");
  expect(exact.map((c) => c.code)).toEqual(["TST-212", "TST-212"]);
  expect(found.slice(0, exact.length)).toEqual(exact); // exact first
  const variants = found.filter((c) => c.match === "variant").map((c) => c.printingId).sort();
  expect(variants).toEqual([qe["TST-212a/normal"]!, qe["TST-212-P/normal"]!].sort());
  expect(found.some((c) => /TST-(112|120|2120)/u.test(c.code))).toBe(false);
  // The default rule picks the normal finish among the exact printings; the foil stays listed.
  const picked = found.filter((c) => c.isDefault);
  expect(picked.map((c) => c.printingId)).toEqual([qe["TST-212/normal"]!]);
  expect(picked[0]!.defaultNote).toContain("normal finish");
  expect(found.some((c) => c.printingId === qe["TST-212/foil"])).toBe(true);
  // 12 pads to 012, which this fixture set does not have, and never matches 112 or 120.
  expect(await service.search({ set: "TST", number: "12" })).toEqual([]);
  // A letter or promo suffix makes that form the exact match.
  const lettered = await service.search({ set: "TST", number: "212a" });
  expect(lettered.filter((c) => c.match === "exact").map((c) => c.printingId)).toEqual([qe["TST-212a/normal"]!]);
  const promo = await service.search({ set: "TST", number: "212-p" });
  expect(promo.filter((c) => c.match === "exact").map((c) => c.printingId)).toEqual([qe["TST-212-P/normal"]!]);
});
test("rune and token numbers, full codes, short numbers and names still resolve", async () => {
  expect((await service.search({ set: "TST", number: "r3" }))[0]).toMatchObject({ code: "TST-R03", match: "exact", isDefault: true });
  expect((await service.search({ set: "TST", number: "T5" }))[0]).toMatchObject({ code: "TST-T05", match: "exact" });
  expect((await service.search({ q: "TST-120" }))[0]).toMatchObject({ code: "TST-120", match: "exact" });
  expect((await service.search({ q: "tst-20" })).length).toBe(0); // TST-020 does not exist, 120 is not 20
  expect((await service.search({ q: "TST-R3" }))[0]).toMatchObject({ code: "TST-R03" });
  expect((await service.search({ q: "Quick rune" }))[0]).toMatchObject({ code: "TST-R03" });
  const sets = await service.sets();
  expect(sets.find((x) => x.code === "TST")).toBeTruthy();
});
test("search validation allows one to three digits with a set but not a lone digit", () => {
  expect(rifterSearchQuery.safeParse({ set: "RAD", number: "1" }).success).toBe(true);
  expect(rifterSearchQuery.safeParse({ set: "RAD", number: "R03" }).success).toBe(true);
  expect(rifterSearchQuery.safeParse({ set: "SFD", number: "149A" }).success).toBe(true);
  expect(rifterSearchQuery.safeParse({ q: "1" }).success).toBe(false);
  expect(rifterSearchQuery.safeParse({ q: "RAD-120" }).success).toBe(true);
  expect(rifterSearchQuery.safeParse({ set: "RAD" }).success).toBe(false);
  expect(rifterSearchQuery.safeParse({ number: "12" }).success).toBe(false);
  expect(rifterSearchQuery.safeParse({ set: "R", number: "12" }).success).toBe(false);
});

// ---------------------------------------------------------------- replace a collection
const binder = async (name = "Replace binder") =>
  (await sql`INSERT INTO collections(user_id,name) VALUES(${user},${name}) RETURNING id`)[0]!.id as string;
const seed = async (id: string, printingId: string, n: number, extra: Record<string, unknown> = {}): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      (await sql`INSERT INTO copies(collection_id,printing_id,notes_private) VALUES(${id},${printingId},${(extra.notes as string) ?? null}) RETURNING id`)[0]!.id,
    );
    await Bun.sleep(3); // distinct created_at ordering
  }
  return ids;
};
const copiesOf = async (id: string) =>
  (await sql`SELECT id,printing_id,notes_private FROM copies WHERE collection_id=${id} ORDER BY created_at,id`) as unknown as {
    id: string;
    printing_id: string;
    notes_private: string | null;
  }[];
const replaceDest = (id: string) => ({ kind: "collection" as const, id, mode: "replace" as const });
const stagedReplace = (id: string, raw: string, d: any = replaceDest(id)) =>
  service.preview(user, { rawInput: raw, source: "Replace fixture", format: "text", destination: d });
const apply = (p: any, extra: Record<string, unknown> = {}) =>
  service.confirm(user, p.id, { revision: p.revision, acknowledgeDuplicate: false, ...extra } as any);
let replaceFixture: { id: string; keepNotes: string; plainOld: string; newest: string };
test("replace diff: adds, removes and changes per printing, keeping other finishes and copies with notes", async () => {
  const id = await binder();
  const [oldPlain, notes, newestPlain] = [
    ...(await seed(id, enNormal, 1)),
    ...(await seed(id, enNormal, 1, { notes: "keep me" })),
    ...(await seed(id, enNormal, 1)),
  ] as [string, string, string];
  const [foilCopy] = await seed(id, enFoil, 1);
  await seed(id, foilOnly, 2);
  await seed(id, printing, 2); // card the file does not list at all
  const p = await stagedReplace(id, "2 TST-010\n3 TST-030\n1 TST-040");
  const record = await service.import(user, p!.id);
  const diff = record.replaceDiff!;
  expect(diff.refusal).toBeNull();
  expect(diff.printings).toEqual({ added: 1, removed: 1, changed: 2, unchanged: 0 });
  expect(diff.copies).toMatchObject({ added: 2, removed: 3, total: 8, untouched: 1 });
  expect(diff.lines.filter((l) => l.kind === "removed").map((l) => l.printingId)).toEqual([printing]);
  expect(record.duplicates).toEqual([]);
  expect((await copiesOf(id)).length).toBe(8);
  const result = await apply(p!, { expectedChange: { added: 2, removed: 3 } });
  expect(result.change).toEqual({ added: 2, removed: 3 });
  const after = await copiesOf(id);
  const ids = after.map((c) => c.id);
  expect(ids).toContain(notes); // metadata-bearing copy survives
  expect(ids).toContain(oldPlain); // oldest plain copy kept
  expect(ids).not.toContain(newestPlain); // surplus: newest plain copy goes
  expect(ids).toContain(foilCopy!); // other finish of a listed card is left alone
  const per = (pid: string) => after.filter((c) => c.printing_id === pid).length;
  expect([per(enNormal), per(enFoil), per(foilOnly), per(artNormal), per(printing)]).toEqual([2, 1, 3, 1, 0]);
  replaceFixture = { id, keepNotes: notes!, plainOld: oldPlain!, newest: newestPlain! };
  const history = (await service.overview(user)).actions.find((a) => a.id === result.actionId)!;
  expect(history.label).toBe("Replace collection import");
});
test("the same replace file applied again changes nothing and needs no duplicate acknowledgement", async () => {
  const { id } = replaceFixture;
  const before = await copiesOf(id);
  const p = await stagedReplace(id, "2 TST-010\n3 TST-030\n1 TST-040");
  const diff = (await service.import(user, p!.id)).replaceDiff!;
  expect(diff.copies).toMatchObject({ added: 0, removed: 0 });
  expect(diff.printings).toMatchObject({ added: 0, removed: 0, changed: 0, unchanged: 3 });
  const again = await apply(p!);
  expect(again.status).toBe("applied");
  expect(again.change).toEqual({ added: 0, removed: 0 });
  expect(again.actionId).toBeUndefined();
  expect((await copiesOf(id)).map((c) => c.id)).toEqual(before.map((c) => c.id));
});
test("undoing a replace restores the removed copies with their original rows", async () => {
  const id = await binder("Undo binder");
  const [a, b] = (await seed(id, enNormal, 2, { notes: "orig" })) as [string, string];
  await seed(id, printing, 1);
  const p = await stagedReplace(id, "1 TST-010");
  const done = await apply(p!, { acknowledgeRemoval: true });
  expect((await copiesOf(id)).map((c) => c.id)).toEqual([a]);
  await service.undo(user, done.actionId!);
  const restored = await copiesOf(id);
  expect(restored.map((c) => c.id).sort()).toEqual([a, b, restored.find((c) => c.printing_id === printing)!.id].sort());
  expect(restored.filter((c) => c.printing_id === enNormal).every((c) => c.notes_private === "orig")).toBe(true);
  expect((await service.import(user, p!.id)).status).toBe("undone");
});
test("replace refuses a file with no resolvable rows and never empties the collection", async () => {
  const id = await binder("Refuse binder");
  await seed(id, enNormal, 2);
  const garbage = await stagedReplace(id, "1 NOPE-999");
  expect(garbage!.rows[0].candidates.length).toBe(0);
  await expect(apply(garbage!)).rejects.toThrow("Resolve");
  const excluded = await service.review(user, garbage!.id, {
    revision: garbage!.revision,
    choices: [{ index: 0, printingId: null, excluded: true }],
  });
  await expect(apply(excluded!, { acknowledgeRemoval: true })).rejects.toThrow("Replace refused");
  const unparsed = await service.preview(user, {
    rawInput: 'code,name,count\nTST-001,"broken',
    source: "bad",
    format: "rifty",
    destination: replaceDest(id),
  });
  await expect(apply(unparsed!, { acknowledgeRemoval: true })).rejects.toThrow("Replace refused");
  expect((await service.import(user, excluded!.id)).replaceDiff!.refusal).toContain("no resolvable rows");
  expect((await copiesOf(id)).length).toBe(2);
});
test("removing more than half of a collection needs an explicit acknowledgement", async () => {
  const id = await binder("Big removal");
  await seed(id, printing, 3);
  await seed(id, enNormal, 1);
  const half = await stagedReplace(id, "1 TST-010\n1 TST-001"); // removes 2 of 4: exactly half
  expect((await service.import(user, half!.id)).replaceDiff!.needsRemovalAcknowledgement).toBe(false);
  const big = await stagedReplace(id, "1 TST-010"); // removes 3 of 4
  const diff = (await service.import(user, big!.id)).replaceDiff!;
  expect(diff.needsRemovalAcknowledgement).toBe(true);
  await expect(apply(big!)).rejects.toThrow("removal acknowledgement");
  expect((await copiesOf(id)).length).toBe(4);
  await expect(
    apply(big!, { acknowledgeRemoval: true, expectedChange: { added: 0, removed: 1 } }),
  ).rejects.toThrow("changed since the preview");
  await apply(big!, { acknowledgeRemoval: true, expectedChange: { added: 0, removed: 3 } });
  expect((await copiesOf(id)).length).toBe(1);
});
test("replace only works on the caller's own collections", async () => {
  const id = await binder("Private binder");
  await seed(id, enNormal, 1);
  await expect(
    service.preview(other, {
      rawInput: "1 TST-010",
      source: "",
      format: "text",
      destination: replaceDest(id),
    }),
  ).rejects.toThrow("not found");
  const p = await stagedReplace(id, "1 TST-010");
  await expect(service.confirm(other, p!.id, { revision: p!.revision, acknowledgeDuplicate: false })).rejects.toThrow("not found");
});
test("unresolved and excluded rows never cause the cards they could be to be deleted", async () => {
  const id = await binder("Skipped rows");
  const [altart] = (await sql`SELECT p.id FROM printings p JOIN faces f ON f.id=p.face1_id WHERE f.short_code='TST-021' AND f.art_variant='altart'`).map((r) => r.id as string);
  await seed(id, altart!, 2);
  await seed(id, enNormal, 1);
  const p = await stagedReplace(id, "1 TST-001\n2 TST-021");
  expect(p!.rows[1].printingId).toBeNull();
  const pending = (await service.import(user, p!.id)).replaceDiff!;
  expect(pending.skippedRows).toBe(1);
  expect(pending.lines.map((l) => l.printingId)).toContain(enNormal); // genuinely absent card is removed
  expect(pending.lines.map((l) => l.printingId)).not.toContain(altart); // ambiguous row protects its cards
  await expect(apply(p!)).rejects.toThrow("Resolve"); // unresolved row blocks confirm
  const reviewed = await service.review(user, p!.id, {
    revision: p!.revision,
    choices: [
      { index: 0, printingId: printing, excluded: false },
      { index: 1, printingId: null, excluded: true },
    ],
  });
  const done = await apply(reviewed!, { acknowledgeRemoval: true });
  expect(done.change).toEqual({ added: 1, removed: 1 });
  const left = await copiesOf(id);
  expect(left.filter((c) => c.printing_id === altart).length).toBe(2);
  expect(left.filter((c) => c.printing_id === printing).length).toBe(1);
  expect(left.filter((c) => c.printing_id === enNormal).length).toBe(0);
});

// ---------------------------------------------------------------- review triage
test("a code that matches with a different name stays a visible candidate that needs acceptance", async () => {
  const id = await binder("Name differs");
  const p = await service.preview(user, {
    rawInput: "code,name,count\nTST-010,Totally Other Name,2",
    source: "Fixture",
    format: "rifty",
    destination: { kind: "collection", id, mode: "add" },
  });
  const row = p!.rows[0];
  expect(row.candidates.length).toBe(3);
  expect(row.printingId).toBeNull(); // never assigned silently, even though English/normal is the default
  expect(row.autoChosen).toBeUndefined();
  expect(row.warning).toBe(
    `Name differs from the catalog (Totally Other Name vs ${defaultName}); check it is the right card, then choose the printing`,
  );
  await expect(apply(p!)).rejects.toThrow("Resolve");
  const kept = await service.review(user, p!.id, {
    revision: p!.revision,
    choices: [{ index: 0, printingId: null, excluded: false }],
  });
  expect(kept!.rows[0].warning).toContain("Name differs"); // saving without a choice keeps the reason
  const accepted = await service.review(user, p!.id, {
    revision: kept!.revision,
    choices: [{ index: 0, printingId: enNormal, excluded: false }],
  });
  expect(accepted!.rows[0].warning).toBeNull();
  await apply(accepted!);
  expect((await copiesOf(id)).map((c) => c.printing_id)).toEqual([enNormal, enNormal]);
});
test("a name that differs only by punctuation or case is not a warning", async () => {
  const id = await binder("Punctuation");
  const p = await service.preview(user, {
    rawInput: "code,name,count\nTST-010," + defaultName.replace(" default ", " - DEFAULT ") + ",1",
    source: "Fixture",
    format: "rifty",
    destination: { kind: "collection", id, mode: "add" },
  });
  expect(p!.rows[0].warning).toBeNull();
  expect(p!.rows[0].printingId).toBe(enNormal);
});
test("an unmatched row says why in plain words and keeps saying it after a save", async () => {
  const id = await binder("Unmatched");
  const p = await service.preview(user, {
    rawInput: "1 NOPE-999\n1 Nonexistent Card Zzz",
    source: "Fixture",
    format: "text",
    destination: { kind: "collection", id, mode: "add" },
  });
  expect(p!.rows[0].warning).toContain("Code NOPE-999 not found in the catalog");
  expect(p!.rows[0].warning).toContain("rune, token and promo codes may differ");
  expect(p!.rows[1].warning).toContain('No card named "Nonexistent Card Zzz"');
  const saved = await service.review(user, p!.id, {
    revision: p!.revision,
    choices: [
      { index: 0, printingId: null, excluded: false },
      { index: 1, printingId: null, excluded: true },
    ],
  });
  expect(saved!.rows[0].warning).toContain("not found in the catalog");
  expect(saved!.rows[1].warning).toBe("Explicitly excluded");
  const undone = await service.review(user, p!.id, {
    revision: saved!.revision,
    choices: [{ index: 1, printingId: null, excluded: false }],
  });
  expect(undone!.rows[1].warning).toContain("No card named");
});

test("token rows start excluded and visible; runes do not; the user can take a token back", async () => {
  const id = await binder("Tokens");
  const p = await service.preview(user, {
    rawInput: "code,name,count\nTST-T05,Some Token,3\nTST-R03,Quick rune user,2\nTST-010," + defaultName + " // Back,1\nTST-010," + defaultName + ",1",
    source: "Fixture",
    format: "rifty",
    destination: { kind: "collection", id, mode: "add" },
  });
  const rows = p!.rows;
  // T05 is not in the catalog as TST-T05 here, but the code alone marks it a token.
  expect(rows[0]).toMatchObject({ excluded: true, autoExcluded: "token", warning: "Ignored: token" });
  expect(rows[1].autoExcluded).toBeUndefined(); // rune: ordinary tracked card
  expect(rows[1].excluded).toBe(false);
  expect(rows[2]).toMatchObject({ excluded: true, autoExcluded: "token" }); // double-sided name
  expect(rows[3].excluded).toBe(false);
  // Saving keeps the token ignored and its reason; unticking exclude is the explicit override.
  const kept = await service.review(user, p!.id, {
    revision: p!.revision,
    choices: [{ index: 0, printingId: null, excluded: true }],
  });
  expect(kept!.rows[0]).toMatchObject({ excluded: true, autoExcluded: "token", warning: "Ignored: token" });
  const back = await service.review(user, p!.id, {
    revision: kept!.revision,
    choices: [{ index: 2, printingId: enNormal, excluded: false }],
  });
  expect(back!.rows[2].autoExcluded).toBeUndefined();
  expect(back!.rows[2].excluded).toBe(false);
  expect(back!.rows[2].warning).toBeNull();
});
test("a token resolved to a catalog printing by name is ignored by its catalog code, runes never", async () => {
  const [c] = await sql`INSERT INTO cards(name,slug,type) VALUES(${"Token card " + user},${user + "-tok"},'unit') RETURNING id`;
  extraCards.push(c!.id);
  const [f] = await sql`INSERT INTO faces(card_id,set_id,short_code,public_code,art_variant,artist,rarity,finish,language)
    VALUES(${c!.id},${setId},'TST-T77','TST-T77','normal','Fixture','common','normal','EN') RETURNING id`;
  const [tp] = await sql`INSERT INTO printings(face1_id) VALUES(${f!.id}) RETURNING id`;
  const id = await binder("Token by name");
  const p = await service.preview(user, {
    rawInput: "1 Token card " + user + "\n1 TST-R03",
    source: "Fixture",
    format: "text",
    destination: { kind: "collection", id, mode: "add" },
  });
  expect(p!.rows[0]).toMatchObject({ excluded: true, autoExcluded: "token", printingId: tp!.id });
  expect(p!.rows[1].autoExcluded).toBeUndefined();
});
test("replace never deletes owned copies because a token row was auto-excluded", async () => {
  const id = await binder("Replace tokens");
  const [tokCard] = (await sql`SELECT f.card_id AS id FROM faces f WHERE f.short_code='TST-T77'`).map((r) => r.id as string);
  const [tokPrinting] = (await sql`SELECT p.id FROM printings p JOIN faces f ON f.id=p.face1_id WHERE f.short_code='TST-T77'`).map((r) => r.id as string);
  expect(tokCard).toBeTruthy();
  await seed(id, tokPrinting!, 2);
  await seed(id, enNormal, 1);
  const p = await stagedReplace(id, "2 TST-010\n5 TST-T77");
  expect(p!.rows[1].autoExcluded).toBe("token");
  const diff = (await service.import(user, p!.id)).replaceDiff!;
  expect(diff.skippedRows).toBe(1);
  expect(diff.lines.map((l) => l.printingId)).not.toContain(tokPrinting);
  const done = await apply(p!);
  expect(done.change).toEqual({ added: 1, removed: 0 });
  const left = await copiesOf(id);
  expect(left.filter((c) => c.printing_id === tokPrinting).length).toBe(2); // untouched, not set to 5
  expect(left.filter((c) => c.printing_id === enNormal).length).toBe(2);
  // A file that is only tokens leaves nothing to compare: replace is refused.
  const tokensOnly = await stagedReplace(id, "1 TST-T77");
  await expect(apply(tokensOnly!, { acknowledgeRemoval: true })).rejects.toThrow("Replace refused");
});
