import {
  rifterPreviewRequest,
  rifterReviewRequest,
  rifterConfirmRequest,
  rifterDeckStateRequest,
} from "@openrift/shared/contracts/rifter";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { loadSession } from "../../middleware/load-session.js";
import type { Variables } from "../../types.js";
import { createRifterService, RifterError } from "./service.js";
import { createShopping } from "./shopping.js";
import { workspaceHtml } from "./workspace.js";

export function createRifterRoutes(databaseUrl: string) {
  const app = new Hono<{ Variables: Variables }>();
  const service = createRifterService(databaseUrl);
  const shopping = createShopping(service.db);
  app.use("*", loadSession);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const publicShell = c.req.method === "GET" && c.req.path === "/api/v1/rifter/ui";
    if (!c.get("user") && !publicShell) return c.json({ error: "Sign in to OpenRift first" }, 401);
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const forwarded = c.req.header("host");
      const fetchSite = c.req.header("sec-fetch-site");
      if (!origin && fetchSite !== "same-origin")
        return c.json({ error: "Origin required" }, 403);
      if (origin) {
        let trusted = false;
        try {
          const supplied = new URL(origin);
          const configured = process.env.BETTER_AUTH_URL;
          trusted = ["http:", "https:"].includes(supplied.protocol) &&
            (supplied.host === forwarded || Boolean(configured && supplied.origin === new URL(configured).origin));
        } catch { /* malformed origins are not trusted */ }
        // A Vercel rewrite reaches a different backend Host. Trust the exact
        // configured frontend origin, never arbitrary forwarded host headers.
        if (!trusted) return c.json({ error: "Cross-origin mutation rejected" }, 403);
      }
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "JSON required" }, 415);
      const length = Number(c.req.header("content-length") ?? 0);
      if (length > 6_000_000) return c.json({ error: "Request too large" }, 413);
    }
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof z.ZodError)
      return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
    if (err instanceof RifterError) return c.json({ error: err.message }, err.status as 400);
    const code = (err as { code?: string }).code;
    if (code === "40001" || code === "23503" || code === "23505")
      return c.json(
        {
          error:
            code === "40001"
              ? err.message
              : "Conflicting edits or referenced data changed. Reload and review.",
        },
        409,
      );
    if (code === "P0002") return c.json({ error: "Action not found" }, 404);
    if (code?.startsWith("23"))
      return c.json({ error: "Invalid card metadata or reference; nothing was applied." }, 400);
    console.error("Rifter request failed", err.name, code ?? "");
    return c.json({ error: "Request failed; nothing was partially applied." }, 500);
  });
  const user = (c: Context<{ Variables: Variables }>) => c.get("user")!.id;
  const id = (value: string) => z.uuid().parse(value);
  async function body(c: Context<{ Variables: Variables }>) {
    const text = await c.req.text();
    if (text.length > 6_000_000) throw new RifterError(413, "Request too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new RifterError(400, "Invalid JSON");
    }
  }
  app.get("/ui", (c) => {
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    );
    return c.html(workspaceHtml);
  });
  app.get("/overview", async (c) => c.json(await service.overview(user(c))));
  app.get("/search", async (c) => {
    const q = z.string().trim().min(2).max(150).parse(c.req.query("q"));
    return c.json(await service.search(q));
  });
  app.post("/imports", async (c) => {
    const input = rifterPreviewRequest.parse(await body(c));
    try {
      return c.json(await service.preview(user(c), input), 201);
    } catch (e) {
      if (e instanceof RifterError) throw e;
      if (e instanceof Error && !(e as { code?: string }).code)
        throw new RifterError(400, e.message);
      throw e;
    }
  });
  app.get("/imports/:id", async (c) =>
    c.json(await service.import(user(c), id(c.req.param("id")))),
  );
  app.patch("/imports/:id", async (c) =>
    c.json(
      await service.review(
        user(c),
        id(c.req.param("id")),
        rifterReviewRequest.parse(await body(c)),
      ),
    ),
  );
  app.post("/imports/:id/confirm", async (c) =>
    c.json(
      await service.confirm(
        user(c),
        id(c.req.param("id")),
        rifterConfirmRequest.parse(await body(c)),
      ),
    ),
  );
  app.patch("/decks/:id/status", async (c) => {
    const input = rifterDeckStateRequest.parse(await body(c));
    return c.json(await service.setDeckStatus(user(c), id(c.req.param("id")), input.status));
  });
  app.get("/decks/:id/gaps", async (c) =>
    c.json(
      await service.gaps(
        user(c),
        id(c.req.param("id")),
        c.req.query("sideboard") !== "false",
        c.req.query("strict") === "true",
      ),
    ),
  );
  app.post("/actions/:id/undo", async (c) =>
    c.json(await service.undo(user(c), id(c.req.param("id")))),
  );
  app.get("/shopping/status", async (c) => c.json(await shopping.status(user(c))));
  app.post("/shopping/snapshot", async (c) => {
    const input = z.object({ csv: z.string().min(1).max(5_000_000) }).parse(await body(c));
    return c.json(await shopping.snapshot(user(c), input.csv), 201);
  });
  app.post("/shopping/refresh", async (c) => {
    z.object({ storePermission: z.literal(true) }).parse(await body(c));
    return c.json(await shopping.refresh(user(c)), 202);
  });
  app.post("/shopping/cancel", async (c) => c.json(await shopping.cancel(user(c))));
  app.post("/shopping/compare", async (c) => {
    const input = z
      .object({ deckIds: z.array(z.uuid()).min(1).max(10), sideboard: z.boolean().default(true) })
      .parse(await body(c));
    const comparisons = [];
    for (const deckId of [...new Set(input.deckIds)]) {
      const gaps = await service.gaps(user(c), deckId, input.sideboard, false);
      comparisons.push({
        deckId,
        ...(await shopping.compare(
          user(c),
          gaps.map((r) => ({ name: r.name, count: r.missing, section: r.zone })),
        )),
      });
    }
    return c.json(comparisons);
  });
  return app;
}
