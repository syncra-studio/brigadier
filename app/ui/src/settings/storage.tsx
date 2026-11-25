import { useState } from "react";

import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { ProgressLine } from "../components/progress-line";
import { SettingsCard } from "../components/settings-card";
import { useDaemon } from "../daemon";
import { CheckCircle, ChevronRight } from "../icons";
import { SettingsPage, SettingsSection } from "./parts";
import { GROUPS, type Group, KINDS, SOME, type Storage, gb, useStorage } from "./storage-data";
import { ChatList, CountingRows, Recount, Size, Stays, TotalBar, titleOf } from "./storage-parts";

/** The Storage page's rows, for Settings search. */
export const STORAGE_ROWS = {
  free: { label: "Free up space", description: "Finished workers' build files and leftovers of archived chats" },
  everything: { label: "Everything", description: "Build files, worktrees, temp files, chat history and browser data" },
  chats: { label: "Largest chats", description: "How much each chat and its workers take" },
} as const;

/** How much disk Brigadier takes, as Rust measures it, and Free up space; what can go comes first. */
export function StoragePage() {
  const online = Boolean(useDaemon().daemon);
  return <StorageView storage={useStorage()} online={online} />;
}

/** The list of what goes is the confirm, so no dialog. */
export function StorageView({ storage, online = true }: { storage: Storage; online?: boolean }) {
  const [picked, setPicked] = useState<readonly Group[]>(["build", "left"]);
  if (storage.error)
    return (
      <SettingsPage title="Storage">
        <SettingsCard>
          <div className="px-4 py-3">
            <ErrorLine
              error={`Couldn't count what Brigadier uses: ${storage.error}`}
              actions={
                <Button variant="link-blue" size="inline" onClick={storage.recount}>
                  Try again
                </Button>
              }
            />
          </div>
        </SettingsCard>
      </SettingsPage>
    );
  const can = storage.freeable();
  const going = picked.reduce((sum, group) => sum + storage.freeable(group), 0);
  const line = [`Brigadier uses ${gb(storage.total)}.`, typeof storage.disk === "number" && `${Math.round(storage.disk / 1e9)} GB is free on this computer.`].filter(Boolean).join(" ");
  return (
    <SettingsPage title="Storage" description={storage.counting ? <span className="shimmer">Counting…</span> : line} actions={<Recount storage={storage} online={online} />}>
      <SettingsSection title={STORAGE_ROWS.free.label} setting={STORAGE_ROWS.free.label}>
        {storage.counting ? (
          <CountingRows />
        ) : storage.freeing ? (
          <SettingsCard padded>
            <ProgressLine title="Freeing up space" done={storage.freeing.done} total={storage.freeing.total} meta={`${gb(storage.freeing.done)} of ${gb(storage.freeing.total)}`} />
          </SettingsCard>
        ) : can < SOME ? (
          <SettingsCard>
            <div className="flex items-center gap-3 px-4 py-4">
              <CheckCircle className="size-icon-md shrink-0 text-success" />
              <span className="flex flex-col gap-0.5">
                <span className="text-label font-medium">Nothing to free up</span>
                <Stays />
              </span>
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {GROUPS.map((each) => (
              <GroupRow key={each.group} {...each} storage={storage} checked={picked.includes(each.group)} onChange={(on) => setPicked(on ? [...picked, each.group] : picked.filter((group) => group !== each.group))} />
            ))}
            <div className="flex items-center gap-6 px-4 py-3">
              <span className="min-w-0 flex-1">
                <Stays />
              </span>
              <Button size="sm" disabled={going < SOME || !online} onClick={() => storage.free(picked)}>
                {going < SOME ? "Free up space" : `Free up ${gb(going)}`}
              </Button>
            </div>
          </SettingsCard>
        )}
      </SettingsSection>
      <SettingsSection title={STORAGE_ROWS.everything.label} setting={STORAGE_ROWS.everything.label}>
        <SettingsCard padded>
          <TotalBar storage={storage} />
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {KINDS.map(({ kind, label, fill }) => (
              <li key={kind} className="flex items-center gap-2">
                <span aria-hidden className={cx("size-2 shrink-0 rounded-capsule", fill)} />
                <span className="text-label text-quiet-foreground">{label}</span>
                <Size value={storage.kindSize(kind)} ready={storage.ready(kind)} />
              </li>
            ))}
          </ul>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={STORAGE_ROWS.chats.label} setting={STORAGE_ROWS.chats.label}>
        <ChatList storage={storage} />
      </SettingsSection>
    </SettingsPage>
  );
}

/** One thing that can go: its tick, what it is, and opened, the chats it's in with how much goes from each. */
function GroupRow({ group, label, line, storage, checked, onChange }: (typeof GROUPS)[number] & { storage: Storage; checked: boolean; onChange: (on: boolean) => void }) {
  const [open, setOpen] = useState(group === "left");
  const size = storage.freeable(group);
  const named = storage.chats.map((chat) => ({ id: chat.id, title: titleOf(chat), size: storage.freeableIn(chat, group) })).filter((each) => each.size > 0);
  named.sort((a, b) => b.size - a.size);
  const rest = storage.smaller.map((chat) => storage.freeableIn(chat, group)).filter((part) => part > 0);
  const inside = [...named, ...(rest.length > 0 ? [{ id: "rest", title: `${rest.length} smaller ${rest.length === 1 ? "chat" : "chats"}`, size: rest.reduce((sum, part) => sum + part, 0) }] : [])];
  if (size < SOME) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-3 px-4 py-3">
        <Checkbox aria-label={label} checked={checked} onCheckedChange={onChange} />
        <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-control text-start focus-visible:focus-ring">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-label font-medium">{label}</span>
            <span className="text-xs text-quiet-foreground">{line}</span>
          </span>
          <Size value={size} />
          <ChevronRight className={cx("size-icon-sm shrink-0 text-quiet-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <ul className="flex flex-col pb-3 ps-11 pe-11">
          {inside.map(({ id, title, size: part }) => (
            <li key={id} className="flex items-center gap-3 py-1 text-quiet-foreground">
              <span className="min-w-0 flex-1 truncate text-label">{title}</span>
              <Size value={part} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
