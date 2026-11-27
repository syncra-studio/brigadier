import { useState } from "react";

import { counted, type ImportChoice, type ListedSource } from "../browser/imports";
import { type BrowserProfile, tabsOn, useProfiles } from "../browser/profiles";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { DialogFooter } from "../components/dialog";
import { Select } from "../components/select";
import { FlowHeader } from "./browser-import";

const DAY = 86_400_000;
const PLATFORM = window.brigadier?.platform;
const MAC = PLATFORM === "darwin";

function when(atMs: number | undefined): string {
  if (atMs === undefined) return "Not imported yet";
  const days = Math.floor((Date.now() - atMs) / DAY);
  return days <= 0 ? "Imported today" : days === 1 ? "Imported yesterday" : `Imported ${days} days ago`;
}

/** Which profiles' sign-ins to bring, each as a new profile or replacing one. A profile already imported from here defaults to replacing what it became. */
export function ProfileImportPick({ source, onCancel, onImport }: { source: ListedSource; onCancel: () => void; onImport: (source: ListedSource, choices: ImportChoice[]) => void }) {
  const profiles = useProfiles();
  const before = (id: string): BrowserProfile | undefined => profiles.find((profile) => profile.id === source.imports[id]?.into);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(source.profiles.filter((each, index) => index === 0 || !before(each.id)).map((each) => each.id)));
  const [targets, setTargets] = useState<Record<string, string>>(() =>
    Object.fromEntries(source.profiles.map((each) => [each.id, before(each.id)?.id ?? "new"])),
  );
  const chosen = source.profiles.filter((each) => ticked.has(each.id));
  const replacing = new Set(chosen.map((each) => targets[each.id]).filter((target) => target !== "new"));
  // Two profiles can't replace the same one.
  const twice = replacing.size !== chosen.filter((each) => targets[each.id] !== "new").length;
  // A profile being imported into is let go of first, so its open pages load again.
  const reloading = profiles
    .filter((profile) => replacing.has(profile.id))
    .map((profile) => ({ name: profile.name, tabs: tabsOn(profile.id) }))
    .filter(({ tabs }) => tabs > 0);
  const options = [{ value: "new", label: "New profile" }, ...profiles.map((profile) => ({ value: profile.id, label: `Replace ${profile.name}` }))];
  return (
    <>
      <FlowHeader source={source} title={`Import from ${source.name}`} description="Each profile you tick stays separate in Brigadier." />
      <div data-slot="import-profiles" className="flex flex-col overflow-hidden rounded-settings border border-divider bg-card">
        {source.profiles.map((each) => {
          const on = ticked.has(each.id);
          return (
            <div key={each.id} data-slot="import-profile" className="flex items-center gap-3 px-4 py-3 not-last:border-b not-last:border-divider">
              <Checkbox
                aria-label={`Import ${each.name}`}
                checked={on}
                onCheckedChange={(next) =>
                  setTicked((current) => {
                    const updated = new Set(current);
                    if (next) updated.add(each.id);
                    else updated.delete(each.id);
                    return updated;
                  })
                }
              />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-label break-words">{each.name}</span>
                <span className="text-xs text-quiet-foreground">{when(before(each.id) && source.imports[each.id]?.atMs)}</span>
              </span>
              <Select label={`Import ${each.name} as`} value={targets[each.id] ?? "new"} onChange={(target) => setTargets((current) => ({ ...current, [each.id]: target }))} disabled={!on} className="w-40" options={options} />
            </div>
          );
        })}
      </div>
      <p className={twice ? "text-xs text-destructive" : "text-xs text-quiet-foreground"}>
        {twice ? "Two profiles can't replace the same one." : "Replacing swaps a profile's sign-ins for these."}
      </p>
      {reloading.length > 0 && (
        <p data-slot="import-reload" className="text-xs text-quiet-foreground">
          {reloading.map(({ name, tabs }) => `${counted(tabs, "open tab", "open tabs")} on ${name} will reload.`).join(" ")}
        </p>
      )}
      {!source.signIns && (
        <p data-slot="import-no-sign-ins" className="text-xs text-quiet-foreground">
          {source.name}'s sign-ins stay behind: they are locked with a key Brigadier doesn't touch. You'll sign in again here.
        </p>
      )}
      {/* What each system lets come over of a Chromium browser's sign-ins (crates/browser-data/src/keys.rs). */}
      {source.signIns && source.family === "chromium" && PLATFORM === "win32" && (
        <p data-slot="import-locked-sign-ins" className="text-xs text-quiet-foreground">
          On Windows, {source.name} locks its newer sign-ins to itself, so no other app can read them. Some sites will ask you to sign in again here.
        </p>
      )}
      {source.signIns && source.family === "chromium" && PLATFORM === "linux" && (
        <p data-slot="import-locked-sign-ins" className="text-xs text-quiet-foreground">
          {source.name}'s sign-ins open with its key in your keyring. If no keyring answers, or it's locked, sites will ask you to sign in again here.
        </p>
      )}
      {source.emptyProfiles.length > 0 && (
        <p data-slot="import-skipped" className="text-xs text-quiet-foreground">
          Skipped {new Intl.ListFormat("en", { type: "conjunction" }).format(source.emptyProfiles)}: nothing to bring.
        </p>
      )}
      {source.firstImport && (
        <p data-slot="import-agents" className="text-xs text-quiet-foreground">
          Agents working in a profile use its sign-ins. To keep agents out of a site, keep it in another profile.
        </p>
      )}
      <p className="text-xs text-quiet-foreground">
        Close {source.name} first. Your computer may ask you to allow access to its saved data.{" "}
        {MAC ? "Passkeys aren't copied: they stay on your device, and on this Mac they can't be used here yet." : "Passkeys aren't copied: they stay on your device and work here when a site asks."}
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={chosen.length === 0 || twice || !source.signIns} onClick={() => onImport(source, chosen.map((each) => ({ id: each.id, name: each.name, into: targets[each.id] ?? "new" })))}>
          Import {counted(chosen.length, "profile", "profiles")}
        </Button>
      </DialogFooter>
    </>
  );
}
