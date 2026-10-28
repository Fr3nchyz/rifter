import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const media = process.env.MEDIA_DIR ?? path.resolve(import.meta.dir, "../../../../../media");
const source = (process.env.CATALOG_SOURCE_URL ?? "https://openrift.app").replace(/\/$/u, "");
const types: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg" };

const SAFE_PATH = /^cards\/[A-Za-z0-9_-]{1,80}(?:-\d{2,4}w)?\.(?:webp|png|jpg)$/u;
const CATALOG_PATH = /^cards\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{2,4}w\.webp$/iu;
const CACHE_LIMIT = 2 * 1024 ** 3;

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
    }
  } catch { /* missing directory counts as empty */ }
  return total;
}

export async function serveCatalogImage(pathname: string) {
  let relative: string;
  try { relative = decodeURIComponent(pathname.slice("/media/".length)); }
  catch { return new Response("Not found", { status: 404 }); }
  if (!SAFE_PATH.test(relative)) return new Response("Not found", { status: 404 });
  const file = path.resolve(media, relative);
  if (!file.startsWith(path.resolve(media) + path.sep) || !types[path.extname(file)])
    return new Response("Not found", { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: { "Content-Type": types[path.extname(file)]!, "Cache-Control": "public,max-age=3600" },
    });
  } catch { /* fetch a public catalog image */ }
  if (!CATALOG_PATH.test(relative) || !source.startsWith("https://")) return new Response("Image unavailable", { status: 404 });
  const response = await fetch(source + pathname, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/"))
    return new Response("Image unavailable", { status: 404 });
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 10_000_000) return new Response("Image too large", { status: 502 });
  if ((await directorySize(media)) + bytes.byteLength <= CACHE_LIMIT) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, new Uint8Array(bytes));
  }
  return new Response(bytes, {
    headers: { "Content-Type": response.headers.get("content-type")!, "Cache-Control": "public,max-age=3600" },
  });
}
