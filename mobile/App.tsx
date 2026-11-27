import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import Link, { type Mac } from "./modules/link";
import { close, onClosed } from "./src/link";
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
  | { at: "connected"; name: string }
  | { at: "notice"; problem: Problem; retry?: () => void };

// `-screen <name>` opens one screen with sample data and no network, for simulator screenshots (no Face ID there).
const sample = Link.screen;
const SAMPLE_MAC: Mac = { pk: "sample", name: "MacBook Pro", device: "", addresses: [] };
function sampleAt(): At {
  if (sample === "finishing") return { at: "finishing", check: "042917" };
  if (sample === "connected") return { at: "connected", name: SAMPLE_MAC.name };
  if (sample?.startsWith("notice-")) return { at: "notice", problem: sample.slice(7) as Problem };
  if (sample === "scan" || sample === "code" || sample === "macs") return { at: sample };
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

  async function reach(mac: Mac) {
    setStatus({ [mac.pk]: "connecting" });
    const r = await signIn(mac);
    setStatus({ [mac.pk]: r === "ok" ? "connected" : r });
  }

  async function run(how: { offer: Offer } | { code: string }) {
    const mine = ++attempt.current;
    setAt({ at: "finishing" });
    const r = await pair(how, (check) => mine === attempt.current && setAt({ at: "finishing", check }));
    if (mine !== attempt.current) return;
    if (r === "cancelled") return setAt(home());
    if (typeof r === "string") {
      if (r === "updatePhone" || r === "updateMac") setMacs(await Link.macs());
      return setAt({ at: "notice", problem: r, retry: r === "unreachable" ? () => run(how) : undefined });
    }
    setMacs(await Link.macs());
    setStatus({ [r.pk]: "connected" });
    setAt({ at: "connected", name: r.name });
  }

  useEffect(() => {
    if (sample) return;
    Link.macs().then((list) => {
      setMacs(list);
      setAt(home(list));
    });
    return onClosed(() => setStatus((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v === "connected" ? "lost" : v]))));
  }, []);

  // Once unlocked, sign in to the first Mac (one stream at a time in this step).
  useEffect(() => {
    if (!sample && unlocked && macs?.length && !status[macs[0].pk]) void reach(macs[0]);
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
        <Notice title="You're connected" body={`${at.name} is ready on this iPhone.`} action="Done" onPress={() => setAt({ at: "macs" })} />
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
          onConnect={(mac) => void reach(mac)}
          onAdd={() => setAt({ at: "connect" })}
          onForget={async (mac) => {
            if (status[mac.pk] === "connected" || status[mac.pk] === "connecting") close();
            await Link.forget(mac.pk);
            const list = await Link.macs();
            setMacs(list);
            setStatus({});
            setAt(home(list));
          }}
        />
      )}
    </>
  );
}
