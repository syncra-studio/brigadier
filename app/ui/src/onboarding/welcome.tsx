import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";

import { ErrorLine } from "../components/error-line";
import { tokenMs } from "../components/tooltip";
import { errorText, intro } from "./api";
import { IntroCanvas, WINDOW_SHAPED } from "./intro-canvas";
import { BrigadierMark } from "./mark";
import { ContinueButton, useFocusOnMount } from "./parts";
import { playWelcomeSound, preloadWelcomeSound } from "./sound";

/** How long the intro waits for its sound to load before it starts without it. */
const SOUND_WAIT_MS = 1500;
/** How long the window's page takes to show clear before the window does. */
const STAGE_PAINT_MS = 50;
/** The desktop's dim fading out, early (Escape, the window ending it). */
const QUICK_LIFT_MS = 300;
const TITLE = ["Brigadier,", "at your command."] as const;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The page shows clear while the window is staged, so only the orb is seen (onboarding.css). */
function setPageStaged(staged: boolean): void {
  if (staged) document.documentElement.dataset.intro = "staged";
  else delete document.documentElement.dataset.intro;
}

const logged = (promise: Promise<unknown> | undefined) => void promise?.catch((error: unknown) => console.error(error));

/**
 * The first launch's welcome, then the name, as the old app played it [D48]. The intro starts with
 * its music, a moment before anything is seen. On macOS the desktop dims and a soft orb of light
 * comes into focus at the window's centre, idling there while the music builds; it opens out,
 * blurred, into the window, its light settles onto the shell's dark with faint waves moving over it,
 * and the window's chrome comes back (main's intro.ts). The mark comes up as the music drops, held
 * while the dim lifts, then glides up to the title's centre, shrinking, and fades; the title's two
 * lines part into place and Continue slides out from under them, usable only then (Enter too).
 * Escape, or reduced motion, shows the end at once. Continuing fades the title and the waves out,
 * and the name comes in on the same dark.
 */
