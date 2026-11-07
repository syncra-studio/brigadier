import { useSyncExternalStore } from "react";

export type Daemon = { pid: number; version: string };

// undefined until the first answer, then the running daemon or null.
let daemon: Daemon | null | undefined;
let bytes = new Uint8Array();
const listeners = new Set<() => void>();

function set(next: Daemon | null): void {
  daemon = next;
  for (const listener of listeners) listener();
}

function receive(chunk: Uint8Array): void {
  bytes = new Uint8Array([...bytes, ...chunk]);
  while (bytes.length >= 4) {
    const end = 4 + new DataView(bytes.buffer).getUint32(0);
    if (bytes.length < end) return;
    const frame = JSON.parse(new TextDecoder().decode(bytes.subarray(4, end)));
    set(frame.status === "running" ? { pid: frame.pid, version: frame.version } : null);
    bytes = bytes.slice(end);
  }
}

// At module level, not in an effect: main posts the port once the page has loaded, maybe before React's first effect.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== "daemon-port") return;
  const [port] = event.ports;
  bytes = new Uint8Array();
  port.onmessage = ({ data }: MessageEvent<Uint8Array | null>) => {
    if (data) return receive(data);
    bytes = new Uint8Array();
    set(null);
  };
});

export const useDaemon = (): Daemon | null | undefined =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => daemon,
  );
