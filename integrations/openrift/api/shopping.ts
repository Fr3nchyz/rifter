import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type postgres from "postgres";

import { RifterError } from "./service.js";

export function createShopping(db: postgres.Sql) {
  const root =
    process.env.RIFTER_ROOT ?? new URL("../../../../../../../", import.meta.url).pathname;
  const jobs = new Map<string, ReturnType<typeof Bun.spawn>>();
  async function bridge(data: unknown) {
    const p = Bun.spawn(["python3", "-m", "riftbound.bridge"], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    p.stdin.write(JSON.stringify(data));
    p.stdin.end();
    const [out, , code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    let result;
    try {
      result = JSON.parse(out);
    } catch {
      throw new RifterError(502, "Inventory adapter failed");
    }
    if (code !== 0) {
      if (result && typeof result.error === "string") throw new RifterError(400, result.error);
      throw new RifterError(502, "Inventory adapter failed");
    }
    return result;
  }
  async function snapshot(user: string, csv: string, coverage = "uploaded-unverified-coverage") {
    const checked = await bridge({ operation: "validate", csv });
    const [row] =
      await db`INSERT INTO rifter_stock_snapshots(user_id,store,raw_csv,records,coverage)
      VALUES(${user},'gamekeeper-verdun',${csv},${checked.records},${coverage}) RETURNING id,store,records,coverage,created_at`;
    return row;
  }
  async function status(user: string) {
    const snapshots =
      await db`SELECT id,store,records,coverage,created_at FROM rifter_stock_snapshots WHERE user_id=${user} ORDER BY created_at DESC LIMIT 1`;
    const refreshes =
      await db`SELECT * FROM rifter_stock_refreshes WHERE user_id=${user} ORDER BY created_at DESC LIMIT 1`;
    const active = refreshes[0];
    if (active?.status === "running" && !jobs.has(active.id)) {
      await db`UPDATE rifter_stock_refreshes SET status='failed',error='Refresh interrupted by server restart; previous snapshot retained',finished_at=now() WHERE id=${active.id}`;
      active.status = "failed";
      active.error = "Refresh interrupted by server restart; previous snapshot retained";
    }
    let progress = null;
    if (active && jobs.has(active.id))
      try {
        const p = JSON.parse(
          await readFile(resolve(root, ".local/stock", active.id + ".progress.json"), "utf8"),
        );
        progress = { pages: p.pages ?? 0, variants: p.variants ?? 0, status: p.status };
      } catch {
        /* not written yet */
      }
    return { snapshot: snapshots[0] ?? null, refresh: active ?? null, progress };
  }
  async function refresh(user: string) {
    await status(user);
    // Jobs stuck in 'running' (e.g. lost worker) must not block forever.
    await db`UPDATE rifter_stock_refreshes SET status='failed',error='Refresh timed out; previous snapshot retained',finished_at=now() WHERE status='running' AND created_at < now() - interval '30 minutes'`;
    const running =
      await db`SELECT user_id FROM rifter_stock_refreshes WHERE status='running'`;
    if (running.some((r) => r.user_id === user))
      throw new RifterError(409, "A refresh is already running");
    if (running.length >= 1 || jobs.size >= 1)
      throw new RifterError(409, "Another refresh is running; try again shortly");
    const [recent] =
      await db`SELECT created_at FROM rifter_stock_refreshes WHERE user_id=${user} AND created_at > now() - interval '10 minutes' LIMIT 1`;
    if (recent) throw new RifterError(429, "Refresh was run recently; wait 10 minutes between refreshes");
    const [job] =
      await db`INSERT INTO rifter_stock_refreshes(user_id,status) VALUES(${user},'running') RETURNING id`;
    const directory = resolve(root, ".local/stock");
    await mkdir(directory, { recursive: true });
    const output = resolve(directory, job!.id + ".csv");
    const proc = Bun.spawn(
      [
        "python3",
        "-m",
        "riftbound.fetch_store",
        "--store-permission",
        "--cache",
        resolve(root, ".local/store-cache"),
        "--output",
        output,
      ],
      { cwd: root, stdout: "ignore", stderr: "pipe" },
    );
    jobs.set(job!.id, proc);
    void (async () => {
      try {
        const [, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        if (code !== 0)
          throw Error(
            "Store refresh denied, interrupted or failed validation. Previous snapshot retained.",
          );
        const report = JSON.parse(
          await readFile(output.replace(/\.csv$/u, ".report.json"), "utf8"),
        );
        if (report.status !== "complete_pagination_traversal")
          throw Error("Incomplete traversal; previous snapshot retained.");
        const csv = await readFile(output, "utf8");
        await db.begin(async (tx) => {
          const rows =
            await tx`SELECT status FROM rifter_stock_refreshes WHERE id=${job!.id} FOR UPDATE`;
          if (rows[0]?.status !== "running") return;
          const checked = await bridge({ operation: "validate", csv });
          await tx`INSERT INTO rifter_stock_snapshots(user_id,store,raw_csv,records,coverage) VALUES(${user},'gamekeeper-verdun',${csv},${checked.records},'complete-pagination')`;
          await tx`UPDATE rifter_stock_refreshes SET status='complete',finished_at=now() WHERE id=${job!.id}`;
        });
      } catch {
        await db`UPDATE rifter_stock_refreshes SET status='failed',error='Refresh failed or access denied. Previous good snapshot retained; unknown stock remains unknown.',finished_at=now() WHERE id=${job!.id} AND status='running'`;
      } finally {
        jobs.delete(job!.id);
      }
    })();
    return { id: job!.id, status: "running" };
  }
  return {
    status,
    snapshot,
    refresh,
    cancel: async (user: string) => {
      const rows =
        await db`UPDATE rifter_stock_refreshes SET status='cancelled',finished_at=now() WHERE user_id=${user} AND status='running' RETURNING id`;
      for (const row of rows) jobs.get(row.id)?.kill();
      return { status: "cancelled" };
    },
    compare: async (user: string, targets: { name: string; count: number; section: string }[]) => {
      const [s] =
        await db`SELECT * FROM rifter_stock_snapshots WHERE user_id=${user} ORDER BY created_at DESC LIMIT 1`;
      if (!s) throw new RifterError(409, "Load or refresh an inventory snapshot first");
      const result = await bridge({ operation: "compare", csv: s.raw_csv, targets });
      const stamps = (result.allocations as { checked_at?: string }[])
        .map((a) => Date.parse(a.checked_at ?? ""))
        .filter(Number.isFinite);
      return {
        ...result,
        snapshot: { id: s.id, coverage: s.coverage, loadedAt: s.created_at },
        stale: !stamps.length || Math.min(...stamps) < Date.now() - 15 * 60 * 1000,
      };
    },
  };
}
