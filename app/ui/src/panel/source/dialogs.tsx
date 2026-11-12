import type { ReactNode } from "react";

import { Dialog, DialogContent } from "../../components/dialog";

/* The card's confirms. */

/** A dialog around a confirm's form. */
export function Confirm({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {children}
      </DialogContent>
    </Dialog>
  );
}
