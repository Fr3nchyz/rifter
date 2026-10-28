import { useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { Suspense, useEffect, useRef } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RifterHome } from "@/features/rifter/components/rifter-home";
import { useRequiredUserId } from "@/hooks/use-session";

export const Route = createLazyFileRoute("/_app/_authenticated/rifter")({
  component: RifterWorkspace,
});
const toolTitles = {
  imports: "Reviewed imports",
  history: "Action history",
  shopping: "Local shopping",
  quick: "Acquisition review",
};
type Tool = keyof typeof toolTitles;
function RifterWorkspace() {
  const frame = useRef<HTMLIFrameElement>(null);
  const queryClient = useQueryClient();
  const userId = useRequiredUserId();
  useEffect(() => {
    const changed = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "rifter:changed"
      )
        return;
      void queryClient.invalidateQueries({
        predicate: (query) =>
          ["collections", "copies", "decks", "lists", "collection-events"].includes(
            String(query.queryKey[0]),
          ) && query.queryKey[1] === userId,
      });
    };
    window.addEventListener("message", changed);
    return () => window.removeEventListener("message", changed);
  }, [queryClient, userId]);
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const tool = Object.hasOwn(toolTitles, hash) ? (hash as Tool) : null;
  const openTool = (value: string) => void navigate({ to: "/rifter", hash: value });
  return (
    <>
      <Suspense
        fallback={
          <div className="mx-auto max-w-5xl px-6 py-10" role="status">
            Loading your collections, decks and lists…
          </div>
        }
      >
        <RifterHome onOpenTool={openTool} />
      </Suspense>
      <Dialog
        open={tool !== null}
        onOpenChange={(open) => {
          if (!open) openTool("");
        }}
      >
        <DialogContent className="flex h-[90dvh] max-w-5xl flex-col gap-2 overflow-hidden p-4 sm:p-5">
          <DialogHeader>
            <DialogTitle>{tool ? toolTitles[tool] : "Collection tools"}</DialogTitle>
            <DialogDescription>
              Review imports, undo changes and compare local stock without leaving your collection.
            </DialogDescription>
          </DialogHeader>
          {tool && (
            <iframe
              ref={frame}
              title="Rifter collection tools"
              src={"/api/v1/rifter/ui?embedded=1#" + tool}
              className="min-h-0 w-full flex-1 border-0"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
