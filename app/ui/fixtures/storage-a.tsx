// Mockup only: variant A, the overview first: one bar by kind, Free up space as a row, then the chats.
import { useState } from "react";

import { Button } from "../src/components/button";
import { ConfirmDialog } from "../src/components/confirm-dialog";
import { ProgressLine } from "../src/components/progress-line";
import { SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import { cx } from "../src/components/cx";
import { SettingsPage, SettingsSection } from "../src/settings/parts";
import { GROUPS, KINDS, gb, useStorage } from "./storage-data";
import { ChatList, Recount, Size, Stays, TotalBar } from "./storage-parts";

export function VariantA() {
  const storage = useStorage();
  const [asking, setAsking] = useState(false);
  const can = storage.freeable();
  return (
    <SettingsPage title="Storage" description="What Brigadier keeps on this computer." actions={<Recount storage={storage} />}>
      <SettingsSection title="Overview">
        <SettingsCard>
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-page-title font-medium tabular-nums">{gb(storage.total)}</span>
              <span className="text-xs text-quiet-foreground">{storage.counting ? <span className="shimmer">Counting…</span> : `${storage.left} free on this computer`}</span>
            </div>
            <TotalBar storage={storage} />
          </div>
          {KINDS.map(({ kind, label, line, fill }) => (
            <div key={kind} className="flex items-center gap-3 px-4 py-2.5">
              <span aria-hidden className={cx("size-2 shrink-0 rounded-capsule", fill)} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-label font-medium">{label}</span>
                <span className="text-xs text-quiet-foreground">{line}</span>
              </span>
              <Size value={storage.kindSize(kind)} ready={storage.ready(kind)} />
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Free up space">
        <SettingsCard>
          {storage.freeing ? (
            <div className="px-4 py-4">
              <ProgressLine title="Freeing up space" done={storage.freeing.done} total={storage.freeing.total} meta={`${gb(storage.freeing.done)} of ${gb(storage.freeing.total)}`} />
            </div>
          ) : (
            <SettingsRow
              label={storage.counting ? "Counting what can go" : can > 0 ? `${gb(can)} can be freed` : "Nothing to free up"}
              description="Finished workers' build files and leftovers of archived chats. Never chats or unmerged work."
            >
              <Button variant="secondary" size="sm" disabled={storage.counting || can === 0} onClick={() => setAsking(true)}>
                Free up space…
              </Button>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Largest chats" description="Each with its workers.">
        <ChatList storage={storage} open={["export"]} />
      </SettingsSection>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Free up ${gb(can)}?`}
        description="Build files and what archived chats left behind. Nothing else goes."
        confirm={`Free up ${gb(can)}`}
        onConfirm={() => {
          setAsking(false);
          storage.free(["build", "left"]);
        }}
      >
        <SettingsCard>
          {GROUPS.map(({ group, label, line }) => (
            <div key={group} className="flex items-center gap-4 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-label font-medium">{label}</span>
                <span className="text-xs text-quiet-foreground">{line}</span>
              </span>
              <Size value={storage.freeable(group)} />
            </div>
          ))}
        </SettingsCard>
        <Stays />
      </ConfirmDialog>
    </SettingsPage>
  );
}
