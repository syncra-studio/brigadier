/** Sessions just started from Home, by session id, with their first message's id: placed once the thread opens. */
const toPlace = new Map<string, string>();
export const placeOnOpen = (id: string, cid: string) => void toPlace.set(id, cid);
export function takePlace(id: string): string | undefined {
  const cid = toPlace.get(id);
  toPlace.delete(id);
  return cid;
}
