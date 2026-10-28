#!/usr/bin/env python3
"""Install the reviewed Rifter overlay into the pinned OpenRift checkout.

Parent-repository files remain the source of truth. Fail rather than overwrite
unknown upstream edits in the two wiring points.
"""
from pathlib import Path
import shutil
import json
import argparse

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / 'upstream/openrift'

def wire_api_routes():
    app = UPSTREAM / 'apps/api/src/app.ts'
    text = app.read_text()
    marker = 'import { createRifterRoutes } from "./modules/rifter/routes.js";'
    if marker not in text:
        text = marker + '\n' + text
    wire = '  app.route("/api/v1/rifter", createRifterRoutes(config.databaseUrl));'
    if wire not in text:
        anchor = '  // Registered before the oRPC catch-all so these plain-Hono routes win the path match.'
        if text.count(anchor) != 1:
            raise RuntimeError('OpenRift route wiring changed; review overlay before applying')
        text = text.replace(anchor, wire + '\n\n' + anchor)
    app.write_text(text)
    final = app.read_text()
    if marker not in final or wire not in final:
        raise SystemExit('apply-openrift: Rifter route import or app.route wiring missing after patch')


def apply(api_only=False):
    source = ROOT / 'integrations/openrift'
    target = UPSTREAM / 'apps/api/src/modules/rifter'
    target.mkdir(parents=True, exist_ok=True)
    for file in (source / 'api').glob('*.ts'):
        shutil.copy2(file, target / file.name)
    (target / 'workspace.ts').write_text('export const workspaceHtml = ' + json.dumps((source / 'workspace.html').read_text()) + ';\n')
    shutil.copy2(source / 'shared/rifter.ts', UPSTREAM / 'packages/shared/src/contracts/rifter.ts')
    wire_api_routes()
    # Managed databases may already install pg_trgm in their extensions schema.
    # Keep provider-owned extension metadata intact and resolve its opclass there.
    baseline = UPSTREAM / 'apps/api/src/db/migrations/001-core-schema.ts'
    text = baseline.read_text()
    original = '  await sql.raw(SCHEMA).execute(db);'
    replacement = '''  const extension = await sql<{ schema: string }>`
    SELECT n.nspname AS schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'
  `.execute(db);
  const schema = extension.rows[0]?.schema ?? "public";
  const identifier = '"' + schema.replaceAll('"', '""') + '"';
  const managedSchema = SCHEMA
    .replaceAll("public.gin_trgm_ops", identifier + ".gin_trgm_ops")
    .replaceAll(/COMMENT ON EXTENSION [^;]+;/gu, "");
  await sql.raw(managedSchema).execute(db);'''
    if original in text:
        text = text.replace(original, replacement, 1)
    elif replacement not in text:
        raise RuntimeError('OpenRift baseline migration changed; review hosted compatibility')
    baseline.write_text(text)
    if api_only:
        print('Rifter API overlay applied.')
        return
    old_route = UPSTREAM / 'apps/web/src/routes/_app/rifter.tsx'
    if old_route.exists():
        expected = (source / 'web/rifter.tsx').read_text().replace('/_app/_authenticated/rifter', '/_app/rifter')
        if old_route.read_text() != expected:
            raise RuntimeError('Old Rifter route has local edits; preserve them before moving it')
        old_route.unlink()
    shutil.copy2(source / 'web/rifter.tsx', UPSTREAM / 'apps/web/src/routes/_app/_authenticated/rifter.tsx')
    shutil.copy2(source / 'web/rifter.lazy.tsx', UPSTREAM / 'apps/web/src/routes/_app/_authenticated/rifter.lazy.tsx')
    home_target=UPSTREAM / 'apps/web/src/features/rifter/components'
    home_target.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source / 'web/home.tsx',home_target/'rifter-home.tsx')
    shutil.copy2(source / 'web/index.tsx',UPSTREAM / 'apps/web/src/routes/index.tsx')
    # The root layout runs before the index route. Its upstream signed-in
    # redirect otherwise bypasses our collection-first homepage entirely.
    root_route = UPSTREAM / 'apps/web/src/routes/__root.tsx'
    text = root_route.read_text()
    original = 'if (session?.user) {\n        throw redirect({ to: "/cards" });\n      }'
    replacement = 'if (session?.user) {\n        throw redirect({ to: "/rifter" });\n      }'
    if original in text:
        text = text.replace(original, replacement, 1)
        text = text.replace('Resolve the signed-in /cards redirect', 'Resolve the signed-in /rifter redirect', 1)
    elif replacement not in text:
        raise RuntimeError('OpenRift root redirect changed; review before applying')
    root_route.write_text(text)
    vite = UPSTREAM / 'apps/web/vite.config.ts'
    text = vite.read_text()
    original = '          preset: "bun",\n          plugins: ["./nitro/exit-on-close.ts"],'
    replacement = '''          preset: process.env.RIFTER_WEB_TARGET === "vercel" ? "vercel" : "bun",
          plugins: process.env.RIFTER_WEB_TARGET === "vercel" ? [] : ["./nitro/exit-on-close.ts"],
          ...(process.env.RIFTER_WEB_TARGET === "vercel" ? {
            routeRules: {
              "/api/**": { proxy: process.env.API_INTERNAL_URL + "/api/**" },
              "/media/**": { proxy: process.env.API_INTERNAL_URL + "/media/**" },
            },
          } : {}),'''
    if original in text:
        text = text.replace(original, replacement, 1)
    elif replacement not in text:
        raise RuntimeError('OpenRift Nitro configuration changed; review before applying')
    vite.write_text(text)
    for feature in ('collections', 'decks'):
        name = 'collection' if feature == 'collections' else 'deck'
        shutil.copy2(source / 'web/import-page.tsx', UPSTREAM / f'apps/web/src/features/{feature}/components/{name}-import-page.tsx')
    shutil.copy2(source / 'web/import-dialog.tsx', UPSTREAM / 'apps/web/src/features/collections/components/collection-import-dialog.tsx')
    shutil.copy2(source / 'web/import-dialog.test.tsx', UPSTREAM / 'apps/web/src/features/collections/components/collection-import-dialog.test.tsx')
    nav = UPSTREAM / 'apps/web/src/components/layout/nav-items.tsx'
    text = nav.read_text()
    entry = '    { label: "Rifter", to: "/rifter", icon: LibraryIcon, lockedKey: "collections" },'
    if entry not in text:
        anchor = 'export function primaryNavItems(): NavItemConfig[] {\n  return ['
        if text.count(anchor) != 1:
            raise RuntimeError('OpenRift navigation wiring changed; review required')
        text = text.replace(anchor, anchor + '\n' + entry)
    nav.write_text(text)
    if entry not in nav.read_text():
        raise SystemExit('apply-openrift: navigation patch not applied')
    # An unhydrated SSR form must not fall back to GET with credentials in the
    # URL. React handles the normal submit after hydration.
    for name in ('signup-form.tsx', 'login-form.tsx'):
        form = UPSTREAM / 'apps/web/src/features/account/components' / name
        text = form.read_text()
        if '<form onSubmit=' in text:
            text = text.replace('<form onSubmit=', '<form method="post" onSubmit=')
        elif '<form method="post" onSubmit=' not in text:
            raise SystemExit(f'apply-openrift: {name} form anchor not found and hardening not present; review overlay')
        form.write_text(text)
    print('Rifter overlay applied (API, shared contracts, /rifter workspace).')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api-only', action='store_true')
    apply(api_only=parser.parse_args().api_only)
