import { afterAll, beforeAll, expect, test } from "bun:test";

import { parseInput, csvRows } from "./parse.js";
import { createRifterService } from "./service.js";
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
  setId: string;
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
afterAll(async () => {
  await sql`DELETE FROM users WHERE id IN (${user},${other})`;
  await sql`DELETE FROM printings WHERE id IN (${printing},${foil})`;
  await sql`DELETE FROM faces WHERE card_id IN (${card},${backCard})`;
  await sql`DELETE FROM cards WHERE id IN (${card},${backCard})`;
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
    rawInput: "2 TST-001",
    source: "Test",
    format: "acquisition",
    destination: dest(),
  });
  expect(p!.rows[0].candidates.length).toBe(2);
  expect(p!.rows[0].printingId).toBeNull();
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
