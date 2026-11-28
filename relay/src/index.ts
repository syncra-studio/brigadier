import { type Env, LIMITED, MALFORMED, NOT_ADMITTED, OPEN_PROOF, PASS, PUSH, REFUSED, doorRoom, now, parse, sha256, source, utf8 } from "./wire";

export { Budget } from "./budget";
export { Lookup } from "./lookup";
export { Quota } from "./quota";
export { Room } from "./room";

const SKEW = 300;

// A socket closed at once with a code the client can read, without waking any room.
function refuse(code: number) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, "");
  return new Response(null, { status: 101, webSocket: client });
}

// The room an open is signed for, checked without touching any Durable Object, so a stranger never wakes one.
async function door(q: URLSearchParams, mac: boolean) {
  const time = q.get(mac ? "at" : "until") ?? "";
  if (!/^[0-9]{1,12}$/.test(time)) return null;
  const t = Number(time);
  if (mac ? Math.abs(now() - t) > SKEW : t <= now()) return null;
  const room = await doorRoom(mac ? OPEN_PROOF : PASS, q.get("key"), t, q.get("sig"));
  const given = q.get("room");
  return given === null || given === room ? room : null;
}

const admitted = (env: Env, room: string) => env.HOSTED !== "1" || (env.ROOMS ?? "").split(",").some((r) => r.trim() === room);

// A push socket's one text (rev 4): `{"t":"push","token","e"}`, signed with the open by the room's key over its
// SHA-256, so the room wakes only for its own computer. Answered `{"t":"pushed","status"}`, then closed.
async function pushed(env: Env, q: URLSearchParams, from: string, msg: unknown, ws: WebSocket) {
  const text = typeof msg === "string" && msg.length <= 4096 ? msg : "";
  const at = Number(q.get("at"));
  const room = text && (await doorRoom(PUSH, q.get("key"), at, q.get("sig"), await sha256(utf8(text))));
  if (!room) return ws.close(REFUSED, "");
  if (!admitted(env, room)) return ws.close(NOT_ADMITTED, "");
  const p = parse(text);
  const ok = p?.t === "push" && typeof p.token === "string" && /^[0-9a-f]{64,200}$/.test(p.token) && typeof p.e === "string" && /^[A-Za-z0-9+/=]{1,3000}$/.test(p.e);
  if (!ok) return ws.close(MALFORMED, "");
  const status = await env.ROOM.get(env.ROOM.idFromName(room))
    .push(from, q.get("key") ?? "", p.token as string, p.e as string)
    .catch(() => 502);
  ws.send(JSON.stringify({ t: "pushed", status }));
  ws.close(1000, "");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const from = source(req.headers.get("CF-Connecting-IP") ?? "");

    const lookup = url.pathname.match(/^\/v1\/lookup\/([0-9a-f]{64})$/);
    if (lookup && req.method === "GET") {
      // Lookups can't be signed, so they are the one way a stranger wakes a Durable Object: kept to 3 a minute.
      if (!(await env.LOOKUPS.limit({ key: from })).success) return new Response(null, { status: 429 });
      const entry = await env.LOOKUP.get(env.LOOKUP.idFromName(lookup[1])).find();
      return entry ? Response.json(entry) : new Response(null, { status: 404 });
    }

    if (url.pathname === "/v1/push") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
      // shortcut: opens share the per-address limit of 10 a minute, so a burst past it loses its pushes; give push its own limit if that shows.
      if (!(await env.OPENS.limit({ key: `${url.pathname} ${from}` })).success) return refuse(LIMITED);
      const at = url.searchParams.get("at") ?? "";
      if (!/^[0-9]{1,12}$/.test(at) || Math.abs(now() - Number(at)) > SKEW) return new Response(null, { status: 401 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      let first = true;
      server.addEventListener("message", (e) => {
        if (first) void pushed(env, url.searchParams, from, e.data, server);
        first = false;
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    const mac = url.pathname === "/v1/mac";
    if (!mac && url.pathname !== "/v1/phone") return new Response(null, { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    if (!(await env.OPENS.limit({ key: `${url.pathname} ${from}` })).success) return refuse(LIMITED);
    const room = await door(url.searchParams, mac);
    if (!room) return new Response(null, { status: 401 });
    if (!admitted(env, room)) return refuse(NOT_ADMITTED);
    // The room learns its own id from the front, never from the client.
    const inner = new URL(url.pathname, url);
    inner.searchParams.set("room", room);
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(new Request(inner, req));
  },
} satisfies ExportedHandler<Env>;
