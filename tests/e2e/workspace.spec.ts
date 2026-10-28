import { randomBytes } from "node:crypto";

import { test, expect } from "@playwright/test";

test("signup, reviewed code acquisition, deck gap and undo work on a phone viewport", async ({
  page,
  browser,
  baseURL,
}) => {
  const scriptErrors: string[] = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  let request = page.request;
  const email = "rifter-browser-" + Date.now() + "@example.test";
  const password = randomBytes(20).toString("hex");
  await page.goto("/signup");
  await expect
    .poll(() =>
      page
        .locator("form")
        .evaluate((e) => Object.keys(e).some((k) => k.startsWith("__reactProps"))),
    )
    .toBe(true);
  await page.locator('input[name="name"]').fill("Rifter Browser");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  const submitted = page.waitForResponse((r) => r.url().endsWith("/api/auth/sign-up/email"));
  await page.locator('form button[type="submit"]').click();
  const signup = await submitted;
  expect(signup.ok()).toBeTruthy();
  let otp: string | undefined;
  await expect
    .poll(
      async () => {
        const messages = await (await request.get("http://localhost:8025/api/v1/messages")).json();
        const message = messages.messages.find((m: any) =>
          m.To.some((t: any) => t.Address === email),
        );
        if (!message) return false;
        const body = await (
          await request.get("http://localhost:8025/api/v1/message/" + message.ID)
        ).json();
        otp = (body.Text || body.HTML).match(/\b\d{6}\b/)?.[0];
        return Boolean(otp);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page.waitForURL(/\/verify-email/u);
  const verifying = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/email-otp/verify-email"),
  );
  await page.locator('input[autocomplete="one-time-code"]').fill(otp!);
  const verification = await verifying;
  expect(verification.ok()).toBeTruthy();
  await page.waitForURL(/\/collections/u);
  // Sign in independently, as on a phone after creating the account on a
  // computer. Do not race an out-of-band API signout against SPA navigation.
  await page.close();
  const phone = await browser.newContext({ baseURL });
  // Plain HTTP home-network origins do not expose crypto.randomUUID(). Form
  // controls must still render and native ownership/deck actions must work.
  await phone.addInitScript(() =>
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    }),
  );
  page = await phone.newPage();
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  request = page.request;
  await page.goto("/login");
  await expect
    .poll(() =>
      page
        .locator("form")
        .evaluate((e) => Object.keys(e).some((k) => k.startsWith("__reactProps"))),
    )
    .toBe(true);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  const signedIn = page.waitForResponse((r) => r.url().endsWith("/api/auth/sign-in/email"));
  await page.locator('form button[type="submit"]').click();
  expect((await signedIn).ok()).toBeTruthy();
  const initial = await (await request.get("/api/v1/rifter/overview")).json();
  expect(initial.collections.length).toBeGreaterThan(0);
  const baseline = initial.collections.reduce((n: number, c: any) => n + c.quantity, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/rifter");
  await expect(page.getByRole("heading", { name: "My collection", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My lists", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Imports", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New collection", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByRole("textbox").fill("Browser collection");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/collections\/[a-f0-9-]+$/u);
  await page.goto("/rifter");
  await page.getByRole("button", { name: "Add cards", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/collections\/[a-f0-9-]+$/u);
  const catalogSearch = page.getByRole("textbox", { name: "Search…", exact: true });
  await expect(catalogSearch).toBeVisible();
  await catalogSearch.fill("OGN-123");
  await expect.poll(() => new URL(page.url()).searchParams.get("search")).toBe("OGN-123");
  await page.goto("/rifter");
  await page.getByRole("button", { name: "New wishlist", exact: true }).click();
  const wishlist = page.getByRole("dialog");
  await wishlist.getByRole("textbox").first().fill("Browser wishlist");
  await wishlist.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/collections\/lists\/[a-f0-9-]+$/u);
  await page.goto("/rifter");
  await page.getByRole("button", { name: "Code batch", exact: true }).click();
  const ui = page.frameLocator('iframe[title="Rifter collection tools"]');
  await expect(
    ui.getByRole("heading", { name: "Add new acquisitions", exact: true }),
  ).toBeVisible();
  await ui.getByLabel("Collector code or card name").fill("OGN-123");
  await ui.getByRole("button", { name: "Find card", exact: true }).click();
  await ui.getByRole("button", { name: "Add to batch", exact: true }).first().click();
  await ui
    .getByLabel("Destination collection", { exact: true })
    .selectOption({ label: "Browser collection" });
  await ui.getByRole("button", { name: "Review batch", exact: true }).click();
  await expect(ui.getByRole("heading", { name: "Review before applying" })).toBeVisible();
  const pending = await (await request.get("/api/v1/rifter/overview")).json();
  expect(pending.collections.reduce((n: number, c: any) => n + c.quantity, 0)).toBe(baseline);
  await ui.getByRole("button", { name: "Confirm and apply", exact: true }).click();
  await expect(
    ui.getByText("Applied successfully. You can reverse this action from History."),
  ).toBeVisible();
  const owned = await (await request.get("/api/v1/rifter/overview")).json();
  expect(owned.collections.reduce((n: number, c: any) => n + c.quantity, 0)).toBe(baseline + 1);
  const acquisition = owned.actions.find((a: any) => a.label === "Apply import / acquisition");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My collection", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("link")
      .filter({ has: page.getByRole("heading", { name: "Browser collection", exact: true }) }),
  ).toContainText("1 card");
  const p = await (
    await request.post("/api/v1/rifter/imports", {
      data: {
        rawInput: "3 OGN-123",
        source: "Browser fixture",
        format: "text",
        destination: { kind: "new-deck", name: "Browser aspiring deck", status: "aspiring" },
      },
    })
  ).json();
  const chosen = p.rows[0].candidates[0].printingId;
  const reviewed = await (
    await request.patch("/api/v1/rifter/imports/" + p.id, {
      data: { revision: p.revision, choices: [{ index: 0, printingId: chosen, excluded: false }] },
    })
  ).json();
  const confirmed = await request.post("/api/v1/rifter/imports/" + p.id + "/confirm", {
    data: { revision: reviewed.revision },
  });
  expect(confirmed.ok()).toBeTruthy();
  const deck = await confirmed.json();
  const cover = await request.patch("/api/v1/decks/" + deck.deckId, {
    data: { coverCardId: p.rows[0].candidates[0].cardId },
  });
  expect(cover.ok()).toBeTruthy();
  let gap = await (await request.get("/api/v1/rifter/decks/" + deck.deckId + "/gaps")).json();
  expect(gap.reduce((n: number, r: any) => n + r.missing, 0)).toBe(2);
  await page.goto("/rifter");
  await page.getByLabel("Choose a deck", { exact: true }).selectOption(deck.deckId);
  await page.getByRole("link", { name: "Open deck", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/decks/" + deck.deckId);
  await expect(
    page.getByText("Browser aspiring deck", { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /1\/3 owned.*2 missing/u }).click();
  await expect(page.getByRole("heading", { name: "Missing cards (2)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add to wishlist", exact: true }).click();
  await page.getByRole("dialog").last().getByText("Browser wishlist", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Missing cards (2)", exact: true }),
  ).not.toBeVisible();
  await page.goto("/rifter");
  await expect(page.getByRole("link").filter({ hasText: "Browser wishlist" })).toContainText(
    "1 entry",
  );
  await page.goto("/rifter#history");
  const action = ui
    .locator(".entry")
    .filter({ has: ui.getByRole("heading", { name: "Apply import / acquisition", exact: true }) })
    .last();
  await action.getByRole("button", { name: "Undo action", exact: true }).click();
  await expect(ui.getByText("Reversal recorded.")).toBeVisible();
  gap = await (await request.get("/api/v1/rifter/decks/" + deck.deckId + "/gaps")).json();
  expect(gap.reduce((n: number, r: any) => n + r.missing, 0)).toBe(3);
  const bad = await request.post("/api/v1/rifter/imports", {
    headers: { Origin: "https://evil.example" },
    data: {},
  });
  expect(bad.status()).toBe(403);
  await page.goto("/rifter");
  await expect(page.getByRole("heading", { name: "My collection", exact: true })).toBeVisible();
  await page.screenshot({ path: ".local/browser-results/rifter-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Local shopping", exact: true }).click();
  const cardName = p.rows[0].candidates[0].name;
  const inventory =
    "name,game,verification,url,evidence_url,checked_at,collector_number,version,finish,condition,price_cad,stock\n" +
    JSON.stringify(cardName) +
    ",Riftbound,manual,https://www.gamekeeperverdun.com/fixture-card,https://www.gamekeeperverdun.com/category,2026-01-01T00:00:00Z,123,Base,Normal,NM,2.50,2\n";
  await ui.getByLabel("Or load an existing verified inventory CSV").setInputFiles({
    name: "fixture-inventory.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(inventory),
  });
  await ui.getByRole("button", { name: "Validate and load snapshot", exact: true }).click();
  await expect(ui.getByText(/1 inventory rows/u)).toBeVisible();
  await ui.getByLabel("Browser aspiring deck · aspiring", { exact: true }).check();
  await ui.getByRole("button", { name: "Compare selected decks", exact: true }).click();
  await expect(
    ui.getByText("2 copies found · 1 unfilled · CAD 5.00 available-copy subtotal"),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await ui.getByRole("button", { name: "Export comparison CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("rifter-shopping.csv");
  await page.goto("/decks/import");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/rifter");
  await expect(ui.getByRole("heading", { name: "Quarantine a new list" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.screenshot({ path: ".local/browser-results/rifter-home-desktop.png", fullPage: true });
  expect(scriptErrors).toEqual([]);
  await phone.close();
});
