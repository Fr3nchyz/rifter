// Local bundled runtime: one origin for the native app, auth, API and images.
import { serveCatalogImage } from "./media.js";
const port = Number(process.env.PROXY_PORT ?? 5173);
const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/media/")) {
      try {
        return await serveCatalogImage(url.pathname);
      } catch {
        return new Response("Image unavailable", { status: 502 });
      }
    }
    const target = url.pathname.startsWith("/api/")
      ? "http://127.0.0.1:3000"
      : "http://127.0.0.1:5174";
    try {
      const upstream = await fetch(target + url.pathname + url.search, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "manual",
      });
      const headers = new Headers(upstream.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    } catch {
      return new Response("The app is starting. Please try again shortly.", {
        status: 503,
        headers: { "Retry-After": "2" },
      });
    }
  },
});
console.log(`Rifter bundled app listening on port ${server.port}`);
