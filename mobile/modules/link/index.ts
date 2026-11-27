import { NativeModule, requireNativeModule } from "expo-modules-core";

/** A Mac this phone has paired with. Its psk stays in the Keychain, on the Swift side. */
export type Mac = { pk: string; name: string; device: string; addresses: string[] };
/** A Mac offering itself on this network: its Bonjour service name, its key, and "1" while it shows an offer. */
export type Found = { name: string; pk: string; open: "0" | "1" };

/** Events carry their stream's number, so a superseded stream's are dropped. */
declare class Link extends NativeModule<{ data: (e: { b: string; n: number }) => void; closed: (e: { n: number }) => void }> {
  /** A screen to open at launch, from the `-screen` launch argument (simulator screenshots only). */
  screen: string | null;
  /** This app's build number. */
  build: string;
  /** Face ID (or the passcode if Face ID is unavailable); false when cancelled. */
  unlock(reason: string): Promise<boolean>;
  /** `denied` when this phone may not use the local network. */
  browse(ms: number): Promise<{ found: Found[]; denied: boolean }>;
  /**
   * Opens the stream: targets are "ip:port" or "bonjour:<name>", tried in order. `secret` is the QR's `s` or the
   * normalised code; "device" uses the saved psk.
   */
  connect(
    mode: "qr" | "code" | "device",
    mac: string,
    targets: string[],
    secret: string | null,
  ): Promise<{ check?: string; stream?: number; error?: "unreachable" | "refused" | "closed" }>;
  /** Plain bytes into the stream, base64. */
  write(b64: string): void;
  close(): void;
  /** U's signature over this stream's handshake hash; asks for Face ID, and throws when it is cancelled. */
  sign(): Promise<string>;
  /** Keeps the Mac this stream paired with; returns its key. */
  save(name: string, device: string, addresses: string[]): Promise<string>;
  macs(): Promise<Mac[]>;
  forget(pk: string): Promise<void>;
}

export default requireNativeModule<Link>("Link");
