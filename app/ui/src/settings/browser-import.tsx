import { type ReactNode, useCallback, useEffect, useState } from "react";

import {
  type ImportChoice,
  type ImportFailure,
  type ImportProgress,
  type ListedSource,
  type ProfileImportResult,
  type RowTone,
  iconOf,
  importedBadge,
  importProfile,
  importSources,
  lastImportSources,
  openFullDiskAccess,
  opensDialog,
  progressText,
  reasonText,
  retryable,
  rowView,
} from "../browser/imports";
import { useProfiles } from "../browser/profiles";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { SettingsCard } from "../components/settings-card";
import { showToast } from "../components/toast";
import { UsageBar } from "../components/usage-bar";
import { Globe } from "../icons";
import { errorText } from "../onboarding/api";
import { ProfileImportPick } from "./browser-import-pick";
import { ProfileImportResults } from "./browser-import-results";
import { SettingsPage, SettingsSection } from "./parts";

/** The Import Browser Data page's rows, for the page and for Settings search. */
export const BROWSER_IMPORT_ROWS = {
  import: {
    label: "Import from your browser",
    description: "Bring your sign-ins from Safari, Chrome, Arc, Dia, Brave, Edge and other Chromium browsers",
  },
} as const;

const SECTION_DESCRIPTION =
  "Bring your profiles from another browser on this computer. Each one becomes its own profile here, so previews and agent tabs open already signed in.";

/** A browser's app icon, or a globe in a tile when it has none. */
function BrowserIcon({ source, className }: { source: ListedSource; className?: string }) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => void iconOf(source).then(setIcon, () => setIcon(null)), [source]);
  return icon ? (
    <img src={icon} alt="" aria-hidden className={cx("size-8 shrink-0", className)} />
  ) : (
    <span aria-hidden className={cx("flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-quiet-foreground", className)}>
      <Globe className="size-icon-md" />
    </span>
  );
}

const DOT: Record<RowTone, string> = { ready: "bg-success", attention: "bg-warning", idle: "border border-quiet-foreground" };

/** Where a browser stands: a dot of its tone and the words. */
function BrowserStatus({ tone, status }: { tone: RowTone; status: string }) {
  return (
    <span data-slot="import-status" className={cx("inline-flex shrink-0 items-center gap-1.5", tone === "attention" && "text-warning")}>
      <span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      {status}
    </span>
  );
}

