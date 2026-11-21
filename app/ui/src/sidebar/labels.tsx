import { type FormEvent, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { Input } from "../components/input";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "../components/menu";
import { useDaemon } from "../daemon";
import { Plus, Tag } from "../icons";
import { store } from "../onboarding/api";
import { label } from "./actions";
import type { SessionRow } from "./words";

/*
 * A session's labels [D3101, D3103]: names only, no colours or rename. A label lives while some session has it, so the
 * menu offers every name any session has, and New label makes one by giving it to this session.
 */

/** The row menu's Label ›: each label in use, ticked where this session has it, then New label. */
export function LabelMenu({ row }: { row: SessionRow }) {
  const { rows } = useDaemon();
  const mine = row.labels ?? [];
  const all = [...new Set([...(rows ?? []).flatMap((each) => (each as SessionRow).labels ?? []), ...mine])].toSorted((a, b) => a.localeCompare(b));
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Tag />
        Label
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {all.map((name) => (
          <DropdownMenuCheckboxItem key={name} closeOnClick={false} checked={mine.includes(name)} onCheckedChange={(on) => label(row, name, on)}>
            {name}
          </DropdownMenuCheckboxItem>
        ))}
        {all.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => naming.set(row)}>
          <Plus />
          New label
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A row's or card's labels, as neutral badges. */
export function Labels({ row, className }: { row: SessionRow; className?: string }) {
  if (!row.labels?.length) return null;
  return (
    <span className={className}>
      {row.labels.map((name) => (
        <Badge key={name} variant="secondary" className="max-w-32 truncate">
          {name}
        </Badge>
      ))}
    </span>
  );
}

const naming = store<SessionRow | null>(null);

/** New label's form, mounted once by the sidebar. */
export function LabelAsk() {
  const row = naming.use();
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && naming.set(null)}>
      <DialogContent>{row && <LabelForm key={row.id} row={row} onClose={() => naming.set(null)} />}</DialogContent>
    </Dialog>
  );
}

function LabelForm({ row, onClose }: { row: SessionRow; onClose: () => void }) {
  const [value, setValue] = useState("");
  const name = value.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name) return;
    label(row, name, true);
    onClose();
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New label</DialogTitle>
      </DialogHeader>
      <div className="grid gap-1.5">
        <label htmlFor="new-label" className="text-xs text-muted-foreground">
          Name
        </label>
        <Input id="new-label" value={value} autoFocus maxLength={40} onChange={(event) => setValue(event.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name}>
          Add label
        </Button>
      </DialogFooter>
    </form>
  );
}
