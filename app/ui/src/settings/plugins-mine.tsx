import { Fragment, type ReactNode, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { ChevronDown, Mcp, ToolsSkills } from "../icons";
import { SettingsSection } from "./parts";
import { chipOf, type Item, type Kind, PLUGINS_ROWS, type Plugins, STATUS, type Status } from "./plugins";
import { Pick, PickGrid } from "./plugins-browse";
import { PluginMark } from "./plugins-marks";

/** A problem worth a badge in the title row [D737]; Signed in and Off say nothing there. */
const PROBLEM: Partial<Record<Status, true>> = { needs_sign_in: true, cant_reach: true };

/** Browse's grey line [D737]: "<scope> · <description or command>", one line; a command in code's letters. */
function lineOf(chip: string | null, text: ReactNode) {
  const parts = [chip, text].filter(Boolean);
  return parts.map((part, at) => (
    <Fragment key={at}>
      {at > 0 && " · "}
      {part}
    </Fragment>
  ));
}

/** The item's name, with its problem (Needs sign-in, Can't reach, ...) as a badge right after it [D737]. */
function titleOf(name: string, status: Status | null) {
  if (!status || !PROBLEM[status]) return name;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{name}</span>
      <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
    </span>
  );
}

/** One item, as a row of Browse's [D734]: its mark, name (with its problem's badge [D737]) and line, its switch where Browse has +; it opens its page. */
function PluginRow({ item, chip, onOpen, onSwitch }: { item: Item; chip: string | null; onOpen: () => void; onSwitch: (on: boolean) => void }) {
  const text = item.description || <span className="font-mono">{item.detail}</span>;
  const status = item.on ? item.status : null;
  return (
    <div data-slot="plugin-row" data-key={item.key} data-off={!item.on || undefined} >
      <Pick dim={!item.on} mark={<PluginMark item={{ ...item, logo: item.catalog }} />} name={titleOf(item.name, status)} line={lineOf(chip, text)} onOpen={onOpen} end={<Switch aria-label={item.name} checked={item.on} onCheckedChange={onSwitch} />} />
    </div>
  );
}

/** The skills that came with a catalog service, or were found from one source (D720), as one row [D580]: its logo, "Notion skillset", where it's on and one switch; the chevron lists its skills in place, each opening its page. */
function SkillsetRow({ id, skills, value, onOpen, onSwitch }: { id: string; skills: Item[]; value: Plugins; onOpen: (key: string) => void; onSwitch: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const entry = value.catalog?.entries.find((each) => each.id === id);
  const service = entry?.name ?? id;
  const on = skills.some((each) => each.on);
  return (
    <div data-slot="skillset" data-key={id} data-off={!on || undefined} >
      <Pick
        dim={!on}
        mark={<PluginMark item={{ kind: "skill", name: service, detail: "", logo: id }} />}
        name={`${service} skillset`}
        line={lineOf(chipOf(value, skills[0]!), `${skills.length} skills · ${entry ? `came with ${service}` : skills[0]!.from}`)}
        // One found has no catalog page: it opens its list.
        onOpen={() => (entry ? onOpen(`catalog:${id}`) : setOpen(!open))}
        end={
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="icon-xs" aria-label={open ? "Hide its skills" : "Show its skills"} aria-expanded={open} onClick={() => setOpen(!open)}>
              <ChevronDown aria-hidden className={cx(open && "rotate-180")} />
            </Button>
            <Switch aria-label={`${service} skillset`} checked={on} onCheckedChange={onSwitch} />
          </span>
        }
      />
      {open && (
        <div className="ms-14 mb-2 flex flex-col gap-1 border-t border-divider pt-2">
          {skills.map((each) => (
            <button key={each.key} type="button" onClick={() => onOpen(each.key)} className="flex cursor-pointer flex-col gap-0.5 rounded-control py-1.5 text-start focus-visible:focus-ring">
              <span className="text-label font-medium">{each.name}</span>
              <span className="text-xs text-quiet-foreground">{entry?.skills?.find((skill) => skill.skill === each.name)?.line ?? each.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The Skills or MCP servers tab [D566, D580, D718, D724]: the library's, what the agents have on this machine among them [D721], 2 columns of Browse's rows [D734]. */
export function MyTab({
  value,
  kind,
  onOpen,
  onSwitch,
  onBrowse,
  onAdd,
}: {
  value: Plugins;
  kind: Kind;
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
      <PickGrid>
        {[...sets].map(([id, skills]) => (
          <SkillsetRow key={id} id={id} skills={skills} value={value} onOpen={onOpen} onSwitch={(on) => onSwitch(`skillset:${id}`, on)} />
        ))}
        {items
          .filter((each) => !(each.with ?? each.set))
          .map((each) => (
            <PluginRow key={each.key} item={each} chip={chipOf(value, each)} onOpen={() => onOpen(each.key)} onSwitch={(on) => onSwitch(each.key, on)} />
          ))}
      </PickGrid>
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
