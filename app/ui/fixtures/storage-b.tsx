// Mockup only: variant B, by kind: each kind opens to what can go and what stays, freed on its own; chats as a table.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { cx } from "../src/components/cx";
import { SettingsCard } from "../src/components/settings-card";
import { UsageBar } from "../src/components/usage-bar";
import { Branch, ChevronRight, Spinner } from "../src/icons";
import { WorkerGlyph } from "../src/icons/worker-glyphs";
import { SettingsPage, SettingsSection } from "../src/settings/parts";
import { GROUPS, KINDS, type Kind, MORE, PER_CHAT, type Storage, gb, useStorage } from "./storage-data";
import { CountingRows, Marks, Recount, Size, Stays } from "./storage-parts";

/** Why the rest of a kind stays. */
const STAYS: Record<Kind, string> = {
  build: "Chats' own, and those of workers at work",
  worktrees: "Live chats', and those with unmerged work",
  temp: "Live chats' own",
  history: "Your chats. Delete one in Archived.",
  browser: "Clear it in Browser.",
};

export function VariantB() {
  const storage = useStorage();
  const can = storage.freeable();
  return (
    <SettingsPage
      title="Storage"
      description={storage.counting ? <span className="shimmer">Counting… {gb(storage.total)} so far</span> : `Brigadier uses ${gb(storage.total)}. ${storage.left} is free on this computer.`}
      actions={
        <>
          <Recount storage={storage} />
          <Button size="sm" disabled={storage.counting || storage.freeing !== null || can === 0} onClick={() => storage.free(["build", "left"])}>
            {storage.freeing && <Spinner className="motion-safe:animate-spin" />}
            {storage.freeing ? "Freeing…" : can === 0 && !storage.counting ? "Nothing to free up" : storage.counting ? "Free up space" : `Free up ${gb(can)}`}
          </Button>
        </>
      }
    >
      <SettingsSection title="By kind">
        <SettingsCard>
          {KINDS.map((each) => (
            <KindRow key={each.kind} {...each} storage={storage} first={each.kind === "build"} />
          ))}
        </SettingsCard>
        <div className="px-4 pt-1">
          <Stays />
        </div>
      </SettingsSection>
      <SettingsSection title="Largest chats">{storage.counting ? <CountingRows /> : <ChatTable storage={storage} />}</SettingsSection>
    </SettingsPage>
  );
}

function KindRow({ kind, label, line, fill, storage, first }: (typeof KINDS)[number] & { storage: Storage; first: boolean }) {
  const [open, setOpen] = useState(first);
  const ready = storage.ready(kind);
  const size = storage.kindSize(kind);
  const can = storage.freeable(undefined, kind);
  return (
    <Collapsible open={open && ready} onOpenChange={setOpen}>
      <CollapsibleTrigger disabled={!ready} className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-start hover:bg-fill-faint focus-visible:focus-ring">
        <ChevronRight className={cx("size-icon-sm shrink-0 text-quiet-foreground transition-transform motion-reduce:transition-none", open && ready && "rotate-90")} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-label font-medium">{label}</span>
          <span className="truncate text-xs text-quiet-foreground">{line}</span>
        </span>
        <UsageBar label={`${label}'s share`} value={ready && storage.total > 0 ? (size / storage.total) * 100 : 0} fill={fill} className="w-24" />
        <span className="flex w-16 justify-end">
          <Size value={size} ready={ready} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 ps-11 pe-4 pb-3">
          {GROUPS.filter(({ group }) => storage.freeable(group, kind) > 0.01).map(({ group, label: what }) => (
            <div key={group} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-label">{what}</span>
              <Button variant="soft" size="xs" disabled={storage.counting || storage.freeing !== null} onClick={() => storage.free([group], [kind])}>
                Free up
              </Button>
              <span className="flex w-16 justify-end">
                <Size value={storage.freeable(group, kind)} />
              </span>
            </div>
          ))}
          <div className="flex items-center gap-3 text-quiet-foreground">
            <span className="min-w-0 flex-1 truncate text-label">{STAYS[kind]}</span>
            <span className="text-xs">Stays</span>
            <span className="flex w-16 justify-end">
              <Size value={size - can} />
            </span>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const CELL = "px-3 py-2 text-end text-label whitespace-nowrap tabular-nums";
/** A size in the table: a dash where there is none. */
const cell = (size: number) => (size < 0.05 ? "–" : gb(size));

/** Chats and their workers, a column a kind. */
function ChatTable({ storage }: { storage: Storage }) {
  return (
    <SettingsCard>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap">
          <thead>
            <tr className="border-b border-divider text-xs text-quiet-foreground">
              <th scope="col" className="px-4 py-2 text-start font-medium">
                Chat
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                Total
              </th>
              {PER_CHAT.map((kind) => (
                <th key={kind} scope="col" className="px-3 py-2 text-end font-medium whitespace-nowrap">
                  {KINDS.find((each) => each.kind === kind)!.label}
                </th>
              ))}
            </tr>
          </thead>
          {storage.chats.map((chat) => (
            <tbody key={chat.id} className="border-b border-divider">
              <tr>
                <th scope="row" className="px-4 py-2 text-start font-normal">
                  <span className="flex min-w-0 items-center gap-2">
                    <Branch aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
                    <span className="text-label font-medium">{chat.title}</span>
                    <Marks holder={chat} />
                  </span>
                </th>
                <td className={cx(CELL, "font-medium")}>{gb(storage.chatSize(chat))}</td>
                {PER_CHAT.map((kind) => (
                  <td key={kind} className={CELL}>
                    {cell(storage.chatSize(chat, kind))}
                  </td>
                ))}
              </tr>
              {chat.workers.map((worker) => (
                <tr key={worker.id} className="text-quiet-foreground">
                  <th scope="row" className="py-1.5 ps-10 pe-4 text-start font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <WorkerGlyph id={worker.id} className="size-icon-sm" />
                      <span className="text-label">{worker.title}</span>
                      <Marks holder={worker} />
                    </span>
                  </th>
                  <td className={CELL}>{gb(storage.holderSize(worker))}</td>
                  {PER_CHAT.map((kind) => (
                    <td key={kind} className={CELL}>
                      {cell(storage.sizeOf(worker, kind))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
          <tbody>
            <tr className="text-quiet-foreground">
              <th scope="row" className="px-4 py-2 text-start text-label font-normal">
                {MORE} smaller chats
              </th>
              <td className={CELL}>{gb(storage.rest)}</td>
              <td colSpan={PER_CHAT.length} />
            </tr>
          </tbody>
        </table>
      </div>
    </SettingsCard>
  );
}
