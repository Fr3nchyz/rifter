import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

test("file-opening help explains how to start the actual app", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(request.url());
  });
  // Managed Chromium blocks file: navigation. Exercise the file-origin branch
  // in an isolated document without changing browser security policy.
  const html = readFileSync(resolve("integrations/openrift/workspace.html"), "utf8");
  await page.setContent(html.replace('location.protocol === "file:"', 'true /* simulated file origin */'));
  await expect(page.getByRole("heading", { name: "Start the app to open your collection" })).toBeVisible();
  await expect(page.getByText("python3 scripts/setup.py", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Quick entry" })).toHaveCount(0);
  expect(requests).toEqual([]);
});

for (const failure of ["signed-out", "wrong-server"] as const) {
  test("tool navigation stays responsive when " + failure, async ({ page }) => {
    await page.route("**/api/v1/rifter/overview", (route) =>
      route.fulfill(
        failure === "signed-out"
          ? {
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ error: "Sign in to OpenRift first" }),
            }
          : {
              status: 404,
              contentType: "text/html",
              body: "<!doctype html><title>Not the app API</title>",
            },
      ),
    );
    await page.goto("/api/v1/rifter/ui");
    await expect(page.getByText("Your collection could not be loaded.")).toBeVisible();
    for (const [button, heading] of [
      ["Quick entry", "Quick entry"],
      ["Import inbox", "Import inbox"],
      ["History", "History"],
      ["Overview", "Collection overview"],
    ]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry connection", exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  });
}
