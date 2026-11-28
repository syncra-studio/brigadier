import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { CONNECTION_WORDS } from "../app/shared/words";
import { CheckCircle } from "../app/ui/src/icons";
import Link, { type Mac } from "./modules/link";
import { close, onClosed } from "./src/link";
import { start, stop } from "./src/mac/mac";
import { MacScreens } from "./src/mac/MacScreens";
import { composerSample, loadComposerSample, loadSample, loadSheets, SHEETS } from "./src/mac/sample";
import { Confirm } from "./src/act/Confirm";
import { FULL_ACCESS } from "./src/powers/Level";
import { nightWords } from "./src/powers/Overnight";
import { shellPower } from "./src/powers/powers";
import { VIEW_WORDS } from "./src/powers/View";
import { Lock } from "./src/Lock";
import { Macs, type Status } from "./src/macs/Macs";
import { Notice, PROBLEMS } from "./src/Notice";
import { Code } from "./src/pair/Code";
import { Connect } from "./src/pair/Connect";
import { Finishing } from "./src/pair/Finishing";
import { pair, readQr, signIn, type Offer, type Problem } from "./src/pair/pair";
import { Scan } from "./src/pair/Scan";

type At =
  | { at: "connect" | "scan" | "code" | "macs" }
  | { at: "finishing"; check?: string }
  | { at: "connected"; mac: Mac }
  | { at: "mac"; mac: Mac }
  | { at: "notice"; problem: Problem; retry?: () => void };

// `-screen <name>` opens one screen with sample data and no network, for simulator screenshots (no Face ID there).
// `samples:<file>` is the Samples screen with that one sample file, for side-by-side pictures.
const sample = Link.screen?.startsWith("samples:") ? "samples" : Link.screen;
const SAMPLE_MAC: Mac = { pk: "sample", name: "MacBook Pro", device: "", addresses: [] };
/** `-screen power-…`: each power's Face ID sheet over the sample thread (`-screen powers`), with sample args; `start-confirm`, a new chat's over New chat. */
const POWER_SHEETS: Record<string, { title: string; body?: string; shown: string; args: string[] }> = {
  "power-shell": shellPower("s1", 'npm test -- --watch=false && rm -rf "build/tmp"', "c-1"),
  "power-full": { ...FULL_ACCESS, args: ["level", "s1", "full", "--op", "o1"] },
  "power-overnight": { ...nightWords("start", false), shown: "Fix the failing login test", args: ["overnight", "s1", "start", "--op", "o1"] },
  "start-confirm": { title: "Start this chat on your Mac?", body: "In brigadier, on Opus 4.5, High.", shown: "Add a dark mode switch to Settings, and remember the choice", args: [] },
  "power-view": { ...VIEW_WORDS, shown: "/private/tmp/screenshots/login-page.png", args: ["attach", "s1", "view", "/private/tmp/screenshots/login-page.png"] },
};
const powers = sample === "powers" || (sample !== null && sample in POWER_SHEETS);
function sampleAt(): At {
  if (sample === "finishing") return { at: "finishing", check: "042917" };
  if (sample === "connected") return { at: "connected", mac: SAMPLE_MAC };
  if (composerSample) {
    loadComposerSample(composerSample);
    return { at: "mac", mac: SAMPLE_MAC };
  }
  if (sample === "sessions" || sample === "thread" || sample === "samples" || sample === "markdown" || powers || SHEETS.includes(sample!)) {
    loadSample(powers, sample === "markdown");
    if (SHEETS.includes(sample!)) loadSheets(sample!);
    return { at: "mac", mac: SAMPLE_MAC };
  }
  if (sample?.startsWith("notice-")) return { at: "notice", problem: sample.slice(7) as Problem };
  if (sample === "scan" || sample === "code" || sample === "macs" || sample === "act") return { at: sample === "act" ? "macs" : sample };
  return { at: "connect" };
}

