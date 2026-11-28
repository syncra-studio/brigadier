import { NativeModule, requireNativeModule } from "expo-modules-core";

/** A pass to a Mac's room on its relay (relay-wire "A phone's socket"): `key` and `sig` base64url, `until` unix s. */
export type Pass = { url: string; key: string; until: number; sig: string };
/** A Mac this phone has paired with, and the pass its last `hello` gave. Its psk stays in the Keychain, on the Swift side. */
export type Mac = { pk: string; name: string; device: string; addresses: string[]; relay?: Pass };
/** A Mac offering itself on this network: its Bonjour service name, its key, and "1" while it shows an offer. */
export type Found = { name: string; pk: string; open: "0" | "1" };

/** Events carry their stream's number, so a superseded stream's are dropped. */
/** `path`: the network changed (Wi-Fi joined or left). */
declare class Link extends NativeModule<{ data: (e: { b: string; n: number }) => void; closed: (e: { n: number; paused?: number }) => void; path: () => void }> {
  /** A screen to open at launch, from the `-screen` launch argument (simulator screenshots only). */
  screen: string | null;
  /** This app's build number. */
  build: string;
  /** Face ID (or the passcode if Face ID is unavailable); false when cancelled. */
  unlock(reason: string): Promise<boolean>;
  /** `denied` when this phone may not use the local network. */
  browse(ms: number): Promise<{ found: Found[]; denied: boolean }>;
  /**
   * Opens the stream: targets are "ip:port", "bonjour:<name>" or a relay's phone socket URL, tried in order. `secret`
   * is the QR's `s` or the normalised code; "device" uses the saved psk. `seen`: the relay has no Mac now, and last had
   * it then (unix s, 0 if never). `paused`: the relay carries none of this Mac's streams until then (unix s; 0 with no
   * date: the relay's budget is spent).
   */
  connect(
    mode: "qr" | "code" | "device",
    mac: string,
    targets: string[],
    secret: string | null,
  ): Promise<{ check?: string; stream?: number; error?: "unreachable" | "refused" | "closed"; seen?: number; paused?: number }>;
  /** Plain bytes into the stream, base64. */
  write(b64: string): void;
  close(): void;
  /** U's signature over this stream's handshake hash; asks for Face ID, and throws when it is cancelled. */
  sign(): Promise<string>;
  /**
   * U's fresh signature for one action (Face ID each time): over this stream's handshake hash, the Mac's nonce, the
   * three names the challenge gave, and `argv`, the command's JSON exactly as it is sent.
   */
  act(nonce: string, session: string, request: string, action: string, argv: string): Promise<string>;
  /** Keeps the Mac this stream paired with; returns its key. */
  save(name: string, device: string, addresses: string[]): Promise<string>;
  macs(): Promise<Mac[]>;
  /** The typed code's offer at the first relay ("ws(s)://host") that holds it: the Mac's Noise key `m` and a pass. */
  find(relays: string[], code: string): Promise<(Pass & { m: string }) | null>;
  /** Keeps `hello`'s pass with its Mac. */
  relay(pk: string, pass: Pass): Promise<void>;
  forget(pk: string): Promise<void>;
}

export default requireNativeModule<Link>("Link");
