// Study only (D466): the notices above the composer, the whole-chat states, toasts, and where plain chat
// differs from Codex mode, beside ours.
import { Button } from "../src/components/button";
import { ComposerRail, Notices } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { NoticeRow, SwitchDivider } from "../src/components/thread/cards";
import { UserBubble } from "../src/components/thread/message";
import { WorkingLine } from "../src/components/thread/work";
import { Archive, Desktop, ExclamationMarkCircle, Info, ShieldExclamation, Spinner, Warning, X } from "../src/icons";
import { AboveComposer, Callout, Caption, Divider, Kind, Note, Page, Status, Tip, Toast } from "./study-parts";

const noop = () => {};
const retry = (
  <Button variant="link-blue" size="xs" className="-my-0.5">
    Retry
  </Button>
);
const dismiss = (
  <Button variant="ghost" size="icon-xs" aria-label="Dismiss" className="ms-auto text-muted-foreground">
    <X />
  </Button>
);
/** Our rail with one notice, as the composer shows it. */
const rail = (level: "info" | "warning" | "error", text: string, action?: typeof retry) => (
  <ComposerRail>
    <Notices notices={[{ id: 0, level, text, action }]} onDismiss={noop} />
  </ComposerRail>
);

export function StudyAroundKinds() {
  return (
    <>
      <h4 className="text-sm font-semibold">Above the composer</h4>
      <Kind
        name="Reconnecting to the app server"
        where="Above the composer while the app reconnects to its local agent server."
        ours={
          <>
            <SendButton empty={false} running={false} canStop={false} onSend={noop} onStop={noop} keys={false} blocked="Reconnecting…" />
            <Note>Send is disabled with “Reconnecting…” as its tip; the tab bar says “Reconnecting…” too.</Note>
          </>
        }
      >
        <AboveComposer>
          <Spinner className="size-icon-sm motion-safe:animate-spin" />
          <span className="shimmer">Reconnecting…</span>
        </AboveComposer>
      </Kind>
      <Kind name="Remote machine connection" where="Above the composer for a chat on a remote machine over SSH: connecting, lost and reconnecting (warning), could not reconnect (warning).">
        <AboveComposer>
          <span className="shimmer">Connecting to devbox…</span>
        </AboveComposer>
        <AboveComposer>
          <Warning className="size-icon-sm text-warning" />
          Connection to devbox was lost. Reconnecting…
        </AboveComposer>
        <AboveComposer>
          <Warning className="size-icon-sm text-warning" />
          Couldn’t reconnect to devbox
        </AboveComposer>
      </Kind>
      <Kind name="Model retiring" where="Above the composer while the chat's model nears retirement, dismissable; after the date the title says it was retired. A variant introduces the replacement.">
        <AboveComposer>
          <Warning className="size-icon-sm text-warning" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">Model A retires on Dec 1</span>
            <br />
            <span className="text-muted-foreground">This conversation will automatically switch to Model B</span>
          </span>
          {dismiss}
        </AboveComposer>
        <AboveComposer>
          <Warning className="size-icon-sm text-warning" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">Model A was retired</span>
            <br />
            <span className="text-muted-foreground">This conversation will automatically switch to Model B</span>
          </span>
          {dismiss}
        </AboveComposer>
      </Kind>
      <Kind
        name="Full access is on"
        where="Above the composer while the most open permission level is picked: title, the risk in one line, a link to learn more."
        ours={<Note>Full access asks once through the kit's confirm dialog [D189]; nothing stays above the composer.</Note>}
      >
        <AboveComposer>
          <Warning className="size-icon-sm text-warning" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">Full access is on</span>
            <br />
            <span className="text-muted-foreground">
              The agent can edit any file and run commands with internet access without your approval. <span className="text-link">Learn more</span>
            </span>
          </span>
        </AboveComposer>
      </Kind>
      <Kind name="Thread goal" where="Above the composer, a goal the agent pursues across turns, with its state: pursuing, paused, stalled, limited by budget or usage, achieved.">
        <AboveComposer>
          <span className="shimmer">Pursuing goal</span>
          <span className="text-muted-foreground">· Make the login test pass</span>
        </AboveComposer>
        <Caption>also: Paused goal · Goal stalled · Goal limited · Goal usage limited · Goal achieved</Caption>
      </Kind>

      <h4 className="text-sm font-semibold">Instead of the thread</h4>
      <Kind name="Couldn't load messages" where="In the thread's place when loading the history fails, with Retry." ours={rail("warning", "Couldn’t load messages", retry)}>
        <Page icon={ExclamationMarkCircle} title="Couldn't load messages" actions={<Button variant="outline" size="sm">Retry</Button>} />
      </Kind>
      <Kind name="Chat unavailable" where="In the thread's place when the chat can't be found or opened; a shared task gets Retry.">
        <Page title="Chat unavailable" />
        <Page title="Task unavailable" actions={<Button variant="outline" size="sm">Retry</Button>} />
      </Kind>
      <Kind
        name="Chat is archived"
        where="In the thread's place for an archived chat: Unarchive and open, then “Restoring this chat and its workspace…”, then “This chat has been restored”, or an error."
        ours={<Note>An archived session opens from Archive; restoring it says so in a toast.</Note>}
      >
        <Page icon={Archive} title="This chat is archived" detail="Unarchive this chat to open it" actions={<Button size="sm">Unarchive and open</Button>} />
      </Kind>
      <Kind name="Open in another app" where="In the thread's place when another app is writing to the same chat: Retry once it's closed there, or fork a copy.">
        <Page
          icon={Desktop}
          title="This is open in another app"
          detail="Close it there to continue here."
          actions={
            <>
              <Button variant="outline" size="sm">
                Retry
              </Button>
              <Button size="sm">Fork chat</Button>
            </>
          }
        />
      </Kind>
      <Kind name="Remote connection removed" where="In the thread's place when the chat's remote machine is no longer configured.">
        <Page title="Remote connection unavailable" detail="This chat's remote connection is no longer configured. Add it again in Settings to continue" actions={<Button size="sm">Open connection settings</Button>} />
      </Kind>
      <Kind name="Cloud environment gone" where="In the thread's place for a cloud chat whose environment was deleted, or can't be reached.">
        <Page title="Environment deleted" />
        <Page title="Environment unavailable" />
      </Kind>
      <Kind
        name="Starting a new chat"
        where="In the new chat's place: starting; not yet confirmed (with a warning not to send again); could not start, with Try again, Go back, Close."
        ours={<UserBubble keep="cg-unconfirmed" text="Fix the flaky login test" unconfirmed />}
      >
        <Status live>Starting your chat</Status>
        <Status>Chat creation is not yet confirmed. Do not submit it again while its outcome is being checked</Status>
        <Page
          title="Could not start this chat"
          actions={
            <>
              <Button variant="outline" size="sm">
                Go back
              </Button>
              <Button size="sm">Try again</Button>
            </>
          }
        />
      </Kind>
      <Kind name="Toasts about the chat" where="A toast, not in the thread: editing the last message failed; deleting a chat and its side chats only partly worked; unarchive failed.">
        <Toast>Failed to edit message</Toast>
        <Toast>Couldn’t finish deleting the chat. Some attached side chats may already be deleted, and others may remain. Try again.</Toast>
      </Kind>

      <h4 className="text-sm font-semibold">Plain chat, where it differs</h4>
      <Kind
        name="Answer failed"
        where="Under the user's message, a red-washed callout with one button: Retry; Use default model after a model's own limit; Start new chat when the chat is gone or too large. A Work follow-up with no answer, or not confirmed, reads differently."
        ours={
          <>
            <UserBubble keep="cg-failed" text="Fix the flaky login test" failed="the agent isn't running" onRetry={noop} onDiscard={noop} />
            <NoticeRow level="error" text="The agent stopped: its process exited (code 1)." />
          </>
        }
      >
        <Callout action="Retry">Something went wrong. Please try again</Callout>
        <Callout action="Use default model">You've reached the limit for this model.</Callout>
        <Callout action="Start new chat">This conversation is too large to continue.</Callout>
        <Callout action="Retry">Your follow-up didn’t receive a response. Please try again</Callout>
        <Callout action="Retry">We couldn’t confirm your follow-up. Retry to send it again</Callout>
      </Kind>
      <Kind name="Couldn't send" where="Under the message when sending fails before anything streams." ours={<UserBubble keep="cg-notsent" text="Fix the flaky login test" failed="Brigadier isn't running" onRetry={noop} onDiscard={noop} />}>
        <Callout action="Retry">Could not send this message</Callout>
      </Kind>
      <Kind
        name="Connection dropped mid-answer"
        where="Under the streaming answer, a calm line while it falls back to waiting for the whole answer; if that times out, the red callout."
        ours={<WorkingLine state="disconnected">Unknown · last seen working 12s ago</WorkingLine>}
      >
        <Status>Connection interrupted. Waiting for the complete answer</Status>
        <Callout action="Retry">Message delivery timed out. Please try again.</Callout>
      </Kind>
      <Kind
        name="Out of messages"
        where="Above the composer, a banner that blocks sending until the reset, dismissable for that window, its button by plan (upgrade, add credits, ask an admin, new chat). The first time, a dialog explains the plan."
        ours={<SwitchDivider change={{ id: "s", turnId: "t", kind: "switch", state: "limit", reason: "usage-limit", handoff: false, automatic: false, text: "" }} from="this computer's login (fake)" actions={<Button variant="link-blue" size={null}>Switch to Work (fake)</Button>} />}
      >
        <AboveComposer>
          <Info className="size-icon-sm text-muted-foreground" />
          <span className="min-w-0 flex-1">You’ve reached your limit. Try again at 9:39 PM.</span>
          <Button size="xs">New chat</Button>
          <Button variant="ghost" size="xs">
            Dismiss
          </Button>
        </AboveComposer>
        <Caption>first time: a dialog</Caption>
        <Page title="You’re out of messages with advanced intelligence" detail="Keep chatting with less detail and precision until usage resets at 9:39 PM, or upgrade for expanded access." actions={<Button variant="outline" size="sm">Continue with less intelligence</Button>} />
      </Kind>
      <Kind name="Attachment limits" where="Above the composer, dismissable: too many files, a file too large, or the daily attachment limit with its reset." ours={rail("error", "Upload failed: report.pdf is too large")}>
        <AboveComposer>
          <span className="min-w-0 flex-1">
            <span className="font-medium">You can attach up to 10 files per message</span>
            <br />
            <span className="text-muted-foreground">Try attaching fewer files</span>
          </span>
          {dismiss}
        </AboveComposer>
      </Kind>
      <Kind name="Content flagged or blocked" where="Under or in place of a message: flagged (may violate the usage policies), blocked for safety, a chat closed for it. Each links to the policy; thumbs-down to report a mistake.">
        <p className="text-xs text-muted-foreground">
          This content may violate our <span className="text-link">usage policies</span>
        </p>
        <Callout>This content can’t be shown for safety reasons</Callout>
        <Divider icon={ShieldExclamation}>
          This chat may violate our usage policies and has been closed. <span className="text-link">Start a new chat</span>.
        </Divider>
      </Kind>
      <Kind name="Lockdown mode" where="A label above the composer while a per-chat restriction on web and tools is on.">
        <AboveComposer>
          <ShieldExclamation className="size-icon-sm text-muted-foreground" />
          Lockdown mode
          <Tip text="Lockdown mode limits features that can connect to the web, external services, or custom tools." />
        </AboveComposer>
      </Kind>
      <Kind name="Message too long" where="The tip on the disabled send button while the draft is over the model's length." ours={<Note>Our send button can carry the same tip; nothing checks length today.</Note>}>
        <SendButton empty={false} running={false} canStop={false} onSend={noop} onStop={noop} keys={false} blocked="Message is too long" />
      </Kind>
    </>
  );
}
