// Study only (D466): every line, error and status a studied thread shows, beside ours.
import { Button } from "../src/components/button";
import { CompactionDivider, NoticeRow, SwitchDivider } from "../src/components/thread/cards";
import { WorkHeader, WorkingLine } from "../src/components/thread/work";
import { ExclamationMarkCircle, Globe, Regenerate, ShieldExclamation, Sparkle, Stop, TextShorterConcise, Warning } from "../src/icons";
import type { Item, Turn } from "../src/thread/item";
import { Banner, Caption, Divider, Inline, Kind, Note, Status } from "./study-parts";

type Switch = Extract<Item, { kind: "switch" }>;
const sw = (more: Partial<Switch>): Switch => ({
  id: "sw",
  turnId: "t",
  kind: "switch",
  state: "limit",
  reason: "usage-limit",
  from: null,
  to: null,
  handoff: false,
  automatic: false,
  text: "",
  ...more,
});
const link = (text: string) => (
  <Button variant="link-blue" size={null}>
    {text}
  </Button>
);
const turn = (status: Turn["status"]): Turn => ({ id: "t", status, startedAt: 0, endedAt: 62_000 });
const noop = () => {};

const MODEL_TIP = (
  <>
    Changing models mid-conversation will degrade performance.
    <br />
    Context may automatically compact.
  </>
);

