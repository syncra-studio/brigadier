import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { RowText, SettingsCard } from "../components/settings-card";
import { errorText } from "../onboarding/api";
import { SearchField } from "./archived-toolbar";
import { SettingsPage } from "./parts";
import type { Kind } from "./plugins";
import type { AddFirst } from "./plugins-dialogs";
import { PluginMark } from "./plugins-marks";

/** One search result, as Rust's `plugins browse` says it [D434]: `mark` the address or package its maker's mark may come from, `form` what Add is filled in with, null with `why` where Brigadier can't add it. */
export type Found = {
  key: string;
  kind: Kind;
  name: string;
  description: string;
  publisher: string;
  how: string;
  mark: string;
  in_library: boolean;
  form: { remote: boolean; name: string; url?: string; command?: string; values: string[] } | { source: string; skill: string } | null;
  why: string | null;
};

const SOURCE: Record<Kind, string> = { server: "the Official MCP Registry", skill: "skills.sh" };

/** Add filled in from a result: a server's form, its declared secrets' names with their values left to the user; a skill added at once [D418, D436]. */
function firstOf(form: NonNullable<Found["form"]>): AddFirst {
  if ("source" in form) return { form: { kind: "skill", from: form }, step: "adding", start: true };
  const values = form.values.map((name, id) => ({ id, name, value: "" }));
  return { form: { kind: "server", remote: form.remote, name: form.name, url: form.url ?? "", command: form.command ?? "", values } };
}

/**
 * Settings › Plugins › Browse [D434]: search the Official MCP Registry or skills.sh (Rust asks them), each result with
 * who published it, how it runs, and Add or "In your library". Add is the page's own Add dialog, filled in.
 */
export function BrowsePage({ tab: firstTab, browse, onAdd }: { tab: Kind; browse: (kind: Kind, query: string) => Promise<Found[]>; onAdd: (first: AddFirst, added: () => void) => void }) {
  const [tab, setTab] = useState(firstTab);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = query.trim();
  useEffect(() => {
    setFound(null);
    setError(null);
    if (!asked) return;
    let live = true;
    // Asked once typing pauses; an older answer never replaces a newer one.
    const timer = setTimeout(
      () =>
        browse(tab, asked).then(
          (next) => live && setFound(next),
          (cause: unknown) => live && setError(errorText(cause)),
        ),
      300,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tab, asked]);
  const held = (key: string) => setFound((now) => now && now.map((each) => (each.key === key ? { ...each, in_library: true } : each)));

  return (
    <SettingsPage title="Browse" description="Skills and MCP servers you don't have yet." back={{ label: "Plugins", href: "#settings/plugins" }}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Browse"
            value={tab}
            options={[
              { value: "server", label: "MCP servers" },
              { value: "skill", label: "Skills" },
            ]}
            onChange={setTab}
          />
          <span className="flex-1" />
          <div className="flex max-w-80 min-w-28 flex-1">
            <SearchField label={tab === "server" ? "Search MCP servers" : "Search skills"} value={query} onChange={setQuery} />
          </div>
        </div>
        {!asked ? null : error ? (
          <ErrorLine error={error} className="py-6 text-center" />
        ) : !found ? (
          <p role="status" className="py-6 text-center text-label text-quiet-foreground">
            Searching…
          </p>
        ) : found.length === 0 ? (
          <p className="py-6 text-center text-label text-quiet-foreground">Nothing matches “{asked}”.</p>
        ) : (
          <SettingsCard>
            {found.map((each) => (
              <div key={each.key} data-slot="found-row" className="flex items-center gap-3 px-4 py-3">
                {/* Its maker's mark only from its own address or package: anyone can name a server "Linear" [D437]. */}
                <PluginMark item={{ kind: each.kind, name: "", detail: each.mark }} />
                <RowText
                  title={each.name}
                  line={
                    <span className="flex flex-col gap-1">
                      {each.description && <span>{each.description}</span>}
                      <span>{[each.publisher, each.how].join(" · ")}</span>
                      {each.why && <span className="text-faint-foreground">{each.why}</span>}
                    </span>
                  }
                />
                {each.in_library ? (
                  <span className="w-28 shrink-0 text-end text-xs text-quiet-foreground">In your library</span>
                ) : (
                  each.form && (
                    <Button variant="soft" size="sm" className="w-28" aria-label={`Add ${each.name}`} onClick={() => onAdd(firstOf(each.form!), () => held(each.key))}>
                      Add
                    </Button>
                  )
                )}
              </div>
            ))}
          </SettingsCard>
        )}
        <p className="text-xs text-quiet-foreground">From {SOURCE[tab]}. Brigadier doesn't review these: add only what you trust.</p>
      </div>
    </SettingsPage>
  );
}
