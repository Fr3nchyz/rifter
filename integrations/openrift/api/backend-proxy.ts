// Railway exposes this gateway; the native API remains on its internal port.
import { serveCatalogImage } from "./media.js";

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/media/")) {
      try { return await serveCatalogImage(url.pathname); }
      catch { return new Response("Image unavailable", { status: 502 }); }
    }
    if (!url.pathname.startsWith("/api/"))
      return new Response("Rifter backend. Open the configured Vercel app to sign in.", { status: 404 });
    try {
      return await fetch("http://127.0.0.1:3000" + url.pathname + url.search, {
        method: req.method, headers: req.headers, body: req.body,
        redirect: "manual", signal: AbortSignal.timeout(60000),
      });
    } catch {
      return new Response("Backend unavailable; please retry shortly.", {
        status: 503, headers: { "Retry-After": "2", "Cache-Control": "no-store" },
      });
    }
  },
});
