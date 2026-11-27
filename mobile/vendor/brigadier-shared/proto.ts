/**
 * The version of the phone's protocol this code speaks, sent in `hello` [D58, design §4.5]. Raised when an allowed
 * command, an operation's reply or a thread item's shape changes incompatibly; a new item kind doesn't raise it. It is
 * the top of the daemon's range (`PROTO` in crates/daemon/src/remote/link.rs), which scripts/limits holds equal.
 */
export const PROTO = 1;
