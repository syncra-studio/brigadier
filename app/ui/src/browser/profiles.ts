/** A tab an agent may be working was moved to another profile. Said once per tab, before its page goes. */
export type ProfileChange = { tabId: string; from: string; to: string };
const profileChangeListeners = new Set<(change: ProfileChange) => void>();

/** For the agent's side of the browser: its refs and page state don't survive the move. */
export function onProfileChanged(listener: (change: ProfileChange) => void): () => void {
  profileChangeListeners.add(listener);
  return () => profileChangeListeners.delete(listener);
}

export function profileChanged(change: ProfileChange): void {
  for (const listener of profileChangeListeners) listener(change);
}
