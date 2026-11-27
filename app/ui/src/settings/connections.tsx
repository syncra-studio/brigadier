import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { RowText, SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { ChatCompose, CheckCircle, Desktop, Reload, Sparkle, Sun } from "../icons";
import { errorText, run } from "../onboarding/api";
import { useSave } from "./general";
import { type Device, DeviceRow } from "./connections-device";
import { SettingsPage, SettingsSection } from "./parts";

/** The Connections page's rows, for the page and for Settings search (the reference's words, design §1) [D45]. */
export const CONNECTIONS_ROWS = {
  devices: { label: "Devices that can control this Mac", description: "Add device to control this Mac remotely", section: "Control this Mac" },
  allow: { label: "Allow connections", section: "Control this Mac" },
  awake: { label: "Keep this Mac awake", description: "Prevent sleep when this computer is plugged in and remote access is enabled", section: "Other settings" },
} as const;

/** `brigadier remote status`, as the daemon says it (lane A's M2a). */
type Status = {
  on: boolean;
  port: number | null;
  name: string;
  offer: { url: string; code: string | null; svg: string; expires: number } | null;
  pending: { device: string; check: string } | null;
  warning: "reused" | null;
  devices: Device[];
  /** null until the daemon can hold the Mac awake for the phone (M5): the toggle hides. */
  awake: boolean | null;
};

/** Where Add is: the card, the Allow question, the QR, the "You're connected" card. The check is the daemon's `pending`. */
type Step = "intro" | "allow" | "qr" | "connected";

const STATUS_MS = 1000;
// A fresh offer this long before the shown one expires.
const REFRESH_MS = 60_000;
const AUTO_MS = 10_000;

const remote = (...args: string[]) => run(["remote", ...args]);

/**
 * Settings › Connections, "Control this Mac" as the design's reference has it [D45]: the devices that can control this Mac, Allow connections, and
 * Add's steps (the card, Allow, the QR, the check both screens show, You're connected). The daemon's status, read every second
 * while the page shows; it pushes nothing. Only with BRIGADIER_REMOTE=1 (pages.ts).
 */
export function ConnectionsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  // Revoked here, hidden until the daemon's list drops them.
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set());
  const save = useSave();
  const awakeSave = useSave();
  // Polls, refreshes and reloads overlap: a reply older than one already shown is dropped.
  const asked = useRef(0);
  const shown = useRef(0);
  const fresh = (n: number) => n > shown.current && ((shown.current = n), true);
  const load = () => {
    const n = ++asked.current;
    return remote("status").then(
      (reply) => {
        if (!fresh(n)) return;
        const next = reply as Status;
        setStatus(next);
        setError(null);
        // Once the daemon's list drops a revoked device, stop hiding its id: the same phone may pair again.
        setRevoked((last) => (last.size ? new Set([...last].filter((id) => next.devices.some((device) => device.id === id))) : last));
      },
      (cause: unknown) => fresh(n) && setError(errorText(cause)),
    );
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), STATUS_MS);
    return () => clearInterval(timer);
  }, []);
  const on = wanted ?? status?.on ?? false;
  const devices = (status?.devices ?? []).filter((device) => !revoked.has(device.id));
  const allow = (next: boolean) => {
    setWanted(next);
    save.run(() => remote(next ? "on" : "off").then(load).finally(() => setWanted(null)));
  };
  const revoke = (id: string) => {
    setRevoked((last) => new Set(last).add(id));
    save.run(() =>
      remote("revoke", id)
        .then(load)
        .catch((cause: unknown) => {
          setRevoked((last) => new Set([...last].filter((each) => each !== id)));
          throw cause;
        }),
    );
  };
  const add = () => setStep(on ? "qr" : "intro");
  const awake = status?.awake ?? null;
  const awakeRow =
    awake === null ? null : (
      <SettingsRow label={CONNECTIONS_ROWS.awake.label} description={CONNECTIONS_ROWS.awake.description} error={awakeSave.error}>
        <Switch aria-label={CONNECTIONS_ROWS.awake.label} checked={awake} onCheckedChange={(next) => awakeSave.run(() => remote("awake", next ? "on" : "off").then(load))} />
      </SettingsRow>
    );
  const empty = !on && devices.length === 0;
  return (
    <SettingsPage title="Connections">
      {/* Three tabs in the end; the other two come with their steps (design §1 row 1). */}
      <Segmented label="Connections" value="mac" options={[{ value: "mac", label: "Control this Mac" }]} onChange={() => {}} className="-mt-5" />
      <SettingsSection
        title={CONNECTIONS_ROWS.devices.label}
        setting={CONNECTIONS_ROWS.allow.label}
        actions={
          status &&
          !empty && (
            <>
              <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()}>
                <Reload aria-hidden />
              </Button>
              <Button size="sm" onClick={add}>
                Add
              </Button>
            </>
          )
        }
      >
        <ErrorLine error={error} />
        {status && empty && (
          <div className="flex flex-col items-center gap-3 pb-2">
            <EmptyState variant="centered" icon={Desktop} title={CONNECTIONS_ROWS.devices.description} className="pb-0" />
            <Button size="sm" onClick={add}>
              Add
            </Button>
          </div>
        )}
        {status && !empty && (
          <SettingsCard>
            <SettingsRow label={CONNECTIONS_ROWS.allow.label} error={save.error}>
              <Switch aria-label={CONNECTIONS_ROWS.allow.label} checked={on} disabled={wanted !== null} onCheckedChange={allow} />
            </SettingsRow>
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} revoke={() => revoke(device.id)} load={load} />
            ))}
          </SettingsCard>
        )}
      </SettingsSection>
      {awakeRow && (
        <SettingsSection title="Other settings">
          <SettingsCard>{awakeRow}</SettingsCard>
        </SettingsSection>
      )}
      {status && (
        <AddDialog
          status={status}
          step={step}
          setStep={setStep}
          allow={() => remote("on").then(load)}
          load={load}
          awakeRow={awakeRow}
          error={error}
        />
      )}
    </SettingsPage>
  );
}

