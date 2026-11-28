import { type Env, LIMITED, NOT_ADMITTED, OPEN_PROOF, PASS, doorRoom, now, source } from "./wire";

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

    const mac = url.pathname === "/v1/mac";
    if (!mac && url.pathname !== "/v1/phone") return new Response(null, { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    if (!(await env.OPENS.limit({ key: `${url.pathname} ${from}` })).success) return refuse(LIMITED);
    const room = await door(url.searchParams, mac);
    if (!room) return new Response(null, { status: 401 });
    if (env.HOSTED === "1" && !(env.ROOMS ?? "").split(",").some((r) => r.trim() === room)) return refuse(NOT_ADMITTED);
    // The room learns its own id from the front, never from the client.
    const inner = new URL(url.pathname, url);
    inner.searchParams.set("room", room);
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(new Request(inner, req));
  },
} satisfies ExportedHandler<Env>;
