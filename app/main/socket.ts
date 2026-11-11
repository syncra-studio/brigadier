// Holds the daemon socket in a utility process and passes bytes both ways, untouched.
import net from "node:net";

const PROTOCOL_VERSION = 4;
const RETRY_MS = 250;
// A daemon that stops answering (paused, hung) keeps its socket open, so nothing closes. Every PROBE_MS a second
// connection waits for the daemon's hello, which its accept thread sends whatever requests are running; none within
// ANSWER_MS drops the link and the usual reconnect takes over. VS Code counts its extension host unresponsive after 3s [D557].
const PROBE_MS = 2000;
const ANSWER_MS = 3000;
const socketPath = process.argv[2];

let port: Electron.MessagePortMain;
let socket: net.Socket | undefined;
let retry: NodeJS.Timeout;

function hello(): Buffer {
  const version = Buffer.alloc(4);
  version.writeUInt32BE(PROTOCOL_VERSION);
  return version;
}

function connect(): void {
  const current = net.connect(socketPath);
  socket = current;
  current.on("connect", () => current.write(hello()));
  current.on("data", (chunk) => port.postMessage(chunk));
  current.on("error", () => {}); // "close" always follows
  current.on("close", () => {
    if (socket !== current) return;
    port.postMessage(null);
    // Main starts a daemon, which stays only if none of this build or newer runs.
    process.parentPort.postMessage("down");
    retry = setTimeout(connect, RETRY_MS);
  });
}

// One port per page load, so a reload starts over with a fresh snapshot.
process.parentPort.on("message", ({ ports: [next] }) => {
  port?.close();
  port = next;
  port.on("message", ({ data }) => socket?.write(data));
  port.start();
  clearTimeout(retry);
  const previous = socket;
  socket = undefined;
  previous?.destroy();
  connect();
});

// A refused or missing socket ends a probe at once: that daemon is gone or starting, which the link sees for itself.
function probe(): void {
  const check = net.connect(socketPath);
  const miss = setTimeout(() => {
    check.destroy();
    socket?.destroy();
  }, ANSWER_MS);
  check.on("connect", () => check.write(hello()));
  check.on("data", () => check.destroy());
  check.on("error", () => {});
  check.on("close", () => {
    clearTimeout(miss);
    setTimeout(probe, PROBE_MS);
  });
}
probe();
