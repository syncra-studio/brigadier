// Holds the daemon socket in a utility process and passes its bytes straight to the page.
import net from "node:net";

const PROTOCOL_VERSION = 1;
const RETRY_MS = 250;
const socketPath = process.argv[2];

let port: Electron.MessagePortMain;
let socket: net.Socket | undefined;
let retry: NodeJS.Timeout;

function connect(): void {
  const current = net.connect(socketPath);
  socket = current;
  current.on("connect", () => {
    const version = Buffer.alloc(4);
    version.writeUInt32BE(PROTOCOL_VERSION);
    current.write(version);
  });
  current.on("data", (chunk) => port.postMessage(chunk));
  current.on("error", () => {}); // "close" always follows
  current.on("close", () => {
    if (socket !== current) return;
    port.postMessage(null);
    retry = setTimeout(connect, RETRY_MS);
  });
}

// One port per page load, so a reload starts over with a fresh snapshot.
process.parentPort.on("message", ({ ports: [next] }) => {
  port?.close();
  port = next;
  port.start();
  clearTimeout(retry);
  const previous = socket;
  socket = undefined;
  previous?.destroy();
  connect();
});
