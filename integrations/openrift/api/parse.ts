import type { RifterPreviewRequest } from "@openrift/shared/contracts/rifter";
import { parsePiltoverDeckCode } from "@openrift/shared/deck-code";

export interface ParsedRow {
  input: string;
  quantity: number;
  zone: string;
  code?: string;
  name?: string;
  finish?: string;
  language?: string;
  artVariant?: string;
  condition: string | null;
  metadata: {
    grader?: string;
    grade?: number;
    isAltered?: boolean;
    notesPublic?: string;
    notesPrivate?: string;
    links?: { url: string; label: string }[];
  };
  warning?: string;
}
const zones: Record<string, string> = {
  legend: "legend",
  champion: "champion",
  "chosen champion": "champion",
  battlefields: "battlefield",
  battlefield: "battlefield",
  "main deck": "main",
  main: "main",
  "rune pool": "runes",
  runes: "runes",
  sideboard: "sideboard",
  "legend options": "legend-options",
};
const conditions: Record<string, string> = {
  M: "mint",
  MT: "mint",
  MINT: "mint",
  NM: "near-mint",
  "NEAR MINT": "near-mint",
  "NEAR-MINT": "near-mint",
  EX: "excellent",
  EXC: "excellent",
  EXCELLENT: "excellent",
  SP: "excellent",
  "SLIGHTLY PLAYED": "excellent",
  GD: "good",
  GOOD: "good",
  LP: "light-played",
  "LIGHT PLAYED": "light-played",
  "LIGHT-PLAYED": "light-played",
  "LIGHTLY PLAYED": "light-played",
  MP: "played",
  PL: "played",
  PLAYED: "played",
  "MODERATELY PLAYED": "played",
  HP: "poor",
  PO: "poor",
  POOR: "poor",
  DMG: "poor",
  D: "poor",
  DAMAGED: "poor",
  "HEAVILY PLAYED": "poor",
};
const languages: Record<string, string> = {
  ENGLISH: "EN",
  FRENCH: "FR",
  FRANÇAIS: "FR",
  CHINESE: "SC",
  "CHINESE (SIMPLIFIED)": "SC",
  ZH: "SC",
};

