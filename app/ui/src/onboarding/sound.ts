/*
 * The first launch's welcome sound, through Web Audio so it doesn't show in Now Playing. It comes
 * inlined in a chunk of its own, loaded only for the first launch: the page's content security
 * policy doesn't let it fetch its own files.
 */

const GAIN = 0.6;
/** How long it fades out over when the welcome closes before it has finished. */
const FADE_S = 0.6;

let loading: Promise<{ context: AudioContext; buffer: AudioBuffer }> | null = null;

/** Starts loading and decoding the sound, so the intro can start with it. Safe to call again. */
export function preloadWelcomeSound(): Promise<{ context: AudioContext; buffer: AudioBuffer }> {
  loading ??= (async () => {
    const context = new AudioContext();
    try {
      const { default: dataUrl } = await import("./welcome-sound.m4a?inline");
      const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
      return { context, buffer: await context.decodeAudioData(bytes.buffer) };
    } catch (error) {
      void context.close().catch(() => {});
      throw error;
    }
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Plays it once; resolves, as it starts, to a function that fades it out. Rejects if it can't play. */
export async function playWelcomeSound(): Promise<() => void> {
  const { context, buffer } = await preloadWelcomeSound();
  await context.resume();
  if (context.state !== "running") throw new Error(`the welcome sound can't play (${context.state})`);
  const gain = context.createGain();
  gain.gain.value = GAIN;
  gain.connect(context.destination);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(gain);
  let stopped = false;
  source.addEventListener("ended", () => {
    stopped = true;
    source.disconnect();
    gain.disconnect();
    loading = null;
    void context.close().catch(() => {});
  });
  source.start();
  return () => {
    if (stopped) return;
    stopped = true;
    const now = context.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_S);
    source.stop(now + FADE_S);
  };
}