/** One browser: its icon, name and badge, where it stands, its button. */
function BrowserRow({ source, nowMs, disabled, alreadyIn, skipped, onAction }: { source: ListedSource; nowMs: number; disabled: boolean; alreadyIn?: string; skipped?: string; onAction: () => void }) {
  const view = rowView(source);
  return (
    <div data-slot="import-row" data-browser={source.key} className="flex items-center gap-3 px-4 py-3">
      <BrowserIcon source={source} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label font-medium">{source.name}</span>
          {source.record && (
            <Badge data-slot="import-badge" variant="secondary" className="font-normal">
              {importedBadge(source.record, nowMs)}
            </Badge>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-quiet-foreground">
          <BrowserStatus tone={view.tone} status={view.status} />
          {view.details.map((detail) => (
            <span key={detail} data-slot="import-detail" className="min-w-0">
              {detail}
            </span>
          ))}
          {alreadyIn && <span data-slot="import-detail" className="min-w-0">{alreadyIn}</span>}
          {skipped && <span data-slot="import-skipped" className="min-w-0">{skipped}</span>}
        </div>
      </div>
      {view.label && (
        <Button variant="soft" size="sm" disabled={disabled || view.action === "none"} onClick={onAction}>
          {view.label}
        </Button>
      )}
    </div>
  );
}

/** The heading every step of the dialog shares: the browser's icon and what is going on. */
export function FlowHeader({ source, title, description }: { source: ListedSource; title: string; description: string }) {
  return (
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2.5">
        <BrowserIcon source={source} className="size-6" />
        {title}
      </DialogTitle>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
  );
}

/** How far the cookies have come. */
function ImportBar({ progress }: { progress: ImportProgress | null }) {
  const share = progress?.type === "cookies" && progress.total > 0 ? progress.done / progress.total : 0;
  return <UsageBar value={share * 100} fill="bg-quiet-foreground" label="Import progress" />;
}

/** The line in place of the list: why it failed (`error`), or none found. */
function ImportStatusLine({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return <p className={cx(error ? "text-destructive" : "text-quiet-foreground", "px-1 text-sm")}>{children}</p>;
}

/** While the browsers are first listed: rows the size of a browser's, empty, so the list fills in rather than pushing the page down. */
function ListingRows() {
  return (
    <SettingsCard>
      <div role="status" aria-label="Looking for browsers" data-slot="import-listing">
        {[0, 1, 2].map((row) => (
          <div key={row} aria-hidden className="flex items-center gap-3 px-4 py-3">
            <span className="size-8 shrink-0 rounded-lg bg-fill-subtle" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* Lines of a row's sizes, their words hidden. */}
              <span className="w-fit rounded-sm bg-fill-subtle text-label text-transparent select-none">A browser&apos;s name</span>
              <span className="w-fit rounded-sm bg-fill-subtle text-xs text-transparent select-none">Where it stands, and its profiles</span>
            </div>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

/** The browsers as last listed; `atMs` is when, which "Imported 3 days ago" counts from. */
type List = { status: "loading" } | { status: "ready"; sources: ListedSource[]; atMs: number } | { status: "error"; message: string };

/** The dialog an import is in, if any. */
type Flow =
  | { step: "choose"; source: ListedSource }
  | { step: "results"; source: ListedSource; results: ProfileImportResult[] }
  | { step: "importing"; source: ListedSource; progress: ImportProgress | null }
  | { step: "fullDiskAccess"; source: ListedSource; checked: boolean; checking: boolean }
  | { step: "blocked"; source: ListedSource; reason: ImportFailure; message: string | null; checking: boolean };

/**
 * Settings › Import Browser Data: one row per browser installed on this computer, with where it stands and one button.
 * Import… asks which of its profiles' sign-ins to bring, each as a new profile or replacing one, then says per profile
 * how it went.
 */
export function BrowserImportPage() {
  // The browsers as last listed show at once; the page lists them again as it opens.
  const [list, setList] = useState<List>(() => {
    const last = lastImportSources();
    return last ? { status: "ready", ...last } : { status: "loading" };
  });
  const [flow, setFlow] = useState<Flow | null>(null);

  const fetchList = useCallback(
    () =>
      importSources().then(
        (sources) => {
          setList({ status: "ready", sources, atMs: Date.now() });
          return sources;
        },
        (cause: unknown) => {
          setList({ status: "error", message: errorText(cause) || "Could not check the installed browsers." });
          return null;
        },
      ),
    [],
  );
  useEffect(() => void fetchList(), [fetchList]);
  const load = () => {
    setList((current) => (current.status === "ready" ? current : { status: "loading" }));
    return fetchList();
  };

  const onProgress = (progress: ImportProgress) => setFlow((current) => (current?.step === "importing" ? { ...current, progress } : current));

  /** Imports the ticked profiles in turn; a refusal that needs the person stops the rest. */
  const run = async (source: ListedSource, choices: ImportChoice[]) => {
    setFlow({ step: "importing", source, progress: null });
    const results: ProfileImportResult[] = [];
    try {
      for (const choice of choices) {
        const result = await importProfile(source, choice, onProgress);
        const { outcome } = result;
        if (outcome.type === "failed" && opensDialog(outcome.reason)) {
          if (outcome.reason === "needsFullDiskAccess") setFlow({ step: "fullDiskAccess", source, checked: true, checking: false });
          else setFlow({ step: "blocked", source, reason: outcome.reason, message: null, checking: false });
          return;
        }
        results.push(result);
      }
      setFlow({ step: "results", source, results });
    } catch (cause: unknown) {
      setFlow(null);
      showToast(`${source.name}: ${errorText(cause)}`, { tone: "error" });
    } finally {
      void load();
    }
  };

  /** Import… on a browser that can be imported from. */
  const start = (source: ListedSource) => {
    if (source.profiles.length === 0) setFlow({ step: "blocked", source, reason: "gone", message: null, checking: false });
    else setFlow({ step: "choose", source });
  };

  /** Looks again after the person put something right, and goes on from where the browser is now. */
  const recheck = (current: Extract<Flow, { checking: boolean }>) => {
    setFlow({ ...current, checking: true });
    void load().then((sources) => {
      const fresh = sources?.find((source) => source.key === current.source.key);
      const blocked = (reason: ImportFailure) => setFlow({ step: "blocked", source: fresh ?? current.source, reason, message: null, checking: false });
      if (!fresh) return blocked("gone");
      switch (fresh.state) {
        case "running":
          return blocked("running");
        case "needsFullDiskAccess":
          return setFlow({ step: "fullDiskAccess", source: fresh, checked: current.step === "fullDiskAccess", checking: false });
        case "noKeychainKey":
          return blocked("noKeychainKey");
        case "unavailable":
          return blocked("readFailed");
        default:
          return start(fresh);
      }
    });
  };

  const act = (source: ListedSource) => {
    const { action } = rowView(source);
    if (action === "recheck") void load();
    else if (action === "grant") setFlow({ step: "fullDiskAccess", source, checked: false, checking: false });
    else if (action === "import") start(source);
  };

  const importing = flow?.step === "importing";
  const profiles = useProfiles();
  const already = (source: ListedSource) => {
    const ids = Object.entries(source.imports)
      .filter(([from]) => from.startsWith(`${source.key}/`))
      .map(([, place]) => place?.into);
    const names = profiles.filter((profile) => ids.includes(profile.id)).map((profile) => profile.name);
    if (names.length === 0) return undefined;
    return `${new Intl.ListFormat("en", { type: "conjunction" }).format(names)} already in Brigadier`;
  };
  return (
    <SettingsPage title="Import Browser Data">
      <SettingsSection
        title="Browsers"
        description={SECTION_DESCRIPTION}
        actions={
          <Button variant="ghost" size="sm" disabled={list.status === "loading" || importing} onClick={() => void load()}>
            Refresh
          </Button>
        }
      >
        <div data-setting={BROWSER_IMPORT_ROWS.import.label}>
          {list.status === "loading" ? (
            <ListingRows />
          ) : list.status === "error" ? (
            <ImportStatusLine error>{list.message}</ImportStatusLine>
          ) : list.sources.length === 0 ? (
            <ImportStatusLine>No supported browsers were found on this machine.</ImportStatusLine>
          ) : (
            <SettingsCard>
              {list.sources.map((source) => (
                <BrowserRow key={source.key} source={source} nowMs={list.atMs} disabled={importing} alreadyIn={already(source)} skipped={emptyLine(source)} onAction={() => act(source)} />
              ))}
            </SettingsCard>
          )}
        </div>
      </SettingsSection>
      <ImportDialog
        flow={flow}
        onClose={() => setFlow(null)}
        onImport={(source, choices) => void run(source, choices)}
        onRecheck={recheck}
      />
    </SettingsPage>
  );
}

function ImportDialog({
  flow: current,
  onClose,
  onImport,
  onRecheck,
}: {
  flow: Flow | null;
  onClose: () => void;
  onImport: (source: ListedSource, choices: ImportChoice[]) => void;
  onRecheck: (flow: Extract<Flow, { checking: boolean }>) => void;
}) {
  // While it closes, the dialog keeps showing its last step instead of shrinking away blank.
  const [last, setLast] = useState(current);
  if (current !== null && current !== last) setLast(current);
  const flow = current ?? last;
  // An import can't be walked away from halfway: no close button, and Esc and clicks outside wait.
  const importing = current?.step === "importing";
  const wide = flow?.step === "choose" || flow?.step === "results";
  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && !importing && onClose()}>
      <DialogContent data-slot="import-dialog" data-step={flow?.step} frame={cx(wide ? "max-w-import-dialog" : "max-w-dialog", "gap-4 p-5")} showCloseButton={flow?.step !== "importing"}>
        {flow?.step === "choose" && <ProfileImportPick key={flow.source.key} source={flow.source} onCancel={onClose} onImport={onImport} />}
        {flow?.step === "results" && <ProfileImportResults source={flow.source} results={flow.results} onDone={onClose} />}
        {flow?.step === "importing" && (
          <>
            <FlowHeader source={flow.source} title={`Importing from ${flow.source.name}…`} description={progressText(flow.progress)} />
            <ImportBar progress={flow.progress} />
          </>
        )}
        {flow?.step === "fullDiskAccess" && (
          <>
            <FlowHeader
              source={flow.source}
              title={`Allow Full Disk Access for ${flow.source.name}`}
              description={`${flow.source.name} keeps its cookies in a protected folder. Turn on Full Disk Access for Brigadier in System Settings › Privacy & Security, then come back. You can turn it off again after the import.`}
            />
            {flow.checked && !flow.checking && (
              <p data-slot="import-still-off" className="text-xs text-destructive">
                Full Disk Access is still off. macOS may need Brigadier to quit and reopen before the change applies.
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="outline" onClick={openFullDiskAccess}>
                Open System Settings
              </Button>
              <Button disabled={flow.checking} onClick={() => onRecheck(flow)}>
                {flow.checking ? "Checking…" : "I've turned it on"}
              </Button>
            </DialogFooter>
          </>
        )}
        {flow?.step === "blocked" && (
          <>
            <FlowHeader source={flow.source} title={`Can't import from ${flow.source.name}`} description={flow.message ?? reasonText(flow.reason, flow.source.name)} />
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {retryable(flow.reason) && (
                <Button disabled={flow.checking} onClick={() => onRecheck(flow)}>
                  {flow.checking ? "Checking…" : flow.reason === "running" ? "I've quit it" : "Try again"}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The source profiles with nothing to bring, which get no profile here. */
function emptyLine(source: ListedSource): string | undefined {
  const names = source.emptyProfiles;
  if (names.length === 0) return undefined;
  return `Skipped ${new Intl.ListFormat("en", { type: "conjunction" }).format(names)}: nothing to bring`;
}
