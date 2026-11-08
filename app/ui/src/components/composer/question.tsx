// A question waiting for the user: numbered answers and a field for their own words, a round one at a time.
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { ErrorLine } from "../error-line";
import { ActionCard, ActionCardQuestion, ActionFreeText, ActionOption, actionButton, CodeSpans, inField, StepCounter, staggered, useCardKeys } from "./decision-parts";
import { plainText } from "./draft";
import { type ComposerFieldHandle, ComposerField } from "./field";

/** One question of a round, as Rust sends it (msgs/w18-fields-4.md, boss D177). Its text passes as is. */
export type QuestionItem = {
  text: string;
  /** None: the field alone. */
  options: { label: string; description?: string | null }[];
  recommended: number | null;
  /** Several marked and sent together, their labels joined with ", ". */
  multiSelect: boolean;
};

export type PendingQuestion = {
  id: string;
  /** A few words over the question (a round's title). */
  title?: string | null;
  items: QuestionItem[];
};

/** How long a picked answer shows its dot before it goes: time for a double-click's second click to call it off. */
const COMMIT_MS = 300;
/** How far a press moves before it's a drag, not a click. */
const DRAG_PX = 4;

/** Where the user is on a card: an answer per question (undefined still open, null skipped), typed text, the lit and marked answers. */
type Kept = {
  page: number;
  answers: readonly (string | null | undefined)[];
  drafts: readonly (string | undefined)[];
  lit: readonly (number | null | undefined)[];
  marked: readonly (readonly number[] | undefined)[];
};
const FRESH: Kept = { page: 0, answers: [], drafts: [], lit: [], marked: [] };

