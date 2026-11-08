import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";

import { errorText } from "./api";
import { IntroCanvas } from "./intro-canvas";
import { BrigadierMark } from "./mark";
import { ContinueButton, useFocusOnMount } from "./parts";
import { playWelcomeSound, preloadWelcomeSound } from "./sound";

/** How long the intro waits for its sound to load before it starts without it. */
const SOUND_WAIT_MS = 1500;
const TITLE = ["Brigadier,", "at your command."] as const;

/** A time token ("2.2s", "450ms") in milliseconds. */
function tokenMs(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  return value.endsWith("ms") ? amount : amount * 1000;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The first launch's welcome, then the name, as the old app played it [D48]: the music starts, a
 * soft orb of light comes into focus at the window's centre and opens out into the window; the
 * mark comes up as the music drops, glides up and fades; the title's two lines part into place
 * and Continue slides out from under them. Escape, or reduced motion, shows the end at once.
 * (The old app also dimmed the desktop around the window; that native staging isn't carried over.)
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
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef({ onContinue, onSound });
  latest.current = { onContinue, onSound };

  const settle = useCallback(() => {
    setSettled(true);
    setReady(true);
  }, []);

  // The intro starts with its sound, or without it if it can't load in time or play.
  useEffect(() => {
    if (step !== "intro") return;
    let live = true;
    const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), SOUND_WAIT_MS));
    void (async () => {
      const loaded = await Promise.race([preloadWelcomeSound().then(() => "loaded" as const, () => "failed" as const), late]);
      if (loaded === "loaded" && live) {
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

  // Escape during the intro shows its end.
  useEffect(() => {
    if (step !== "intro" || settled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      settle();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [step, settled, settle]);

  const leave = useCallback(() => {
    if (leaveTimer.current) return;
    setLeaving(true);
    leaveTimer.current = setTimeout(() => latest.current.onContinue(), reducedMotion() ? 0 : tokenMs("--intro-leave"));
  }, []);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

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
          className="welcome-canvas"
          onTransitionEnd={() => step !== "intro" && setCanvasShown(false)}
        />
      )}
      {step === "intro" && (
        <div className="welcome-intro-mark" aria-hidden>
          <BrigadierMark />
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
          <BrigadierMark />
        </div>
        <h1 className="welcome-heading text-balance">What should we call you?</h1>
        <label htmlFor={`${id}-name`} className="sr-only">
          Your name
        </label>
        {/* Borderless: the words alone, centred under the question (the kit's field is a filled pill). */}
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
          className="w-full max-w-dialog bg-transparent text-center text-lg outline-none placeholder:text-quiet-foreground disabled:opacity-disabled"
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
      <div className="welcome-continue">
        <ContinueButton ready={trimmed !== ""} busy={busy} form={id} />
      </div>
    </div>
  );
}
