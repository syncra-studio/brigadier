// Mockup only: variant C, what can go comes first: ticked groups that open to the exact chats, then the whole, then the
// chats with their own bars. The list is the confirm, so no dialog.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Checkbox } from "../src/components/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { cx } from "../src/components/cx";
import { ProgressLine } from "../src/components/progress-line";
import { SettingsCard } from "../src/components/settings-card";
import { CheckCircle, ChevronRight } from "../src/icons";
import { SettingsPage, SettingsSection } from "../src/settings/parts";
import { GROUPS, type Group, KINDS, type Storage, gb, useStorage } from "./storage-data";
import { ChatList, CountingRows, Recount, Size, Stays, TotalBar } from "./storage-parts";

export function VariantC() {
  const storage = useStorage();
  const [picked, setPicked] = useState<readonly Group[]>(["build", "left"]);
  const can = storage.freeable();
  const going = picked.reduce((sum, group) => sum + storage.freeable(group), 0);
  return (
    <SettingsPage title="Storage" description={storage.counting ? <span className="shimmer">Counting…</span> : `Brigadier uses ${gb(storage.total)}. ${storage.left} is free on this computer.`} actions={<Recount storage={storage} />}>
      <SettingsSection title="Free up space">
        {storage.counting ? (
          <CountingRows />
        ) : storage.freeing ? (
          <SettingsCard padded>
            <ProgressLine title="Freeing up space" done={storage.freeing.done} total={storage.freeing.total} meta={`${gb(storage.freeing.done)} of ${gb(storage.freeing.total)}`} />
          </SettingsCard>
        ) : can < 0.05 ? (
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
              <Button size="sm" disabled={going < 0.05} onClick={() => storage.free(picked)}>
                {going < 0.05 ? "Free up space" : `Free up ${gb(going)}`}
              </Button>
            </div>
          </SettingsCard>
        )}
      </SettingsSection>
      <SettingsSection title="Everything">
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
      <SettingsSection title="Largest chats">
        <ChatList storage={storage} bars open={["export"]} />
      </SettingsSection>
    </SettingsPage>
  );
}

/** One thing that can go: its tick, what it is, and opened, the chats it's in with how much goes from each. */
function GroupRow({ group, label, line, storage, checked, onChange }: (typeof GROUPS)[number] & { storage: Storage; checked: boolean; onChange: (on: boolean) => void }) {
  const [open, setOpen] = useState(group === "left");
  const size = storage.freeable(group);
  const inside = storage.all
    .map((chat) => ({ chat, size: [chat, ...chat.workers].reduce((sum, holder) => sum + storage.freeableOf(holder, group), 0) }))
    .filter((each) => each.size > 0.01)
    .sort((a, b) => Number(a.chat.many ?? 0) - Number(b.chat.many ?? 0) || b.size - a.size);
  if (size < 0.05) return null;
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
          {inside.map(({ chat, size: part }) => (
            <li key={chat.id} className="flex items-center gap-3 py-1 text-quiet-foreground">
              <span className="min-w-0 flex-1 truncate text-label">{chat.many ? `${chat.many} smaller chats` : chat.title}</span>
              <Size value={part} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
