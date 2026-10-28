import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const media = process.env.MEDIA_DIR ?? path.resolve(import.meta.dir, "../../../../../media");
const source = (process.env.CATALOG_SOURCE_URL ?? "https://openrift.app").replace(/\/$/u, "");
const types: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg" };

export async function serveCatalogImage(pathname: string) {
  const relative = decodeURIComponent(pathname.slice("/media/".length));
  const file = path.resolve(media, relative);
  if (!file.startsWith(path.resolve(media) + path.sep) || !types[path.extname(file)])
    return new Response("Not found", { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: { "Content-Type": types[path.extname(file)]!, "Cache-Control": "public,max-age=3600" },
    });
  } catch { /* fetch a public catalog image */ }
  if (!source.startsWith("https://")) return new Response("Image unavailable", { status: 404 });
  const response = await fetch(source + pathname, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/"))
    return new Response("Image unavailable", { status: 404 });
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 10_000_000) return new Response("Image too large", { status: 502 });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, new Uint8Array(bytes));
  return new Response(bytes, {
    headers: { "Content-Type": response.headers.get("content-type")!, "Cache-Control": "public,max-age=3600" },
  });
}