export function Welcome({ step, name, onSound, onContinue, onName }: {
  step: "intro" | "name";
  name: string;
  /** The sound started: stops it (fading) if the welcome closes before it ends. */
  onSound: (stop: () => void) => void;
  onContinue: () => void;
  onName: (name: string) => Promise<void>;
}) {
  const [start, setStart] = useState<number | null>(null);
  const [settled, setSettled] = useState(() => step !== "intro" || reducedMotion());
  const [ready, setReady] = useState(settled);
  // The gradient stays until it has faded out behind the name.
  const [canvasShown, setCanvasShown] = useState(step === "intro");
  // The window is staged for the intro until its dim starts lifting.
  const staged = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef({ onContinue, onSound });
  latest.current = { onContinue, onSound };

  // Settled before the window was staged (WebGL can't draw, or Escape): it isn't staged.
  const settledEarly = useRef(settled);
  // Shows the intro's end at once; the window's own state comes back with it.
  const settle = useCallback(() => {
    settledEarly.current = true;
    setSettled(true);
    setReady(true);
    setPageStaged(false);
    if (staged.current) {
      staged.current = false;
      logged(intro.finish(QUICK_LIFT_MS));
    }
  }, []);

  // The intro starts with its sound (or without it, if it can't play), once the window shows.
  useEffect(() => {
    if (step !== "intro") return;
    let live = true;
    const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), SOUND_WAIT_MS));
    void (async () => {
      const loaded = await Promise.race([
        preloadWelcomeSound().then(
          () => "loaded" as const,
          (error: unknown) => {
            console.error("the welcome sound can't load", error);
            return "failed" as const;
          },
        ),
        late,
      ]);
      if (!live) return;
      if (reducedMotion() || settledEarly.current) {
        await intro.release()?.catch((error: unknown) => console.error(error));
      } else {
        setPageStaged(true);
        await new Promise((resolve) => setTimeout(resolve, STAGE_PAINT_MS));
        // Skipped while the page painted: the window shows as it is, unstaged.
        const shown =
          !settledEarly.current &&
          (await intro.begin().catch((error: unknown) => {
            console.error("the window can't stage the intro", error);
            return false;
          }));
        if (!live) {
          setPageStaged(false);
          if (shown) logged(intro.finish(0));
          return;
        }
        if (!shown) setPageStaged(false);
        if (settledEarly.current) {
          // Skipped while the window staged, the window comes back at once.
          if (shown) logged(intro.finish(QUICK_LIFT_MS));
          else await intro.release()?.catch((error: unknown) => console.error(error));
        } else staged.current = shown;
      }
      if (loaded === "loaded") {
        try {
          const stop = await playWelcomeSound();
          if (!live) return stop();
          latest.current.onSound(stop);
        } catch (error) {
          console.error("the welcome sound can't play", error);
        }
      }
      if (live) setStart(performance.now());
    })();
    return () => {
      live = false;
    };
  }, [step]);

  // The window's beats, from the intro's start.
  useEffect(() => {
    if (start === null || settled) return;
    const at = (ms: number, beat: () => void) => setTimeout(beat, start + ms - performance.now());
    const timers = [
      at(WINDOW_SHAPED * 1000, () => {
        setPageStaged(false);
        if (staged.current) logged(intro.shaped());
      }),
      at(tokenMs("--intro-dim-lift-at"), () => {
        if (!staged.current) return;
        staged.current = false;
        logged(intro.finish(tokenMs("--intro-dim-lift")));
      }),
    ];
    return () => timers.forEach(clearTimeout);
  }, [start, settled]);

  // Escape during the intro shows its end; so does the window ending the intro itself.
  useEffect(() => {
    if (step !== "intro" || settled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      settle();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    const unlisten = intro.onEnded(settle);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      unlisten();
    };
  }, [step, settled, settle]);

  const leave = useCallback(() => {
    if (leaveTimer.current) return;
    setLeaving(true);
    leaveTimer.current = setTimeout(() => latest.current.onContinue(), reducedMotion() ? 0 : tokenMs("--intro-leave"));
  }, []);

  // Once Continue is there, Enter continues wherever the focus is.
  useEffect(() => {
    if (step !== "intro" || !ready) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (!event.repeat && !(event.altKey || event.shiftKey || event.ctrlKey || event.metaKey)) leave();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [step, ready, leave]);

  // Leaving with the window still staged restores it.
  useEffect(
    () => () => {
      clearTimeout(leaveTimer.current);
      setPageStaged(false);
      if (staged.current) logged(intro.finish(0));
    },
    [],
  );

  return (
    <div
      className="welcome app-drag"
      data-step={step}
      data-started={start !== null || undefined}
      data-settled={settled || undefined}
      data-leaving={(step === "intro" && leaving) || undefined}
    >
      {canvasShown && (
        <IntroCanvas
          start={start}
          settled={settled}
          still={reducedMotion()}
          onUnavailable={settle}
          className="welcome-canvas size-full"
          onTransitionEnd={() => step !== "intro" && setCanvasShown(false)}
        />
      )}
      {step === "intro" && (
        <div className="welcome-intro-mark" aria-hidden>
          <BrigadierMark className="block size-full" />
        </div>
      )}
      {step === "intro" ? (
        <div className="welcome-copy">
          <h1 className="welcome-title" aria-label={TITLE.join(" ")}>
            {TITLE.map((line) => (
              <span key={line} className="welcome-title-line">
                <span aria-hidden>{line}</span>
              </span>
            ))}
          </h1>
          <div
            className="welcome-continue app-no-drag"
            // Out of reach until it has come in, without the disabled look.
            inert={!ready}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget && event.animationName === "intro-continue-in") setReady(true);
            }}
          >
            <ContinueButton ready={ready} intro onClick={leave} />
          </div>
        </div>
      ) : (
        <NameForm name={name} onName={onName} />
      )}
    </div>
  );
}

/** "What should we call you?" under the mark: one borderless field; Continue saves it once it holds more than spaces. */
function NameForm({ name, onName }: { name: string; onName: (name: string) => Promise<void> }) {
  const id = useId();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const input = useFocusOnMount<HTMLInputElement>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onName(trimmed);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <div className="welcome-name app-no-drag">
      <form id={id} className="welcome-name-body" onSubmit={(event) => void submit(event)}>
        <div className="welcome-mark" aria-hidden>
          <BrigadierMark className="block size-full overflow-visible" />
        </div>
        <h1 className="welcome-heading text-balance">What should we call you?</h1>
        <label htmlFor={`${id}-name`} className="sr-only">
          Your name
        </label>
        {/* Borderless: the words alone, centred under the question. */}
        <input
          ref={input}
          id={`${id}-name`}
          autoComplete="given-name"
          placeholder="Your name"
          maxLength={80}
          value={value}
          disabled={busy}
          aria-invalid={error !== null || undefined}
          onChange={(event) => setValue(event.target.value)}
          className="w-full max-w-80 bg-transparent text-center text-lg outline-none placeholder:text-setup-hint disabled:opacity-disabled"
        />
        <ErrorLine size="sm" error={error} className="mt-3" />
      </form>
      <div className="welcome-continue">
        <ContinueButton ready={trimmed !== ""} busy={busy} form={id} />
      </div>
    </div>
  );
}
