// A question waiting for the user: numbered answers and a field for their own words, a round one at a time.
import { type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { matches } from "../../shortcuts";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { viewImage } from "../image-viewer";
import { ActionCard, ActionCardQuestion, ActionFreeText, ActionOption, actionButton, CodeSpans, cardKey, DismissButton, forgetCards, inField, StepCounter, staggered, useCardKeys } from "./decision-parts";
import { openChip } from "../../session/commands";
import type { Runner } from "../../session/composer";
import { dropTiles, forgetTiles, useComposerFiles } from "../../session/files";
import { type Draft, isEmpty, plainText } from "./draft";
import { type ComposerFieldHandle, ComposerField } from "./field";

/** One question of a round, as Rust sends it (msgs/w18-fields-4.md, boss D177). Its text passes as is. */
export type QuestionItem = {
  text: string;
  /** None: the field alone. */
  options: { label: string; description?: string | null; letter?: string; name?: string; shot?: string | null }[];
  recommended: number | null;
  /** Several marked and sent together, their labels joined with ", ". */
  multiSelect: boolean;
};

export type PendingQuestion = {
  id: string;
  /** A few words over the question (a round's title). */
  title?: string | null;
  items: QuestionItem[];
  /** A worker's routing hold: only its own answers, no words of the user's and no Skip [D2028, D342]. */
  held?: boolean;
  /** A mockup's round: each answer's `letter` is its variant, `shot` its picture then. */
  mockup?: { worker: string; round: number; title: string };
};

/** One answer: an option's label or the user's words, those with images or files as their draft; null for a skipped one. */
export type Given = string | Draft | null;

/** What goes under the card; a function's can send the round as it stands, what's open skipped: whether it was taken. `waits` says why it can't yet. */
export type Footer = ReactNode | ((round: { finish: () => Promise<boolean>; waits?: string; busy: boolean }) => ReactNode);

/** How long a picked answer shows its dot before it goes: time for a double-click's second click to call it off. */
const COMMIT_MS = 300;
/** How far a press moves before it's a drag, not a click. */
const DRAG_PX = 4;

/** Where the user is on a card: an answer per question (undefined still open, null skipped), the draft typed (its tiles with the files), the lit and marked answers. */
type Kept = {
  page: number;
  answers: readonly (Given | undefined)[];
  drafts: readonly (Draft["parts"] | undefined)[];
  lit: readonly (number | null | undefined)[];
  marked: readonly (readonly number[] | undefined)[];
};
const FRESH: Kept = { page: 0, answers: [], drafts: [], lit: [], marked: [] };

// Kept by session and card id outside the card: putting it aside or a visit to Settings unmounts it, and coming back
// finds it as it was. Dropped once answered, or by `forgetQuestions`.
const keptCards = new Map<string, Kept>();
/** Drops the session's kept cards for questions no longer waiting. */
export const forgetQuestions = (session: string, keep: ReadonlySet<string>) => {
  forgetCards(keptCards, session, keep);
  forgetTiles(session, keep);
};
const tilesKey = (card: string, at: number) => `${card}\n${at}`;

function useKeptQuestion(id: string) {
  const [kept, setKept] = useState(() => keptCards.get(id) ?? FRESH);
  const keep = (change: (now: Kept) => Partial<Kept>) => {
    const now = keptCards.get(id) ?? FRESH;
    const next = { ...now, ...change(now) };
    keptCards.set(id, next);
    setKept(next);
  };
  return [kept, keep] as const;
}

const put = <T,>(list: readonly T[], at: number, value: T): T[] => {
  const next = [...list];
  next[at] = value;
  return next;
};

/**
 * A question card: its round one question at a time with "‹ 1 of 3 ›", every answer sent together after the
 * last (`onAnswer`, null for a skipped one). Skip leaves a question to the asker's judgment; ✕ skips all still
 * open; Esc puts the card aside (`onDismiss`). While the answers go the card waits; a refusal shows on it.
 */
export function QuestionCard({
  question,
  onAnswer,
  onDismiss,
  footer,
  actions,
  stagger = false,
  error: refused = null,
  session,
  dismiss,
  ...files
}: {
  question: PendingQuestion;
  onAnswer: (answers: Given[]) => Promise<void>;
  onDismiss: () => void;
  footer?: Footer;
  /** At the question's end: what opens what it asks about. */
  actions?: ReactNode;
  /** A refusal that came after the card was hidden at once, so it shows when the card comes back. */
  error?: string | null;
  /** It follows another card: its rows fade in one after another. */
  stagger?: boolean;
  /** Whose question it is: what keeps one session's answers and drafts from another's, and where its files go. */
  session: string;
  run: Runner;
  /** Who takes the answer's images, whether its model can. */
  backend?: string;
  images?: boolean;
  /** Nothing waits on it any more: Dismiss beside its error puts it away. */
  dismiss?: () => void;
}) {
  const { id, items } = question;
  const key = cardKey(session, id);
  const [{ page, answers, drafts, lit, marked }, keep] = useKeptQuestion(key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = Math.min(page, items.length - 1);
  const item = items[at];
  if (!item) return null;

  const send = async (all: Given[]): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    return onAnswer(all)
      .then(() => {
        keptCards.delete(key);
        items.forEach((_, index) => dropTiles(tilesKey(key, index)));
        return true;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      })
      .finally(() => setBusy(false));
  };
  const answered = answers.filter((given) => given !== undefined).length;
  // Back to any question answered so far, or on to the first one still open.
  const reachable = (to: number) => to >= 0 && to < items.length && to <= answered;
  const answer = (given: Given) => {
    // Its tiles stay with a draft, for paging back or a refusal, and go as its words do with any other answer.
    if (given === null || typeof given === "string") dropTiles(tilesKey(key, at));
    const next = items.map((_, index) => (index === at ? given : answers[index]));
    const open = next.findIndex((each) => each === undefined);
    keep((now) => ({ answers: next, drafts: put(now.drafts, at, undefined), ...(open >= 0 && { page: open }) }));
    if (open < 0) void send(next.map((each) => each ?? null));
  };
  // Marked or typed on a question paged away from, not yet sent.
  // shortcut: files attached to one paged away from aren't in it, only its words and chips; read its tiles here if rounds take files.
  const unsent = (index: number): Given => {
    const parts = drafts[index];
    if (parts && !isEmpty({ parts, attachmentIds: [] })) return parts.some((part) => typeof part !== "string" && "attachmentId" in part) ? { parts, attachmentIds: [] } : plainText(parts).trim();
    return marked[index]?.length ? marked[index].map((one) => items[index]!.options[one]!.label).join(", ") : null;
  };
  const given = answers[at];
  const picked = typeof given === "string" ? item.options.findIndex((option) => option.label === given) : -1;
  const marks = marked[at];
  const own = given && typeof given !== "string" ? given.parts : null;
  const ownWords = typeof given === "string" && picked < 0 && !(item.multiSelect && marks?.map((index) => item.options[index]?.label).join(", ") === given);
  return (
    <QuestionPage
      // Each question of the round starts fresh, but keeps an answer given, or text typed, before paging away.
      key={at}
      title={<CodeSpans text={item.text} />}
      kind={question.title && <CodeSpans text={question.title} />}
      item={item}
      held={question.held === true}
      kept={lit[at] ?? (picked >= 0 ? picked : null)}
      marked={item.multiSelect ? (marks ?? []) : undefined}
      initial={drafts[at] ?? own ?? (ownWords ? [given] : [])}
      files={{ owner: session, draft: tilesKey(key, at), ...files }}
      aside={
        <>
          {items.length > 1 && (
            <StepCounter
              noun="question"
              at={at}
              count={items.length}
              canBack={reachable(at - 1)}
              canForward={reachable(at + 1)}
              onStep={(step) => keep(() => ({ page: at + step }))}
              className="-mt-0.5 h-6"
            />
          )}
          {actions}
        </>
      }
      last={answers.filter((other, index) => index !== at && other !== undefined).length === items.length - 1}
      onPage={(step) => reachable(at + step) && keep(() => ({ page: at + step }))}
      onAnswer={answer}
      onTyped={(parts) => keep((now) => ({ drafts: put(now.drafts, at, parts) }))}
      onLit={(index) => keep((now) => ({ lit: put(now.lit, at, index) }))}
      onMarked={(indexes) => keep((now) => ({ marked: put(now.marked, at, indexes) }))}
      onDismiss={onDismiss}
      // ✕ skips what is still open in the round, so the asker hears and carries on.
      onClose={() => void send(items.map((_, index) => answers[index] ?? null))}
      onFinish={(now) => send(items.map((_, index) => (index === at ? (now ?? answers[index] ?? null) : (answers[index] ?? unsent(index)))))}
      busy={busy}
      error={error ?? refused}
      dismiss={dismiss}
      footer={footer}
      stagger={stagger && at === 0}
    />
  );
}

/**
 * One question: numbered answers (1–9 light one, ↑/↓ move, Enter picks the lit one; a pick shows its dot, then
 * goes), then the field with Skip, which turns into Submit once something is typed (Next before a round's last
 * question; ←/→ page). Enter picks only from the focused card, and nothing is lit until the user moves to an
 * answer: every answer may change code. A click picks; a drag over the words or a double-click selects them.
 * Multi-select: a click or Enter marks or unmarks, and the button sends the marked ones together.
 */
function QuestionPage({
  title,
  kind,
  item,
  held,
  kept,
  marked: keptMarks,
  initial,
  files: filed,
  aside,
  last,
  onPage,
  onAnswer,
  onTyped,
  onLit,
  onMarked,
  onDismiss,
  onClose,
  busy,
  error,
  dismiss,
  footer,
  onFinish,
  stagger,
}: {
  title: ReactNode;
  kind?: ReactNode;
  item: QuestionItem;
  held: boolean;
  kept: number | null;
  /** Multi-select: the answers marked so far. */
  marked?: readonly number[];
  initial: Draft["parts"];
  files: { owner: string; draft: string; run: Runner; backend?: string; images?: boolean };
  aside?: ReactNode;
  last: boolean;
  onPage: (step: -1 | 1) => void;
  onAnswer: (given: Given) => void;
  onTyped: (parts: Draft["parts"]) => void;
  onLit: (index: number | null) => void;
  onMarked: (indexes: number[]) => void;
  onDismiss: () => void;
  onClose: () => void;
  busy: boolean;
  error: string | null;
  dismiss?: () => void;
  footer?: Footer;
  /** Sends the round as it stands, `now` this question's own answer so far. */
  onFinish: (now: Given) => Promise<boolean>;
  stagger: boolean;
}) {
  const { options } = item;
  const multiple = keptMarks !== undefined;
  const pictured = (option: QuestionItem["options"][number]) => [option.letter, option.name].filter(Boolean).join(" · ") || option.label;
  const pictures = options.flatMap((option) => (option.shot ? [{ name: pictured(option), url: option.shot }] : []));
  // The lit answer; -1 is the field, null none yet.
  const [highlight, setHighlight] = useState<number | null>(options.length === 0 ? -1 : kept);
  const lit = useEffectEvent((index: number | null) => onLit(index));
  useEffect(() => lit(highlight), [highlight]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [marked, setMarked] = useState<readonly number[]>(keptMarks ?? []);
  const [typed, setTyped] = useState(initial);
  // One that came while nobody could see the window shows its rows at once.
  const [opens] = useState(() => document.visibilityState === "visible");
  const card = useRef<HTMLElement>(null);
  const field = useRef<ComposerFieldHandle>(null);
  const files = useComposerFiles({ ...filed, field, main: false });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The answer lit before a pick, for a pick taken back.
  const litBefore = useRef(highlight);
  const pressedAt = useRef({ x: 0, y: 0 });
  const pickable = options.length > 0;
  // The card takes focus (the field, when there's nothing to pick), unless the user is typing somewhere.
  useEffect(() => {
    if (inField(document.activeElement)) return;
    if (pickable) card.current?.focus({ preventScroll: true });
    else field.current?.focus();
  }, [pickable]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const idle = !busy && chosen === null;
  const commit = (index: number) => {
    if (!idle || options[index] === undefined) return;
    if (multiple) {
      const next = marked.includes(index) ? marked.filter((other) => other !== index) : [...marked, index].toSorted((a, b) => a - b);
      setMarked(next);
      setHighlight(index);
      onMarked(next);
      return;
    }
    litBefore.current = highlight;
    setChosen(index);
    setHighlight(index);
    timer.current = setTimeout(() => {
      setChosen(null);
      onAnswer(options[index]!.label);
    }, COMMIT_MS);
  };
  // A double-click's second click takes back the pick its first made; a triple-click's third does nothing.
  const clicked = (index: number, event: MouseEvent<HTMLElement>) => {
    if (event.detail >= 3) return;
    if (event.detail === 2 && !multiple) {
      if (chosen === null) return;
      clearTimeout(timer.current);
      setChosen(null);
      setHighlight(litBefore.current);
      return;
    }
    // A drag never picks, even one that selected nothing.
    const dragged = Math.hypot(event.clientX - pressedAt.current.x, event.clientY - pressedAt.current.y) > DRAG_PX;
    const selection = getSelection();
    const selected = !!selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode);
    if (event.detail === 1 && (dragged || selected)) return;
    commit(index);
  };
  const draft = { parts: typed, attachmentIds: files.tiles() };
  const filled = !isEmpty(draft);
  // Something to send: words typed, files attached, or answers marked.
  const ready = filled || marked.length > 0;
  const waits = filled ? files.hold(typed) : undefined;
  const now = (): Given => {
    if (filled) return draft.attachmentIds.length > 0 || typed.some((part) => typeof part !== "string" && "attachmentId" in part) ? draft : plainText(typed).trim();
    return marked.length > 0 ? marked.map((index) => options[index]!.label).join(", ") : null;
  };
  const submit = () => {
    if (!idle || waits) return;
    onAnswer(now());
  };
  // A pick still showing its dot goes with it.
  const finish = () => {
    clearTimeout(timer.current);
    setChosen(null);
    return onFinish(chosen !== null ? options[chosen]!.label : now());
  };
  useCardKeys(
    idle,
    {
      enter: () => {
        if (highlight !== null && highlight >= 0) commit(highlight);
      },
      escape: onDismiss,
    },
    card,
  );
  const onKeyDown = (event: KeyboardEvent) => {
    if (!idle || inField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const digit = matches(event.nativeEvent, "answer") ? Number(event.key) : NaN;
    const lastOption = options.length - 1;
    // With a button of the card focused, focus follows the light, so Enter (which clicks the focused one) picks the lit answer.
    const move = (index: number) => {
      setHighlight(index);
      const answer = card.current?.querySelectorAll<HTMLElement>("[data-slot=action-option]")[index];
      answer?.scrollIntoView({ block: "nearest" });
      if (event.target !== event.currentTarget) answer?.focus();
    };
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(9, options.length)) move(digit - 1);
    else if (digit === options.length + 1 && digit <= 9) field.current?.focus();
    else if (event.key === "ArrowDown") {
      if (highlight === null) move(0);
      else if (highlight >= lastOption) field.current?.focus();
      else move(highlight + 1);
    } else if (event.key === "ArrowUp") {
      if (highlight === null || highlight === -1) move(lastOption);
      else if (highlight > 0) move(highlight - 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") onPage(event.key === "ArrowLeft" ? -1 : 1);
    else return;
    event.preventDefault();
  };

  const onDrop = (event: DragEvent) => {
    files.onDrop(event);
    setHighlight(-1);
  };
  const row = (index: number) => staggered(stagger && opens, index);
  return (
    <ActionCard ref={card} container="request" tabIndex={0} aria-label="Question" data-action="question" onKeyDown={onKeyDown} {...(!held && { onDragOver: files.onDragOver, onDrop })}>
      <div {...row(0)}>
        <ActionCardQuestion onDismiss={held ? undefined : () => idle && onClose()} dismissLabel="Skip" kind={kind} aside={aside}>
          {title}
        </ActionCardQuestion>
      </div>
      <div className="flex flex-col gap-1 px-2 pt-1 pb-2">
        {pickable && (
          <div role={multiple ? "group" : "radiogroup"} aria-label="Answers" className={cx("flex flex-col gap-1", pictures.length > 0 && "max-h-queue-max overflow-y-auto")}>
            {options.map((option, index) => (
              <div key={option.label} {...row(index + 1)} className={cx("flex items-center gap-2", row(index + 1).className)}>
                <ActionOption
                  className="min-w-0"
                  role={multiple ? "checkbox" : "radio"}
                  aria-checked={multiple ? marked.includes(index) : index === highlight}
                  number={index + 1}
                  name={option.label.replaceAll("`", "")}
                  label={<CodeSpans text={option.label} />}
                  description={option.description && <CodeSpans text={option.description} />}
                  recommended={item.recommended === index}
                  highlighted={index === highlight}
                  chosen={index === chosen || (multiple && marked.includes(index))}
                  disabled={busy}
                  onMouseDown={(event) => {
                    pressedAt.current = { x: event.clientX, y: event.clientY };
                  }}
                  onClick={(event) => clicked(index, event)}
                />
                {/* Beside the row, not in it: a click opens it larger and picks nothing. */}
                {option.shot && (
                  <button
                    type="button"
                    aria-label={`View ${pictured(option)} larger`}
                    className="h-16 w-24 shrink-0 cursor-pointer overflow-hidden rounded-control border border-border bg-muted focus-visible:focus-ring"
                    onClick={() => viewImage(pictures, pictures.findIndex((each) => each.url === option.shot))}
                  >
                    <img src={option.shot} alt={pictured(option)} draggable={false} className="size-full object-cover object-top" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {!held && (
          <ActionFreeText
            marker={pickable}
            highlighted={pickable && highlight === -1}
            {...row(options.length + 1)}
            field={
              <div className="min-w-0 flex-1" onFocus={() => setHighlight(-1)}>
                {files.tilesRow}
                <ComposerField
                  ref={field}
                  size="card"
                  label="Your answer"
                  placeholder={pickable ? "No, and tell the agent what to do differently" : "Type here"}
                  initial={{ parts: initial, attachmentIds: [] }}
                  attachments={files.attachments}
                  onAttach={files.attach}
                  onOpen={(kind, id) => openChip(filed.owner, kind, id)}
                  onChange={(parts) => {
                    setTyped(parts);
                    onTyped(parts);
                    if (!isEmpty({ parts, attachmentIds: [] })) setHighlight(-1);
                  }}
                  onSubmit={() => filled && submit()}
                  onEscape={() => card.current?.focus()}
                  // ↑ in the empty field goes back up to the answers.
                  onPullQueued={() => {
                    if (!pickable) return false;
                    setHighlight(options.length - 1);
                    card.current?.focus();
                    return true;
                  }}
                />
              </div>
            }
          >
            <button type="button" className={actionButton(ready ? "primary" : "outline", "font-medium")} disabled={busy || waits !== undefined} title={waits} onClick={submit}>
              {!ready ? "Skip" : last ? "Submit" : "Next"}
            </button>
          </ActionFreeText>
        )}
      </div>
      <ErrorLine error={error} className="px-4 pb-2" actions={dismiss && <DismissButton onClick={dismiss} />} />
      {typeof footer === "function" ? footer({ finish, waits, busy }) : footer}
    </ActionCard>
  );
}
