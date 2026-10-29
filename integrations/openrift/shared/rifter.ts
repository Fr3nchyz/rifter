import { z } from "zod";

export const rifterDestination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection"), id: z.uuid(), mode: z.enum(["add", "replace"]) }),
  z.object({
    kind: z.literal("new-deck"),
    name: z.string().trim().min(1).max(200),
    status: z.enum(["active", "aspiring"]),
  }),
  z.object({ kind: z.literal("deck"), id: z.uuid(), mode: z.enum(["add", "replace"]) }),
]);
export const rifterPreviewRequest = z.object({
  rawInput: z.string().min(1).max(1_000_000),
  source: z.string().max(2000).default(""),
  format: z.enum(["text", "rifty", "openrift", "piltover-csv", "piltover-code", "acquisition"]),
  destination: rifterDestination,
});
export const rifterReviewRequest = z.object({
  revision: z.number().int().positive(),
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        printingId: z.uuid().nullable(),
        excluded: z.boolean(),
        condition: z.string().max(60).nullable().optional(),
        zone: z
          .enum([
            "main",
            "sideboard",
            "legend",
            "champion",
            "runes",
            "battlefield",
            "legend-options",
          ])
          .optional(),
      }),
    )
    .max(500),
});
export const rifterConfirmRequest = z.object({
  revision: z.number().int().positive(),
  acknowledgeDuplicate: z.boolean().default(false),
  /** Replace mode: required when the import would remove more than half of the collection's copies. */
  acknowledgeRemoval: z.boolean().default(false),
  /** Replace mode: required when excluded or unresolved rows have no catalog match, so the cards they stand for are not protected. */
  acknowledgeUnmatched: z.boolean().default(false),
  /** Collection replace: the copy counts the reviewer saw (required); the server refuses if the collection changed since. */
  expectedChange: z
    .object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })
    .optional(),
});
/** Quick entry: a set prefix plus the number typed after it (`12`, `r3`, `149a`, `4-p`). */
export const rifterSearchQuery = z
  .object({
    q: z.string().trim().min(2).max(150).optional(),
    set: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2,8}$/u, "Set must be 2 to 8 letters")
      .optional(),
    number: z
      .string()
      .trim()
      .regex(/^[A-Za-z]?\d{1,4}[A-Za-z*]?(-[A-Za-z]+)?$/u, "Enter the card number, for example 12")
      .optional(),
  })
  .refine((v) => (v.set && v.number) || v.q, {
    message: "Type at least 2 letters, a card code, or choose a set and number",
  })
  .refine((v) => Boolean(v.set) === Boolean(v.number), {
    message: "Set and number go together",
  });
export const rifterDeckStateRequest = z.object({ status: z.enum(["active", "aspiring"]) });
export type RifterDestination = z.infer<typeof rifterDestination>;
export type RifterPreviewRequest = z.infer<typeof rifterPreviewRequest>;
export interface RifterCandidate {
  printingId: string;
  cardId: string;
  name: string;
  code: string;
  finish: string;
  language: string;
  artVariant: string;
  /** Number search only: "exact" is the typed number, "variant" a lettered, promo or other form of it. */
  match?: "exact" | "variant";
  /** Number search only: the default rule's pick among the exact printings (note says why). */
  isDefault?: boolean;
  defaultNote?: string;
}
export interface RifterReplaceLine {
  kind: "added" | "removed" | "changed";
  printingId: string;
  cardId: string;
  name: string;
  code: string;
  finish: string;
  language: string;
  from: number;
  to: number;
}
/** What a "replace this collection" import would do to the collection right now. */
export interface RifterReplaceDiff {
  /** Per printing line. */
  printings: { added: number; removed: number; changed: number; unchanged: number };
  /** Physical copies. */
  copies: { added: number; removed: number; total: number; untouched: number };
  lines: RifterReplaceLine[];
  /** Rows left out of the comparison (unresolved or excluded). Those with catalog candidates protect their cards. */
  skippedRows: number;
  /** Skipped rows with no catalog candidates (tokens exempt): they protect nothing. */
  unmatchedRows: { index: number; input: string; reason: string }[];
  needsUnmatchedAcknowledgement: boolean;
  /** Share of the collection's copies that would be removed (0 to 1). */
  removalShare: number;
  needsRemovalAcknowledgement: boolean;
  /** Set when replacing is refused outright (for example no resolvable rows). */
  refusal: string | null;
}
export interface RifterImportRow {
  input: string;
  quantity: number;
  zone: string;
  condition: string | null;
  metadata: {
    grader?: string;
    grade?: number;
    isAltered?: boolean;
    notesPublic?: string;
    notesPrivate?: string;
    links?: { url: string; label: string }[];
  };
  candidates: RifterCandidate[];
  printingId: string | null;
  /** Set when the default rule (English, normal finish, standard art) picked the printing. */
  autoChosen?: string;
  excluded: boolean;
  warning: string | null;
  /** Why the row has no printing yet (unmatched code, differing name, several printings). */
  reason?: string;
  /** Set when the row was excluded automatically (tokens); cleared if the user takes it back. */
  autoExcluded?: "token";
}
export const RIFTER_API = "/api/v1/rifter";
