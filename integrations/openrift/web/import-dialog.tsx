import { Link } from "@tanstack/react-router";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function CollectionImportDialog({
  open,
  onOpenChange,
}: {
  collectionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review a new card list</DialogTitle>
          <DialogDescription>
            Imports are saved in your review inbox before changing any owned quantities. Choose the
            destination and add or replace behavior there.
          </DialogDescription>
        </DialogHeader>
        <Link to="/rifter" hash="imports" onClick={() => onOpenChange(false)}>
          Open reviewed imports →
        </Link>
      </DialogContent>
    </Dialog>
  );
}
