import type { ReactNode } from "react";

import { Dialog, DialogContent } from "../../components/dialog";

/* The card's confirms. `held` is the gallery's box: the dialog shows there, open, not modal. */

export type Held = HTMLElement | undefined;

/** A dialog around a confirm's form, placed in `held` when the gallery holds it. */
export function Confirm({ open, onOpenChange, held, children }: { open: boolean; onOpenChange: (open: boolean) => void; held?: Held; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={held ? false : undefined}>
      <DialogContent container={held} initialFocus={held ? false : undefined}>
        {children}
      </DialogContent>
    </Dialog>
  );
}