// Strict RFC-style CSV reader: reject malformed rows rather than silently
// dropping a count or splitting a quoted card name.
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/u, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed || c === '"') throw new Error("Malformed CSV quoting");
      field += c;
    }
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (field || row.length || closed) {
    row.push(field);
    if (row.some((x) => x.trim())) rows.push(row);
  }
  return rows;
}
function count(raw: string): number {
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 1000)
    throw new Error("Quantity must be a whole number between 1 and 1000");
  return Number(raw);
}
export function parseInput(
  format: RifterPreviewRequest["format"],
  raw: string,
): { rows: ParsedRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ParsedRow[] = [];
  if (format === "piltover-code") {
    const parsed = parsePiltoverDeckCode(raw.trim());
    if (!parsed.entries.length) throw new Error(parsed.warnings.join(" ") || "Empty deck code");
    for (const e of parsed.entries)
      rows.push({
        input: e.shortCode ?? e.cardName ?? "",
        code: e.shortCode,
        name: e.cardName,
        quantity: e.quantity,
        zone: e.explicitZone ?? (e.sourceSlot === "sideboard" ? "sideboard" : "main"),
        condition: null,
        metadata: {},
      });
    warnings.push(...parsed.warnings);
  } else if (format === "text" || format === "acquisition") {
    let zone = "main";
    for (const line of raw.split(/\r?\n/u)) {
      const s = line.trim();
      if (!s) continue;
      const heading = s
        .replace(/^\[|\]$/gu, "")
        .replace(/:$/u, "")
        .toLowerCase();
      if (zones[heading]) {
        zone = zones[heading];
        continue;
      }
      const m = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\{([^}]+)\})?$/iu.exec(s);
      if (!m) throw new Error("Invalid card line: " + s);
      const value = m[2]!.trim();
      const isCode = /^[A-Z]{2,8}-[A-Z]?\d+[a-z*]?$/iu.test(value);
      rows.push({
        input: s,
        quantity: count(m[1] ?? "1"),
        zone,
        ...(isCode ? { code: value } : { name: value }),
        ...(m[3] ? { code: m[3] } : {}),
        condition: null,
        metadata: {},
      });
    }
  } else {
    const table = csvRows(raw);
    const headers = table.shift()?.map((x) => x.trim()) ?? [];
    const required =
      format === "rifty"
        ? ["code", "name", "count"]
        : format === "piltover-csv"
          ? ["Variant Number", "Card Name", "Quantity", "Foil"]
          : ["Card ID", "Card Name", "Quantity"];
    if (new Set(headers).size !== headers.length || required.some((x) => !headers.includes(x)))
      throw new Error("Missing or duplicate CSV headers; required: " + required.join(", "));
    for (const fields of table) {
      if (fields.length !== headers.length)
        throw new Error("CSV row has a different number of columns than its header");
      const r = Object.fromEntries(headers.map((h, i) => [h, fields[i]!.trim()]));
      let code = r["Card ID"] || r["Variant Number"] || r.code || undefined;
      let finish = r.Finish?.toLowerCase() || undefined;
      if (format === "piltover-csv") {
        if (/-Foil$/iu.test(code ?? "") || /^(true|yes|1|foil)$/iu.test(r.Foil ?? ""))
          finish = "foil";
        code = code?.replace(/-Foil$/iu, "");
      }
      const condition = r.Condition
        ? (conditions[r.Condition.toUpperCase()] ?? r.Condition.toLowerCase())
        : null;
      const grader = r.Grader || r["Grading Company"];
      const gradeRaw = r.Grade || r["Grading Value"];
      if ((grader && !gradeRaw) || (!grader && gradeRaw))
        throw new Error("Grader and grade must be supplied together");
      const grade = gradeRaw ? Number(gradeRaw) : undefined;
      if (
        grade !== undefined &&
        (!Number.isFinite(grade) || grade < 1 || grade > 10 || grade * 2 !== Math.trunc(grade * 2))
      )
        throw new Error("Invalid grading value");
      const rawSection = r.section || r.Section || "Main Deck";
      if (r.Altered && !/^(yes|true|1|no|false|0)$/iu.test(r.Altered))
        throw new Error("Unrecognized Altered value; use Yes or No");
      rows.push({
        input: JSON.stringify(r),
        code,
        name: r["Card Name"] || r.name,
        quantity: count(r.Quantity ?? r.count ?? ""),
        zone: zones[rawSection.toLowerCase()] ?? "main",
        finish,
        language: r.Language
          ? (languages[r.Language.toUpperCase()] ?? r.Language.toUpperCase())
          : undefined,
        artVariant: r["Art Variant"] || undefined,
        condition: grader ? null : condition,
        metadata: {
          ...(grader ? { grader: grader.toLowerCase(), grade } : {}),
          ...(r.Altered ? { isAltered: /^(yes|true|1)$/iu.test(r.Altered) } : {}),
          ...(r["Public Notes"] || r.Notes ? { notesPublic: r["Public Notes"] || r.Notes } : {}),
          ...(r["Private Notes"] ? { notesPrivate: r["Private Notes"] } : {}),
          ...(r.Links
            ? {
                links: r.Links.split(";").map((v) => {
                  const [url, label] = v.trim().split("|");
                  if (!url || !/^https?:\/\//iu.test(url)) throw new Error("Invalid metadata link");
                  return { url, label: label || url };
                }),
              }
            : {}),
        },
        ...(r.Condition && !grader && !conditions[r.Condition.toUpperCase()]
          ? {
              warning:
                "Unrecognized condition: " +
                r.Condition +
                "; choose a condition or explicitly mark it unrecorded",
            }
          : !zones[rawSection.toLowerCase()]
            ? { warning: "Unknown section: " + rawSection + "; review zone before applying" }
            : {}),
      });
    }
  }
  if (!rows.length || rows.length > 500 || rows.reduce((n, r) => n + r.quantity, 0) > 5000)
    throw new Error("Import must contain 1–500 rows and no more than 5000 copies");
  return { rows, warnings };
}
