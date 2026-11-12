// Send feedback, every screen of the old app's flow [D353, D2100]: the note, signing in to GitHub, writing up and
// filing, sent, partly sent, failed and opened in the browser. Fixed states; the live flow runs in the app.
import { Dialog, DialogContent } from "../src/components/dialog";
import { FEEDBACK_FRAME, FeedbackView } from "../src/feedback/dialog";
import type { Account, Report, Result, Sending } from "../src/feedback/state";
import { Held, Row, Section, State } from "./parts";

const NOTE =
  "The usage popover keeps the old numbers after a session ends, until I restart. Stop on a worker doesn't stop it either, it carries on writing files. And could I pin a session to the top of the sidebar?";
const URL = "https://github.com/syncra-studio/brigadier/issues";
const ME: Account = { signedIn: true, login: "you" };
const OUT: Account = { signedIn: false, login: null };
const CODE = { step: "code" as const, code: "WDJB-MJHT", url: "https://github.com/login/device" };
const report = (kind: Report["kind"], title: string): Report => ({ kind, title });
const SENT: Result[] = [
  { kind: "bug", title: "Usage popover doesn't refresh when a session ends", outcome: "filed", number: 482, url: `${URL}/482` },
  { kind: "bug", title: "Stop doesn't stop a running worker", outcome: "added", number: 417, url: `${URL}/417` },
  { kind: "idea", title: "Pin a session to the top of the sidebar", outcome: "filed", number: 483, url: `${URL}/483` },
];
const PARTLY: Result[] = [SENT[0]!, { kind: "idea", title: "Pin a session to the top of the sidebar", outcome: "failed", reason: "HTTP 502", report: report("idea", "Pin") }];

function Screen({ label, sending, account = ME, text = NOTE }: { label: string; sending: Sending; account?: Account | null; text?: string }) {
  return (
    <State label={label}>
      <Held className="h-120 w-160 overflow-hidden rounded-surface">
        {(box) => (
          <Dialog open modal={false}>
            <DialogContent container={box} initialFocus={false} frame={FEEDBACK_FRAME} showCloseButton={false}>
              <FeedbackView text={text} sending={sending} account={account} onText={() => {}} onSend={() => {}} onOpenSignIn={() => {}} />
            </DialogContent>
          </Dialog>
        )}
      </Held>
    </State>
  );
}

export function FeedbackGallery() {
  return (
    <Section title="Send feedback">
      <Row name="the note · empty, signed out · signed in · who it posts as not known yet">
        <Screen label="signed out" sending={{ phase: "write" }} account={OUT} text="" />
        <Screen label="signed in" sending={{ phase: "write" }} />
        <Screen label="account loading" sending={{ phase: "write" }} account={null} />
      </Row>
      <Row name="sign in to GitHub · starting · code · waiting · no GitHub CLI">
        <Screen label="starting" sending={{ phase: "signIn", signIn: { step: "starting" }, results: null }} account={OUT} />
        <Screen label="code" sending={{ phase: "signIn", signIn: { ...CODE, opened: false }, results: null }} account={OUT} />
        <Screen label="waiting" sending={{ phase: "signIn", signIn: { ...CODE, opened: true }, results: null }} account={OUT} />
        <Screen label="no GitHub CLI" sending={{ phase: "signIn", signIn: { step: "noGh" }, results: null }} account={OUT} />
      </Row>
      <Row name="at work · writing up · filing">
        <Screen label="writing up" sending={{ phase: "working", step: { step: "writing" } }} />
        <Screen label="filing" sending={{ phase: "working", step: { step: "filing", count: 3 } }} />
      </Row>
      <Row name="ended · sent · partly sent · failed · sign-in refused · opened in the browser">
        <Screen label="sent" sending={{ phase: "done", results: SENT }} />
        <Screen label="partly sent" sending={{ phase: "done", results: PARTLY }} />
        <Screen label="failed" sending={{ phase: "failed", error: "Couldn’t send it: GitHub didn't take it: HTTP 502: Bad gateway.", results: null }} />
        <Screen label="sign-in refused" sending={{ phase: "failed", error: "Signing in to GitHub didn’t finish. Try again.", results: null }} account={OUT} />
        <Screen label="opened in the browser" sending={{ phase: "done", results: [{ kind: "bug", title: "The usage popover keeps the old numbers", outcome: "opened" }] }} account={OUT} />
      </Row>
    </Section>
  );
}