export function StudyThreadKinds() {
  return (
    <>
      <h4 className="text-sm font-semibold">In the thread · dividers</h4>
      <Kind name="Usage limits reset" where="In the thread, a divider where a usage-limit reset was applied. Words only, no time, no icon.">
        <Divider>Usage limits reset</Divider>
      </Kind>
      <Kind
        name="Model changed"
        where="In the thread, a divider before the next turn when the user picks another model. Icon, then an ⓘ whose tip warns."
        ours={<SwitchDivider change={sw({ state: "switched", reason: "picked", to: "Work (fake)", model: "fake-coder" })} />}
      >
        <Divider icon={Sparkle} tip={MODEL_TIP}>
          Model changed from Model A to Model B.
        </Divider>
      </Kind>
      <Kind name="Request rerouted" where="In the thread, a divider when the service sent a request to another model (safety reroute). ⓘ explains and links to a review.">
        <Divider icon={Sparkle} tip="Heads up, your request was re-routed. Think this is a mistake? Request a review.">
          Your request was routed to Model B.
        </Divider>
      </Kind>
      <Kind
        name="Model retired / retiring"
        where="In the thread, a divider after the conversation moved off a retired model by itself. (Before that, a banner above the composer warns: see below.)"
      >
        <Divider>Model A was retired. This conversation now uses Model B</Divider>
        <Divider>Model A is retiring. This conversation now uses Model B</Divider>
      </Kind>
      <Kind
        name="Context compacted"
        where="In the thread, a divider. While running it shimmers; after 10 seconds it adds “· This can take a few minutes”. Manual and automatic read differently; an interrupted one says so."
        ours={
          <>
            <CompactionDivider progress="running" />
            <CompactionDivider progress="done" />
            <CompactionDivider progress="failed" />
          </>
        }
      >
        <Divider icon={TextShorterConcise} live>
          Compacting context
        </Divider>
        <Divider icon={TextShorterConcise} live>
          Compacting context · This can take a few minutes
        </Divider>
        <Divider icon={TextShorterConcise}>Context automatically compacted</Divider>
        <Divider icon={TextShorterConcise}>Context compacted</Divider>
        <Divider icon={TextShorterConcise}>Compaction interrupted</Divider>
      </Kind>
      <Kind
        name="You stopped"
        where="In the thread, a divider where the user stopped a turn, with how long it ran when known."
        ours={<WorkHeader turn={turn("cancelled")} work={undefined} open={null} onToggle={noop} />}
      >
        <Divider icon={Stop}>You stopped after 1m 2s</Divider>
        <Divider icon={Stop}>You stopped</Divider>
      </Kind>
      <Kind name="Turn ended by automatic review" where="In the thread, a divider when the auto-reviewer stopped a turn after repeated denials. ⓘ says what to do next.">
        <Divider icon={ShieldExclamation} tip="Auto-review stopped this turn after repeated denials. Add more context or choose a different permission mode to continue.">
          Turn ended by Auto-review
        </Divider>
      </Kind>
      <Kind
        name="Continued from another chat"
        where="In the thread, a divider at the top of a chat forked or continued from another; plain chat links the source's title."
        ours={<SwitchDivider change={sw({ state: "switched", reason: "unresumable", from: "Work (fake)", to: "OpenCode", handoff: true })} />}
      >
        <Divider>Continued from chat</Divider>
        <Divider>
          Continued from <span className="text-link">Fix the flaky login test</span>
        </Divider>
      </Kind>
      <Kind name="Personality switched" where="In the thread, a divider when the assistant's personality setting changes.">
        <Divider>Switched to Friendly personality</Divider>
      </Kind>

      <h4 className="text-sm font-semibold">In the thread · statuses and errors</h4>
      <Kind
        name="Usage limit hit"
        where="In the thread, where the turn stopped: the divider's rules around an icon and a sentence that wraps. Info, not an error. Its words pick by plan and whether the reset time is known; no button in the thread."
        ours={
          <>
            <SwitchDivider change={sw({})} from="this computer's login (fake)" actions={link("Switch to Work (fake)")} />
            <SwitchDivider change={sw({ state: "over" })} from="this computer's login (fake)" />
          </>
        }
      >
        <Inline icon={Warning}>You've hit your usage limit. Try again at 9:39 PM.</Inline>
        <Inline icon={Warning}>You've hit your usage limit. Upgrade your plan or add credits to continue, or try again later.</Inline>
        <Inline icon={Warning}>You've hit your usage limit. Contact your workspace owner for more access.</Inline>
      </Kind>
      <Kind name="Image creation limit" where="In the thread, the same shape as the usage limit, for image generation.">
        <Inline icon={Warning}>You’ve reached your image creation limit. Try again at 9:39 PM</Inline>
      </Kind>
      <Kind
        name="Reconnecting the reply"
        where="In the reply's place, a quiet line while the stream reconnects: attempt over maximum, the number rolling. Busy server reads differently. Opens to the error's words."
        ours={
          <>
            <WorkingLine state="disconnected">Unknown · last seen working 12s ago</WorkingLine>
            <WorkingLine state="stalled">No word from the agent for 2m</WorkingLine>
          </>
        }
      >
        <Status>Reconnecting 2/5</Status>
        <Status>Server is busy, reconnecting 3/5</Status>
      </Kind>
      <Kind
        name="Turn failed"
        where="In the thread, a round card with an alert icon and the error's own words (links in it work). Inside an opened work group it is a plain row with the icon instead."
        ours={<NoticeRow level="error" text="The agent stopped: its process exited (code 1)." />}
      >
        <Banner icon={ExclamationMarkCircle}>stream disconnected before completion: error sending request for url (https://example.invalid/v1/responses)</Banner>
        <Caption>inside an opened work group</Caption>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ExclamationMarkCircle className="size-icon-sm shrink-0" />
          Agent disconnected
        </p>
      </Kind>
      <Kind
        name="Server at capacity"
        where="In the thread, the turn-error card with Retry. Retry counts down (10s, 30s, 2m, 5m as failures repeat), a fill growing across the button, then retries by itself."
        ours={<Note>A failed turn is a red notice line; nothing retries it.</Note>}
      >
        <Banner
          icon={ExclamationMarkCircle}
          actions={
            <Button variant="outline" size="sm" className="relative overflow-hidden">
              <span aria-hidden className="absolute inset-y-0 start-0 w-1/3 bg-fill" />
              <span className="relative tabular-nums">Retry in 7s</span>
            </Button>
          }
        >
          The server is overloaded (example: the card shows the error's own words).
        </Banner>
        <Banner
          icon={ExclamationMarkCircle}
          actions={
            <Button variant="outline" size="sm">
              Retry
            </Button>
          }
        >
          The server is overloaded (example: the card shows the error's own words).
        </Banner>
      </Kind>
      <Kind
        name="Model not available"
        where="In the thread, the turn-error card when the provider rejects the chosen model, with a button that opens the model list."
        ours={<NoticeRow level="error" text="model not found: fake-coder" />}
      >
        <Banner
          icon={ExclamationMarkCircle}
          actions={
            <Button variant="outline" size="sm">
              Choose another model
            </Button>
          }
        >
          This model isn’t available
        </Banner>
      </Kind>
      <Kind name="Attachment too large to send" where="In the thread, the turn-error card naming the size and the limit.">
        <Banner icon={ExclamationMarkCircle}>This audio clip is too large to send (about 31.2 MiB). Trim or compress it to under 25.0 MiB and try again.</Banner>
      </Kind>
      <Kind name="A turn couldn't render" where="In the turn's place when drawing it throws: a small bordered card, a title, Try again (draws it again). See “Error card when a reply can't be shown” below.">
        <Note>Shown in the error-card section below.</Note>
      </Kind>
      <Kind name="Extra safety checks" where="In the thread, a status line while actions get extra safety review that may slow the answer.">
        <Status live>This request requires additional safety checks, which can take extra time.</Status>
      </Kind>
      <Kind name="Denied actions" where="Beside “Worked for”, a count of actions the auto-reviewer denied; its tip opens them. Each denial row says why and what approving allows.">
        <p className="flex items-center gap-1.5 border-b border-divider pb-2 text-sm text-faint-foreground">
          Worked for 1m 2s <span>·</span> <span className="text-warning">2 denied actions</span>
        </p>
      </Kind>
      <Kind name="Chat paused / ended for safety" where="In the thread: paused until the user reviews what was flagged (a dialog with a checkbox to continue), or ended for good with Start new chat.">
        <Banner icon={ShieldExclamation} title="Chat paused as a precaution" actions={<Button size="sm">Review findings</Button>}>
          The assistant couldn't confirm the agent was interpreting your instructions correctly. To continue, review what was flagged.
        </Banner>
        <Banner icon={ShieldExclamation} title="Chat ended as a precaution" actions={<Button size="sm">Start new chat</Button>}>
          The assistant couldn't confirm the agent was interpreting your instructions correctly. To continue, start a new chat.
        </Banner>
      </Kind>
      <Kind name="Setting up the workspace" where="In the reply's place before it starts, while local tools download: a percentage, then preparing, then finalizing.">
        <Status live>Setting up your workspace: 42%</Status>
        <Status live>Preparing your workspace</Status>
      </Kind>
      <Kind name="Scheduled runs with nothing to say" where="In a scheduled task's chat, the end of a run that had no update.">
        <Status>No update from this run</Status>
        <Status>Heartbeat completed quietly</Status>
      </Kind>
      <Kind name="Fork set up only partly" where="In the new chat, a warning that it exists but its setup didn't finish, with the error.">
        <Banner icon={Warning}>Chat 7f3a was created, but its setup did not finish: the worktree could not be created</Banner>
      </Kind>
      <Kind name="Task sent to the cloud" where="In the thread, a line with a link when a chat hands work to a cloud task. Not an error; listed so the catalogue is whole.">
        <Status>
          <Globe className="me-1.5 inline size-icon-sm" />
          Created <span className="text-link">chat</span> in the cloud
        </Status>
      </Kind>
      <Kind name="Retry replaces the attempt" where="A confirm dialog before retrying a turn that already acted: retrying replaces the attempt but file changes stay.">
        <Note>
          <Regenerate className="me-1.5 inline size-icon-sm" />
          “This will replace the current attempt in the conversation. Any file changes or other actions already taken will remain.”
        </Note>
      </Kind>
    </>
  );
}
