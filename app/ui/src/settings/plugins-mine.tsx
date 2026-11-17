import { useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { ChevronDown, Folder, Folders, Mcp, ToolsSkills } from "../icons";
import { SettingsSection } from "./parts";
import { chipOf, type Item, type Kind, matches, type Own, PLUGINS_ROWS, type Plugins, STATUS } from "./plugins";
import { AgentTile, PluginMark } from "./plugins-marks";

/** One item in the list's grid: its mark, name, line, where it's on, its standing and agents; its switch at the corner. */
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
          {item.note && <span className="text-xs text-quiet-foreground">{item.note}</span>}
          <span className="flex flex-wrap items-center gap-1.5 pt-1.5">
            {chip && <ScopeChip text={chip} />}
            {status && <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>}
            {item.agents.map((agent) => (
              <AgentTile key={agent} agent={agent} mark={marks[agent]} />
            ))}
          </span>
        </span>
      </button>
      <Switch aria-label={item.name} checked={item.on} onCheckedChange={onSwitch} />
    </SettingsCard>
  );
}

/** The skills that came with a catalog service, as one card [D580]: its logo, "Notion skillset", where it's on, its agents and one switch; the chevron lists its skills in place, each opening its page. */
function SkillsetCard({ id, skills, value, marks, onOpen, onSwitch }: { id: string; skills: Item[]; value: Plugins; marks: Record<string, string | null>; onOpen: (key: string) => void; onSwitch: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const entry = value.catalog?.entries.find((each) => each.id === id);
  const service = entry?.name ?? id;
  const on = skills.some((each) => each.on);
  const chip = chipOf(value, skills[0]!);
  return (
    <SettingsCard data-slot="skillset" data-key={id} data-off={!on || undefined} split={false} className="gap-3 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => onOpen(`catalog:${id}`)} aria-label={`Open ${service}`} className={cx("flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-start focus-visible:focus-ring", !on && "opacity-disabled")}>
          <PluginMark item={{ kind: "skill", name: service, detail: "", logo: id }} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-label font-medium">{service} skillset</span>
            <span className="truncate text-xs text-quiet-foreground">
              {skills.length} skills · came with {service}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 pt-1.5">
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

/** My Skills or My MCPs [D566, D580]: the library's, 2 columns of cards; then those found on this machine, to install. */
export function MyTab({
  value,
  kind,
  query,
  marks,
  remote,
  onOpen,
  onSwitch,
  onInstall,
  onBrowse,
  onAdd,
}: {
  value: Plugins;
  kind: Kind;
  query: string;
  marks: Record<string, string | null>;
  remote: boolean;
  onOpen: (key: string) => void;
  onSwitch: (key: string, on: boolean) => void;
  onInstall: (own: Own) => void;
  onBrowse: () => void;
  onAdd: () => void;
}) {
  const items = value.items.filter((each) => each.kind === kind && matches(query, each.name, each.description, each.detail));
  // A service's skills are one card, its skillset [D580].
  const sets = Map.groupBy(
    items.filter((each) => each.with),
    (each) => each.with!,
  );
  const own = value.own.filter((each) => each.kind === kind && matches(query, each.name, each.detail, each.from, ...each.agents, each.project ?? ""));
  if (!query.trim() && items.length === 0 && own.length === 0) return <EmptyTab tab={kind} onBrowse={onBrowse} onAdd={onAdd} />;
  if (items.length === 0 && own.length === 0)
    return (
      <p data-slot="no-match" className="py-6 text-center text-label text-quiet-foreground">
        Nothing matches “{query.trim()}”.
      </p>
    );
  return (
    <>
      {items.length > 0 && (
        <SettingsSection title={kind === "skill" ? "Skills" : "Servers"} setting={PLUGINS_ROWS[kind].label}>
          <div data-slot="plugins-grid" className="grid grid-cols-1 items-start gap-2.5 @reading:grid-cols-2">
            {[...sets].map(([id, skills]) => (
              <SkillsetCard key={id} id={id} skills={skills} value={value} marks={marks} onOpen={onOpen} onSwitch={(on) => onSwitch(`skillset:${id}`, on)} />
            ))}
            {items
              .filter((each) => !each.with)
              .map((each) => (
                <PluginCard key={each.key} item={each} chip={chipOf(value, each)} marks={marks} onOpen={() => onOpen(each.key)} onSwitch={(on) => onSwitch(each.key, on)} />
              ))}
          </div>
        </SettingsSection>
      )}
      {own.length > 0 && (
        <SettingsSection title={PLUGINS_ROWS.own.label} description={PLUGINS_ROWS.own.description} setting={PLUGINS_ROWS.own.label}>
          <div className="grid grid-cols-1 items-start gap-2.5 @reading:grid-cols-2">
            {own.map((each) => (
              <OwnCard key={each.key} own={each} marks={marks} remote={remote} onInstall={() => onInstall(each)} />
            ))}
          </div>
        </SettingsSection>
      )}
    </>
  );
}

/** One of an agent's own, read-only, as a card: where it is, which agents have it and from where; Install copies it in. */
function OwnCard({ own, marks, remote, onInstall }: { own: Own; marks: Record<string, string | null>; remote: boolean; onInstall: () => void }) {
  return (
    <SettingsCard data-slot="own-row" data-key={own.key} split={false} className="flex-row items-start gap-3 px-4 py-3.5">
      <PluginMark item={own} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-label font-medium">{own.name}</span>
        <span className="truncate font-mono text-xs text-quiet-foreground">{own.detail}</span>
        <span className="flex flex-wrap items-center gap-1.5 pt-1.5">
          {own.project && <ScopeChip text={own.project} />}
          {own.agents.map((agent) => (
            <AgentTile key={agent} agent={agent} mark={marks[agent]} />
          ))}
          <span className="text-xs text-quiet-foreground">{own.from}</span>
        </span>
      </span>
      {importable(own, remote) && (
        <Button variant="soft" size="sm" aria-label={`Install ${own.name}`} onClick={onInstall}>
          Install
        </Button>
      )}
    </SettingsCard>
  );
}

// A server at an address comes to the library with 4.13's sign-in.
export const importable = (own: Own, remote: boolean) => remote || !/^[a-z][a-z0-9+.-]*:\/\//i.test(own.detail);

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
