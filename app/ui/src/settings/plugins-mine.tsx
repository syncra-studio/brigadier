import { useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { ChevronDown, Folder, Folders, Mcp, ToolsSkills } from "../icons";
import { SettingsSection } from "./parts";
import { chipOf, type Item, type Kind, PLUGINS_ROWS, type Plugins, STATUS } from "./plugins";
import { AgentTile, PluginMark } from "./plugins-marks";

/** A card's chips: one row that never wraps, so every card is the same height; its note is on its page [D664]. */
const CHIPS = "mt-1.5 flex h-5 items-center gap-1.5 overflow-hidden";

/** One item in the list's grid: its mark, name, line, where it's on, its standing, agents and where it was found; its switch at the corner. */
function PluginCard({ item, chip, marks, onOpen, onSwitch }: { item: Item; chip: string | null; marks: Record<string, string | null>; onOpen: () => void; onSwitch: (on: boolean) => void }) {
  const status = item.on ? item.status : "off";
  // How it runs (a command, an address or a folder) is in code's letters; its chip says if it needs sign-in.
  const line = item.description || item.detail;
  return (
    <SettingsCard data-slot="plugin-row" data-key={item.key} data-off={!item.on || undefined} split={false} className="flex-row items-start gap-3 px-4 py-3.5">
      <button type="button" onClick={onOpen} aria-label={`Open ${item.name}`} className={cx("flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-start focus-visible:focus-ring", !item.on && "opacity-disabled")}>
        <PluginMark item={{ ...item, logo: item.catalog }} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-label font-medium">{item.name}</span>
          <span className={cx("truncate text-xs text-quiet-foreground", !item.description && "font-mono")}>{line}</span>
          <span className={CHIPS}>
            {chip && <ScopeChip text={chip} />}
            {status && <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>}
            {item.agents.map((agent) => (
              <AgentTile key={agent} agent={agent} mark={marks[agent]} />
            ))}
            {item.from && <span className="min-w-0 truncate text-xs text-quiet-foreground">{item.from}</span>}
          </span>
        </span>
      </button>
      <Switch aria-label={item.name} checked={item.on} onCheckedChange={onSwitch} />
    </SettingsCard>
  );
}

/** The skills that came with a catalog service, or were found from one source (D720), as one card [D580]: its logo, "Notion skillset", where it's on, its agents and one switch; the chevron lists its skills in place, each opening its page. */
function SkillsetCard({ id, skills, value, marks, onOpen, onSwitch }: { id: string; skills: Item[]; value: Plugins; marks: Record<string, string | null>; onOpen: (key: string) => void; onSwitch: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const entry = value.catalog?.entries.find((each) => each.id === id);
  const service = entry?.name ?? id;
  const on = skills.some((each) => each.on);
  const chip = chipOf(value, skills[0]!);
  return (
    <SettingsCard data-slot="skillset" data-key={id} data-off={!on || undefined} split={false} className="gap-3 px-4 py-3.5">
      <div className="flex items-start gap-3">
        {/* One found has no catalog page: it opens its list. */}
        <button type="button" onClick={() => (entry ? onOpen(`catalog:${id}`) : setOpen(!open))} aria-label={`Open ${service}`} className={cx("flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-start focus-visible:focus-ring", !on && "opacity-disabled")}>
          <PluginMark item={{ kind: "skill", name: service, detail: "", logo: id }} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-label font-medium">{service} skillset</span>
            <span className="truncate text-xs text-quiet-foreground">
              {skills.length} skills · {entry ? `came with ${service}` : skills[0]!.from}
            </span>
            <span className={CHIPS}>
              {chip && <ScopeChip text={chip} />}
              {skills[0]!.agents.map((agent) => (
                <AgentTile key={agent} agent={agent} mark={marks[agent]} />
              ))}
            </span>
          </span>
        </button>
        <Button variant="ghost" size="icon-xs" aria-label={open ? "Hide its skills" : "Show its skills"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDown aria-hidden className={cx(open && "rotate-180")} />
        </Button>
        <Switch aria-label={`${service} skillset`} checked={on} onCheckedChange={onSwitch} />
      </div>
      {open && (
        <div className="ms-12 flex flex-col gap-1 border-t border-divider pt-2">
          {skills.map((each) => (
            <button key={each.key} type="button" onClick={() => onOpen(each.key)} className="flex cursor-pointer flex-col gap-0.5 rounded-control py-1.5 text-start focus-visible:focus-ring">
              <span className="text-label font-medium">{each.name}</span>
              <span className="text-xs text-quiet-foreground">{entry?.skills?.find((skill) => skill.skill === each.name)?.line ?? each.description}</span>
            </button>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}

/** Where an item is on, as a tag: "Global", a project's name, "3 projects". */
export function ScopeChip({ text }: { text: string }) {
  const Icon = text === "Global" ? Folders : Folder;
  return (
    <span data-slot="scope-chip" className="flex h-5 w-fit shrink-0 items-center gap-1 rounded-capsule bg-fill-subtle px-2 text-xs text-quiet-foreground">
      <Icon aria-hidden className="size-3" />
      {text}
    </span>
  );
}

/** The Skills or MCP servers tab [D566, D580, D718, D724]: the library's, what the agents have on this machine among them [D721], 2 columns of cards. */
export function MyTab({
  value,
  kind,
  marks,
  onOpen,
  onSwitch,
  onBrowse,
  onAdd,
}: {
  value: Plugins;
  kind: Kind;
  marks: Record<string, string | null>;
  onOpen: (key: string) => void;
  onSwitch: (key: string, on: boolean) => void;
  onBrowse: () => void;
  onAdd: () => void;
}) {
  const items = value.items.filter((each) => each.kind === kind);
  // A service's skills are one card, its skillset [D580]; so are those found from one source [D720].
  const sets = Map.groupBy(
    items.filter((each) => each.with ?? each.set),
    (each) => (each.with ?? each.set)!,
  );
  if (items.length === 0) return <EmptyTab tab={kind} onBrowse={onBrowse} onAdd={onAdd} />;
  return (
    <SettingsSection title={kind === "skill" ? "Skills" : "Servers"} setting={PLUGINS_ROWS[kind].label}>
      <div data-slot="plugins-grid" className="grid grid-cols-1 items-start gap-2.5 @reading:grid-cols-2">
        {[...sets].map(([id, skills]) => (
          <SkillsetCard key={id} id={id} skills={skills} value={value} marks={marks} onOpen={onOpen} onSwitch={(on) => onSwitch(`skillset:${id}`, on)} />
        ))}
        {items
          .filter((each) => !(each.with ?? each.set))
          .map((each) => (
            <PluginCard key={each.key} item={each} chip={chipOf(value, each)} marks={marks} onOpen={() => onOpen(each.key)} onSwitch={(on) => onSwitch(each.key, on)} />
          ))}
      </div>
    </SettingsSection>
  );
}

/** A tab with nothing in it yet: Browse, or Add your own. */
function EmptyTab({ tab, onBrowse, onAdd }: { tab: Kind; onBrowse: () => void; onAdd: () => void }) {
  const Icon = tab === "server" ? Mcp : ToolsSkills;
  return (
    <SettingsCard data-slot="plugins-empty" split={false} className="items-center gap-2 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-nav bg-fill-subtle">
        <Icon aria-hidden className="size-5 text-quiet-foreground" />
      </span>
      <span className="pt-2 text-sm font-medium">No {tab === "skill" ? "skills" : "MCP servers"} yet</span>
      <span className="text-label text-quiet-foreground">Install one once and every agent can use it, in all your projects or just some.</span>
      <span className="flex items-center gap-3 pt-3">
        <Button size="sm" onClick={onBrowse}>
          Browse
        </Button>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          Add your own
        </Button>
      </span>
    </SettingsCard>
  );
}
