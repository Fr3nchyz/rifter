import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  ArchiveIcon,
  BoxesIcon,
  ChevronDownIcon,
  CirclePlusIcon,
  Clock3Icon,
  Layers3Icon,
  ListChecksIcon,
  ShoppingBagIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";

import {
  PageDescription,
  PageTopBar,
  PageTopBarActions,
  PageTopBarSticky,
  PageTopBarTitle,
} from "@/components/layout/page-top-bar";
import { Button, buttonVariants } from "@/components/ui/button";
import { useLibraryToggleStore } from "@/features/cards/stores/library-toggle-store";
import { CreateCollectionDialog } from "@/features/collections/components/create-collection-dialog";
import { useCollections } from "@/features/collections/hooks/use-collections";
import { DeckTile } from "@/features/decks/components/deck-tile";
import { useDecks } from "@/features/decks/hooks/use-decks";
import { CreateListDialog } from "@/features/lists/components/create-list-dialog";
import { useLists } from "@/features/lists/hooks/use-lists";
import { cn, PAGE_PADDING_NO_TOP, PAGE_WIDTH } from "@/lib/utils";

type RifterTool = "imports" | "history" | "shopping" | "quick";

export function RifterHome({ onOpenTool }: { onOpenTool: (tool: RifterTool) => void }) {
  const { data: collections } = useCollections();
  const { data: decks } = useDecks();
  const { data: lists } = useLists();
  const [selectedDeckId, setSelectedDeckId] = useState(decks[0]?.deck.id ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const navigate = useNavigate();

  const selectedDeck = decks.find((item) => item.deck.id === selectedDeckId) ?? decks[0];
  const addCards = () => {
    const target = collections.find((collection) => collection.isInbox) ?? collections[0];
    if (!target) {
      setCreateOpen(true);
      return;
    }
    useLibraryToggleStore.getState().setShowLibrary("collection", true);
    void navigate({ to: "/collections/$collectionId", params: { collectionId: target.id } });
  };

  return (
    <>
      <PageTopBarSticky width="capped">
        <PageTopBar>
          <PageTopBarTitle>Rifter</PageTopBarTitle>
          <PageTopBarActions>
            <Button variant="outline" size="sm" aria-label="Imports" title="Imports" onClick={() => onOpenTool("imports")}>
              <ArchiveIcon />
              <span className="hidden sm:inline">Imports</span>
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="History"
              title="History"
              onClick={() => onOpenTool("history")}
            >
              <Clock3Icon />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Local shopping"
              title="Local shopping"
              onClick={() => onOpenTool("shopping")}
            >
              <ShoppingBagIcon />
            </Button>
          </PageTopBarActions>
        </PageTopBar>
      </PageTopBarSticky>

      <main
        className={cn(
          PAGE_WIDTH.capped,
          PAGE_PADDING_NO_TOP,
          "flex flex-col gap-7 pt-3 pb-10 sm:gap-9",
        )}
      >
        <header className="max-w-2xl space-y-2">
          <p className="text-primary flex items-center gap-2 text-xs font-semibold tracking-[0.16em] uppercase">
            <SparklesIcon className="size-3.5" /> Your card workspace
          </p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
            Everything you own, ready to play.
          </h1>
          <PageDescription className="text-sm sm:text-base">
            Keep your collection close, pick up a deck where you left off, and get to your lists in
            one place.
          </PageDescription>
        </header>

        <section className="space-y-3" aria-labelledby="rifter-collections-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
                Start here
              </p>
              <h2 id="rifter-collections-heading" className="font-heading text-2xl font-semibold">
                My collection
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link to="/collections" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Browse collections <ArrowRightIcon />
              </Link>
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <CirclePlusIcon /> New collection
              </Button>
              <Button size="sm" onClick={addCards}>
                <CirclePlusIcon />
                Add cards
              </Button>
              <Button variant="outline" size="sm" onClick={() => onOpenTool("quick")}>
                Code batch
              </Button>
            </div>
          </div>

          {collections.length === 0 ? (
            <div className="border-border bg-card rounded-xl border border-dashed px-5 py-7 sm:px-7">
              <div className="flex max-w-xl flex-col items-start gap-3">
                <div className="bg-primary/10 text-primary flex size-11 items-center justify-center rounded-xl">
                  <BoxesIcon className="size-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold">Start with a collection</h3>
                  <p className="text-muted-foreground text-sm">
                    Create a place for your cards, or import a collection you already track.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setCreateOpen(true)}>
                    <CirclePlusIcon /> Create collection
                  </Button>
                  <Button variant="outline" onClick={() => onOpenTool("imports")}>
                    <ArchiveIcon /> Import cards
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {collections.map((collection, index) => (
                <Link
                  key={collection.id}
                  to="/collections/$collectionId"
                  params={{ collectionId: collection.id }}
                  className={cn(
                    "group border-border bg-card hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-ring relative flex min-h-32 flex-col justify-between overflow-hidden rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none",
                    index === 0 && "sm:col-span-2 lg:col-span-1",
                  )}
                >
                  <div className="bg-primary/5 absolute -top-8 -right-8 size-24 rounded-full transition-transform group-hover:scale-125" />
                  <div className="relative flex items-start justify-between gap-3">
                    <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                      <BoxesIcon className="text-muted-foreground size-4" />
                    </div>
                    {collection.isInbox && (
                      <span className="text-muted-foreground text-[11px] font-medium">Inbox</span>
                    )}
                  </div>
                  <div className="relative mt-5 flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{collection.name}</h3>
                      <p className="text-muted-foreground mt-0.5 text-sm">
                        {collection.copyCount.toLocaleString()}{" "}
                        {collection.copyCount === 1 ? "card" : "cards"}
                      </p>
                    </div>
                    <ArrowRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              ))}
            </div>
          )}
          {collections.length > 0 &&
            collections.every((collection) => collection.copyCount === 0) && (
              <p className="text-muted-foreground text-sm">
                No cards recorded yet. Add cards from the catalog, or{" "}
                <button
                  type="button"
                  onClick={() => onOpenTool("imports")}
                  className="text-primary underline underline-offset-4"
                >
                  import your collection
                </button>
                .
              </p>
            )}
        </section>

        <section
          className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]"
          aria-label="Deck and lists"
        >
          <div className="border-border bg-card relative overflow-hidden rounded-xl border p-5 sm:p-6">
            <div className="bg-primary/5 absolute -right-16 -bottom-20 size-56 rounded-full" />
            <div className="relative space-y-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
                    Back to building
                  </p>
                  <h2 className="font-heading text-2xl font-semibold">Your decks</h2>
                </div>
                <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl">
                  <Layers3Icon className="size-5" />
                </div>
              </div>

              {selectedDeck ? (
                <>
                  <label
                    className="text-muted-foreground block text-sm"
                    htmlFor="rifter-deck-select"
                  >
                    Choose a deck
                  </label>
                  <div className="relative">
                    <select
                      id="rifter-deck-select"
                      value={selectedDeck.deck.id}
                      onChange={(event) => setSelectedDeckId(event.target.value)}
                      className="border-input bg-background focus-visible:ring-ring h-11 w-full appearance-none rounded-md border px-3 pr-10 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
                    >
                      {decks.map(({ deck }) => (
                        <option key={deck.id} value={deck.id}>
                          {deck.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2" />
                  </div>
                  <DeckTile item={selectedDeck} />
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                      <p className="font-heading text-xl font-semibold">{selectedDeck.deck.name}</p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        {selectedDeck.totalCards} {selectedDeck.totalCards === 1 ? "card" : "cards"}{" "}
                        · {selectedDeck.deck.format}
                      </p>
                    </div>
                    <Link
                      to="/decks/$deckId"
                      params={{ deckId: selectedDeck.deck.id }}
                      className={buttonVariants()}
                    >
                      Open deck <ArrowRightIcon />
                    </Link>
                  </div>
                  <p className="text-muted-foreground text-sm">
                    Open your deck to see owned and missing cards, then save what you need as a
                    wishlist.
                  </p>
                </>
              ) : (
                <div className="border-border/80 bg-background/70 rounded-lg border border-dashed p-4">
                  <p className="font-medium">No decks yet</p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Create your first deck to start building with your collection.
                  </p>
                  <Link
                    to="/decks"
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                      className: "mt-3",
                    })}
                  >
                    Browse decks <ArrowRightIcon />
                  </Link>
                </div>
              )}
            </div>
          </div>

          <div className="border-border bg-card rounded-xl border p-5 sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
                  Keep it organized
                </p>
                <h2 className="font-heading text-2xl font-semibold">My lists</h2>
              </div>
              <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-xl">
                <ListChecksIcon className="size-5" />
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setListOpen(true)} className="mb-4">
              <CirclePlusIcon />
              New wishlist
            </Button>
            {lists.length ? (
              <ul className="divide-border divide-y">
                {lists.slice(0, 5).map((list) => (
                  <li key={list.id}>
                    <Link
                      to="/collections/lists/$listId"
                      params={{ listId: list.id }}
                      className="group flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium group-hover:underline">
                          {list.name}
                        </span>
                        <span className="text-muted-foreground mt-0.5 block text-xs">
                          {list.entryCount} {list.entryCount === 1 ? "entry" : "entries"}
                        </span>
                      </span>
                      <ArrowRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="border-border rounded-lg border border-dashed px-4 py-5">
                <p className="text-sm font-medium">Your lists will show up here</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  Save trade ideas and cards you want to find later.
                </p>
              </div>
            )}
          </div>
        </section>

        <CreateCollectionDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(collectionId) =>
            void navigate({ to: "/collections/$collectionId", params: { collectionId } })
          }
        />
        <CreateListDialog
          intent="wish"
          open={listOpen}
          onOpenChange={setListOpen}
          onCreated={(listId) =>
            void navigate({ to: "/collections/lists/$listId", params: { listId } })
          }
        />
      </main>
    </>
  );
}
