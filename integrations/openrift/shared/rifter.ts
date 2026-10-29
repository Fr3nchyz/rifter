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
}
export const RIFTER_API = "/api/v1/rifter";