export default function App() {
  const [unlocked, setUnlocked] = useState(sample !== null && sample !== "lock");
  const [macs, setMacs] = useState<Mac[] | null>(sample ? [SAMPLE_MAC] : null);
  const [status, setStatus] = useState<Record<string, Status>>(sample ? { sample: "connected" } : {});
  const [at, setAt] = useState<At>(sample ? sampleAt() : { at: "connect" });
  const home = (list = macs): At => ({ at: list?.length ? "macs" : "connect" });
  // Each pairing attempt's number; Cancel moves it on, so the cancelled attempt's result is dropped.
  const attempt = useRef(0);
  // The sign-in on opening runs once; later ones are the user's Try again, or a network change.
  const opened = useRef(false);
  // The Mac last signed in to or paired, whether a sign-in is running, whether a Mac or the list is shown, and whether
  // the network changed while one ran or nothing was shown: what a network change reaches again, once it can.
  const now = useRef({ mac: null as Mac | null, busy: false, shown: false, again: false });
  now.current.shown = at.at === "mac" || at.at === "macs";
  // Each sign-in's number: only the latest one's result counts.
  const reaching = useRef(0);

  async function reach(mac: Mac) {
    const mine = ++reaching.current;
    now.current = { ...now.current, mac, busy: true, again: false };
    setStatus({ [mac.pk]: "connecting" });
    const r = await signIn(mac);
    if (mine !== reaching.current) return;
    now.current.busy = false;
    // The network changed while this one ran: once more on the network there is now, direct first.
    if (now.current.again && now.current.shown && now.current.mac) return void reach(now.current.mac);
    setStatus({ [mac.pk]: r === "ok" ? "connected" : r });
    if (r !== "ok") return;
    start();
    setAt({ at: "mac", mac });
  }

  async function run(how: { offer: Offer } | { code: string }) {
    const mine = ++attempt.current;
    // This pairing's stream is on the network there is now.
    now.current.again = false;
    setAt({ at: "finishing" });
    const r = await pair(how, (check) => mine === attempt.current && setAt({ at: "finishing", check }));
    if (mine !== attempt.current) return;
    if (r === "cancelled") return setAt(home());
    try {
      if (typeof r === "string") {
        if (r === "updatePhone" || r === "updateMac") setMacs(await Link.macs());
        return setAt({ at: "notice", problem: r, retry: r === "unreachable" ? () => run(how) : undefined });
      }
      setMacs(await Link.macs());
      now.current.mac = r;
      setStatus({ [r.pk]: "connected" });
      start();
      setAt({ at: "connected", mac: r });
    } catch {
      setAt({ at: "notice", problem: "lost" });
    }
  }

  useEffect(() => {
    if (sample) return;
    Link.macs().then((list) => {
      setMacs(list);
      setAt(home(list));
    });
    // Joining Wi-Fi or leaving it: sign in again, the direct path first, so the relay is used only while it must be.
    const path = Link.addListener("path", () => {
      const { mac, busy, shown } = now.current;
      if (mac && shown && !busy) void reach(mac);
      else now.current.again = true;
    });
    const unsubscribe = onClosed(() => {
      stop();
      setStatus((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v === "connected" ? "lost" : v])));
    });
    return () => {
      path.remove();
      unsubscribe();
    };
  }, []);

  // A network change kept while pairing or signing in: acted on once a Mac or the list shows.
  useEffect(() => {
    const { mac, busy, shown, again } = now.current;
    if (mac && shown && again && !busy) void reach(mac);
  }, [at.at]);

  // Once unlocked, sign in to the first Mac (one stream at a time in this step).
  useEffect(() => {
    if (sample || !unlocked || !macs || opened.current) return;
    opened.current = true;
    if (macs.length) void reach(macs[0]);
  }, [unlocked, macs]);

  if (!unlocked) return <Lock onUnlock={() => setUnlocked(true)} />;
  return (
    <>
      <StatusBar style="light" />
      {at.at === "connect" && (
        <Connect
          onBack={macs?.length ? () => setAt({ at: "macs" }) : undefined}
          onScan={() => {
            // Asks for the local network now, while the camera is being aimed, not when the code is read.
            if (!sample) void Link.browse(1000);
            setAt({ at: "scan" });
          }}
          onCode={() => {
            if (!sample) void Link.browse(1000);
            setAt({ at: "code" });
          }}
        />
      )}
      {at.at === "scan" && (
        <Scan
          sample={!!sample}
          onBack={() => setAt(home())}
          onScanned={(url) => {
            const offer = readQr(url);
            offer ? void run({ offer }) : setAt({ at: "notice", problem: "badQr" });
          }}
        />
      )}
      {at.at === "code" && <Code onBack={() => setAt(home())} onCode={(code) => void run({ code })} />}
      {at.at === "finishing" && (
        <Finishing
          check={at.check}
          onCancel={() => {
            attempt.current++;
            close();
            setAt(home());
          }}
        />
      )}
      {at.at === "connected" && (
        <Notice icon={<CheckCircle className="size-icon-lg" />} title={CONNECTION_WORDS.connected} body={`${at.mac.name} is ready on this iPhone.`} action={CONNECTION_WORDS.done} onPress={() => setAt({ at: "mac", mac: at.mac })} />
      )}
      {at.at === "notice" && (
        <Notice
          {...PROBLEMS[at.problem]}
          action={at.retry ? "Try again" : "Back"}
          onPress={at.retry ?? (() => setAt(home()))}
        />
      )}
      {at.at === "macs" && macs && (
        <Macs
          macs={macs}
          status={status}
          onConnect={(mac) => (status[mac.pk] === "connected" ? setAt({ at: "mac", mac }) : void reach(mac))}
          onAdd={() => setAt({ at: "connect" })}
          onForget={async (mac) => {
            if (status[mac.pk] === "connected" || status[mac.pk] === "connecting") close();
            if (now.current.mac?.pk === mac.pk) now.current.mac = null;
            await Link.forget(mac.pk);
            const list = await Link.macs();
            setMacs(list);
            setStatus({});
            setAt(home(list));
          }}
        />
      )}
      {at.at === "mac" && <MacScreens name={at.mac.name} onMacs={() => setAt({ at: "macs" })} open={sample === "thread" || sample === "samples" ? sample : sample === "markdown" ? "thread" : sample?.startsWith("start") ? "start" : powers || composerSample || SHEETS.includes(sample!) ? "thread" : undefined} />}
      {sample && POWER_SHEETS[sample] && <Confirm {...POWER_SHEETS[sample]} onDone={() => {}} />}
      {sample === "act" && (
        <Confirm
          title="Run this on your Mac?"
          body="It runs in the session's checkout with your Mac's permissions."
          shown={'npm test -- --watch=false && rm -rf "build/tmp"'}
          args={[]}
          onDone={() => {}}
        />
      )}
    </>
  );
}
