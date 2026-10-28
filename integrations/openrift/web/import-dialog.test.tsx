import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    hash,
    onClick,
    children,
  }: {
    to: string;
    hash: string;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <a
      href={to + "#" + hash}
      onClick={(event) => {
        event.preventDefault();
        onClick();
      }}
    >
      {children}
    </a>
  ),
}));
const { CollectionImportDialog } = await import("./collection-import-dialog");

it("routes native import entry to persistent quarantine without collecting a disposable draft", async () => {
  const close = vi.fn();
  render(<CollectionImportDialog open onOpenChange={close} collectionId="test-binder" />);
  const link = screen.getByRole("link", { name: "Open reviewed imports →" });
  expect(link).toHaveAttribute("href", "/rifter#imports");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await userEvent.click(link);
  expect(close).toHaveBeenCalledWith(false);
});
it("respects the controlled closed state", () => {
  render(<CollectionImportDialog open={false} onOpenChange={vi.fn()} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