// Kept by card id outside the card: putting it aside or a visit to Settings unmounts it, and coming back finds it as it was.
// shortcut: module-wide, dropped only once answered; scope it per session and drop it with the session once real sessions arrive.
const keptCards = new Map<string, Kept>();

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
  stagger = false,
}: {
  question: PendingQuestion;
  onAnswer: (answers: (string | null)[]) => Promise<void>;
  onDismiss: () => void;
  footer?: ReactNode;
  /** It follows another card: its rows fade in one after another. */
  stagger?: boolean;
}) {
  const { id, items } = question;
  const [{ page, answers, drafts, lit, marked }, keep] = useKeptQuestion(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = Math.min(page, items.length - 1);
  const item = items[at];
  if (!item) return null;

  const send = (all: (string | null)[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onAnswer(all)
      .then(() => keptCards.delete(id))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const answered = answers.filter((given) => given !== undefined).length;
  // Back to any question answered so far, or on to the first one still open.
  const reachable = (to: number) => to >= 0 && to < items.length && to <= answered;
  const answer = (given: string | null) => {
    const next = items.map((_, index) => (index === at ? given : answers[index]));
    const open = next.findIndex((each) => each === undefined);
    keep((now) => ({ answers: next, drafts: put(now.drafts, at, undefined), ...(open >= 0 && { page: open }) }));
    if (open < 0) send(next.map((each) => each ?? null));
  };
  const given = answers[at];
  const picked = typeof given === "string" ? item.options.findIndex((option) => option.label === given) : -1;
  const marks = marked[at];
  const ownWords = typeof given === "string" && picked < 0 && !(item.multiSelect && marks?.map((index) => item.options[index]?.label).join(", ") === given);
  return (
    <QuestionPage
      // Each question of the round starts fresh, but keeps an answer given, or text typed, before paging away.
      key={at}
      title={<CodeSpans text={item.text} />}
      kind={question.title && <CodeSpans text={question.title} />}
      item={item}
      kept={lit[at] ?? (picked >= 0 ? picked : null)}
      marked={item.multiSelect ? (marks ?? []) : undefined}
      initialText={drafts[at] ?? (ownWords ? given : "")}
      pager={
        items.length > 1 && (
          <StepCounter
            noun="question"
            at={at}
            count={items.length}
            canBack={reachable(at - 1)}
            canForward={reachable(at + 1)}
            onStep={(step) => keep(() => ({ page: at + step }))}
            className="-mt-0.5 h-6"
          />
        )
      }
      last={answers.filter((other, index) => index !== at && other !== undefined).length === items.length - 1}
      onPage={(step) => reachable(at + step) && keep(() => ({ page: at + step }))}
      onAnswer={answer}
      onTyped={(text) => keep((now) => ({ drafts: put(now.drafts, at, text) }))}
      onLit={(index) => keep((now) => ({ lit: put(now.lit, at, index) }))}
      onMarked={(indexes) => keep((now) => ({ marked: put(now.marked, at, indexes) }))}
      onDismiss={onDismiss}
      // ✕ skips what is still open in the round, so the asker hears and carries on.
      onClose={() => send(items.map((_, index) => answers[index] ?? null))}
      busy={busy}
      error={error}
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
  kept,
  marked: keptMarks,
  initialText,
  pager,
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
  footer,
  stagger,
}: {
  title: ReactNode;
  kind?: ReactNode;
  item: QuestionItem;
  kept: number | null;
  /** Multi-select: the answers marked so far. */
  marked?: readonly number[];
  initialText: string;
  pager?: ReactNode;
  last: boolean;
  onPage: (step: -1 | 1) => void;
  onAnswer: (given: string | null) => void;
  onTyped: (text: string) => void;
  onLit: (index: number | null) => void;
  onMarked: (indexes: number[]) => void;
  onDismiss: () => void;
  onClose: () => void;
  busy: boolean;
  error: string | null;
  footer?: ReactNode;
  stagger: boolean;
}) {
  const { options } = item;
  const multiple = keptMarks !== undefined;
  // The lit answer; -1 is the field, null none yet.
  const [highlight, setHighlight] = useState<number | null>(options.length === 0 ? -1 : kept);
  const lit = useEffectEvent((index: number | null) => onLit(index));
  useEffect(() => lit(highlight), [highlight]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [marked, setMarked] = useState<readonly number[]>(keptMarks ?? []);
  const [typed, setTyped] = useState(initialText);
  // One that came while nobody could see the window shows its rows at once.
  const [opens] = useState(() => document.visibilityState === "visible");
  const card = useRef<HTMLElement>(null);
  const field = useRef<ComposerFieldHandle>(null);
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
  const text = typed.trim();
  // Something to send: words typed, or answers marked.
  const ready = !!text || marked.length > 0;
  const submit = () => {
    if (!idle) return;
    if (text) onAnswer(text);
    else if (marked.length > 0) onAnswer(marked.map((index) => options[index]!.label).join(", "));
    else onAnswer(null);
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
    const digit = Number(event.key);
    const lastOption = options.length - 1;
    // With an answer focused, focus follows the light, so Enter (which clicks the focused answer) picks the lit one.
    const move = (index: number) => {
      setHighlight(index);
      if (event.target instanceof Element && event.target.matches("[data-slot=action-option]")) card.current?.querySelectorAll<HTMLElement>("[data-slot=action-option]")[index]?.focus();
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

  const row = (index: number) => staggered(stagger && opens, index);
  return (
    <ActionCard ref={card} container="request" tabIndex={0} aria-label="Question" data-action="question" onKeyDown={onKeyDown}>
      <div {...row(0)}>
        <ActionCardQuestion onDismiss={() => idle && onClose()} dismissLabel="Skip" kind={kind} aside={pager}>
          {title}
        </ActionCardQuestion>
      </div>
      <div className="flex flex-col gap-1 px-2 pt-1 pb-2">
        {pickable && (
          <div role={multiple ? "group" : "radiogroup"} aria-label="Answers" className="flex flex-col gap-1">
            {options.map((option, index) => (
              <ActionOption
                key={option.label}
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
                {...row(index + 1)}
              />
            ))}
          </div>
        )}
        <ActionFreeText
          marker={pickable}
          highlighted={pickable && highlight === -1}
          {...row(options.length + 1)}
          field={
            <div className="min-w-0 flex-1" onFocus={() => setHighlight(-1)}>
              {/* shortcut: plain words only (no @ or / menus, no pasted files); pass the composer's through and answer a Draft once Rust takes one. */}
              <ComposerField
                ref={field}
                size="card"
                label="Your answer"
                placeholder={pickable ? "No, and tell the agent what to do differently" : "Type here"}
                initial={{ parts: initialText ? [initialText] : [], attachmentIds: [] }}
                onChange={(parts) => {
                  const value = plainText(parts);
                  setTyped(value);
                  onTyped(value);
                  if (value) setHighlight(-1);
                }}
                onSubmit={() => text && submit()}
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
          <button type="button" className={actionButton(ready ? "primary" : "outline", "font-medium")} disabled={busy} onClick={submit}>
            {!ready ? "Skip" : last ? "Submit" : "Next"}
          </button>
        </ActionFreeText>
      </div>
      <ErrorLine error={error} className="px-4 pb-2" />
      {footer}
    </ActionCard>
  );
}
