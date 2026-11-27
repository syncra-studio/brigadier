// The daemon's wire, once for both apps [D58]: each frame a 4-byte big-endian length and its JSON, and replies by
// request id. The transport is passed in: Electron's port on the desktop, the Noise channel on the phone.

export type Frame = Record<string, any>;
type Reply = (frame: Frame) => void;

/** `post` sends one whole frame; `onFrame` gets every frame that isn't a reply someone waits for. */
export function client(post: (frame: Uint8Array) => void, onFrame: (frame: Frame) => void) {
  let nextId = 0;
  let bytes = new Uint8Array();
  // Chunks come after `bytes`; `held` counts both.
  let chunks: Uint8Array[] = [];
  let held = 0;
  // One-off replies by request id.
  const replies = new Map<number, Reply>();

  function send(request: object): number {
    const id = ++nextId;
    const json = new TextEncoder().encode(JSON.stringify({ id, ...request }));
    const frame = new Uint8Array(4 + json.length);
    new DataView(frame.buffer).setUint32(0, json.length);
    frame.set(json, 4);
    post(frame);
    return id;
  }

  /** `bytes` with the chunks after it, in one buffer. */
  function join(): void {
    const all = new Uint8Array(held);
    all.set(bytes);
    let at = bytes.length;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    bytes = all;
    chunks = [];
  }

  function dispatch(frame: Frame): void {
    const reply = replies.get(frame.re);
    if (!reply) return onFrame(frame);
    replies.delete(frame.re);
    reply(frame);
  }

  return {
    send,
    /** Sends a request; `onReply` gets its answer, or what `drop` gives it. */
    ask(request: object, onReply?: Reply): number {
      const id = send(request);
      if (onReply) replies.set(id, onReply);
      return id;
    },
    // A page of older history comes in many chunks: they're joined once its frame is whole, not as each comes.
    receive(chunk: Uint8Array): void {
      chunks.push(chunk);
      held += chunk.length;
      while (held >= 4) {
        if (bytes.length < 4) join();
        const end = 4 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
        if (held < end) return;
        if (bytes.length < end) join();
        dispatch(JSON.parse(new TextDecoder().decode(bytes.subarray(4, end))));
        bytes = bytes.subarray(end);
        held -= end;
      }
    },
    /** A new or lost connection: no half frame is kept. */
    reset(): void {
      [bytes, chunks, held] = [new Uint8Array(), [], 0];
    },
    /** The connection is lost: the replies still waiting, taken out for the caller to fail. */
    drop(): Reply[] {
      const waiting = [...replies.values()];
      replies.clear();
      return waiting;
    },
  };
}