/** Add's steps as one dialog; the daemon's pending check opens it wherever Add was left. */
function AddDialog({ status, step, setStep, allow, load, awakeRow, error }: { status: Status; step: Step | null; setStep: (step: Step | null) => void; allow: () => Promise<unknown>; load: () => Promise<unknown>; awakeRow: ReactNode; error: string | null }) {
  const act = useSave();
  // A check from before the daemon stopped answering can't be answered: let it close.
  const pending = error ? null : status.pending;
  const shown = pending ? "check" : step;
  const close = () => setStep(null);
  return (
    <Dialog open={shown !== null} onOpenChange={(open) => !open && !pending && close()}>
      <DialogContent data-dialog="remote-add" showCloseButton={shown !== "check"} frame="max-w-dialog gap-5 p-6 text-center">
        {shown === "intro" && (
          <>
            <Head title="Connect a device to this Mac" line="Continue sessions from Brigadier on your phone or another device" />
            <ul className="flex flex-col gap-4 text-start">
              <Point icon={ChatCompose} title="Pick up where you left off" line="Continue any session or project from Brigadier on your phone" />
              {/* "Stay in the loop" comes with notifications (step 2, design §1 row 3). */}
              <Point icon={Sparkle} title="Start something new" line="Just send a message to start a session on your Mac" />
            </ul>
            <div className="flex justify-center gap-2">
              <Button variant="secondary" onClick={close}>
                Later
              </Button>
              <Button onClick={() => setStep(status.on ? "qr" : "allow")}>Get started</Button>
            </div>
          </>
        )}
        {shown === "allow" && (
          <>
            <Head title="Allow devices to control this computer?" line="This lets authorized devices, such as your phone, connect to Brigadier and control this computer remotely" />
            <ErrorLine error={act.error} />
            <div className="flex justify-center gap-2">
              <Button onClick={() => act.run(() => allow().then(() => setStep("qr")))}>Allow</Button>
            </div>
          </>
        )}
        {shown === "qr" && <Offer status={status} load={load} error={error} />}
        {shown === "check" && pending && (
          <>
            <Head title={`Allow “${pending.device}” to control this Mac?`} line="Check that your device shows the same code." />
            <p data-slot="remote-check" className="font-mono text-page-title tracking-widest">
              {pending.check.replace(/^(\d{3})(\d{3})$/, "$1 $2")}
            </p>
            <ErrorLine error={act.error} />
            <div className="flex justify-center gap-2">
              <Button variant="secondary" onClick={() => act.run(() => remote("deny").then(load).then(close))}>
                Deny
              </Button>
              <Button onClick={() => act.run(() => remote("allow").then(load).then(() => setStep("connected")))}>Allow</Button>
            </div>
          </>
        )}
        {shown === "connected" && (
          <>
            <CheckCircle aria-hidden className="mx-auto size-icon-lg" />
            <Head title="You’re connected" line="Make the most out of your new connection. You can change these later in Settings." />
            {awakeRow && <SettingsCard className="text-start">{awakeRow}</SettingsCard>}
            <div className="flex justify-center gap-2">
              <Button onClick={close}>Done</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The QR the daemon drew, a fresh one 60 s before it expires, on refresh, and after a reused one; its typed code below. */
function Offer({ status, load, error }: { status: Status; load: () => Promise<unknown>; error: string | null }) {
  const [typed, setTyped] = useState(false);
  const fresh = useSave();
  // Kept while Add stays open: the fresh offer clears the daemon's warning at once.
  const [reused, setReused] = useState(false);
  const asking = useRef(false);
  // When it last asked by itself: at most once per AUTO_MS, whatever the daemon's offers say.
  const renewed = useRef(0);
  const shownOne = useRef(false);
  const renew = () => {
    if (asking.current) return;
    asking.current = true;
    renewed.current = Date.now();
    fresh.run(() => remote("offer").then(load).finally(() => (asking.current = false)));
  };
  const offer = status.offer;
  // Each status tick: none yet, or about to expire; and when the daemon says the shown one was used again.
  useEffect(() => {
    if (status.warning === "reused") setReused(true);
    // A shown offer gone means a phone took it: wait for its check, so the same QR scanned again reads as reused.
    if (offer) shownOne.current = true;
    else if (shownOne.current) [shownOne.current, renewed.current] = [false, Date.now()];
    // No port yet: the gateway is still starting and refuses offers.
    const due = status.port !== null && (!offer || offer.expires - Date.now() < REFRESH_MS || status.warning === "reused");
    if (due && Date.now() - renewed.current > AUTO_MS) renew();
  });
  return (
    <>
      <Head title="Approve on your device to control this Mac remotely" />
      {reused && <p className="text-label text-warning">This code was already used, so a new one was made. Scan the new one.</p>}
      <div className="flex flex-col items-center gap-2">
        {/* While polls fail the shown offer may be gone (a restart drops it): no QR to scan. */}
        {offer && !error ? (
          // The daemon's SVG as an image, never as markup.
          <img data-slot="remote-qr" alt="Pairing QR code" className="size-48 rounded-settings" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(offer.svg)}`} />
        ) : (
          <div className="size-48" />
        )}
        <Button variant="ghost" size="icon" aria-label="New code" onClick={renew}>
          <Reload aria-hidden />
        </Button>
      </div>
      <ErrorLine error={error ?? fresh.error} />
      {offer?.code &&
        (typed ? (
          <p data-slot="remote-code" className="font-mono text-base tracking-wider select-all">
            {offer.code.replace(/(.{4})(?=.)/g, "$1 ")}
          </p>
        ) : (
          <Button variant="link-blue" size="inline" className="mx-auto" onClick={() => setTyped(true)}>
            Enter code manually
          </Button>
        ))}
    </>
  );
}

function Head({ title, line }: { title: string; line?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <DialogTitle className="px-6 text-lg">{title}</DialogTitle>
      {line && <DialogDescription>{line}</DialogDescription>}
    </div>
  );
}

function Point({ icon: Icon, title, line }: { icon: ComponentType<{ className?: string }>; title: string; line: string }) {
  return (
    <li className="flex items-start gap-3">
      <Icon className="mt-0.5 size-icon-md shrink-0 text-quiet-foreground" />
      <RowText title={title} line={line} />
    </li>
  );
}
