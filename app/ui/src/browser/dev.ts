import { store } from "../onboarding/api";
import { agentDrive } from "./hands";
import { type BrowserBounds, guestOf } from "./layer";
import { isDriven } from "./pause";

/**
 * The developer tools of each Browser tab: DevTools docked beside or below the page, the element picker and device
 * sizes (main's browser/browserDevtools.ts). Each is on only while the user has it on.
 */

export type DeviceSize = {
  name: string;
  width: number;
  height: number;
  pixelRatio: number;
  userAgent: string | null;
};

/** This browser's own Chromium version, so a Pixel's user agent claims the engine really running. */
function chromiumVersion(): string {
  const found = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  return found?.[1]?.replace(/\.\d+\.\d+\.\d+$/, ".0.0.0") ?? "130.0.0.0";
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const PIXEL = `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion()} Mobile Safari/537.36`;

/** The sizes offered, a named device each; the width and height fields take any other. */
export const DEVICE_SIZES: readonly DeviceSize[] = [
  { name: "iPhone SE", width: 375, height: 667, pixelRatio: 2, userAgent: IPHONE },
  { name: "iPhone 16", width: 393, height: 852, pixelRatio: 3, userAgent: IPHONE },
  { name: "iPhone 16 Pro Max", width: 440, height: 956, pixelRatio: 3, userAgent: IPHONE },
  { name: "Pixel 9", width: 412, height: 923, pixelRatio: 2.625, userAgent: PIXEL },
  { name: "iPad Mini", width: 768, height: 1024, pixelRatio: 2, userAgent: IPAD },
  { name: "iPad Pro 12.9\"", width: 1024, height: 1366, pixelRatio: 2, userAgent: IPAD },
  { name: "Laptop", width: 1366, height: 768, pixelRatio: 1, userAgent: null },
  { name: "Laptop, large", width: 1440, height: 900, pixelRatio: 2, userAgent: null },
  { name: "Desktop", width: 1920, height: 1080, pixelRatio: 1, userAgent: null },
];

export const CUSTOM_SIZE = "Custom";

export type PickedElement = {
  url: string;
  selector: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
  password: boolean;
  component: string | null;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
};

export type DevDock = "right" | "bottom";

export type TabDev = {
  devtools: boolean;
  dock: DevDock;
  /** DevTools' share of the tab's area along its dock. */
  share: number;
  picking: boolean;
  picked: PickedElement | null;
  device: DeviceSize | null;
};

const NONE: TabDev = { devtools: false, dock: "right", share: 0.42, picking: false, picked: null, device: null };

const tabs = store<Record<string, TabDev>>({});

export const devOf = (id: string): TabDev => tabs.get()[id] ?? NONE;
export const useBrowserDev = (id: string): TabDev => tabs.use()[id] ?? NONE;

export function changeDev(id: string, change: Partial<TabDev>): void {
  tabs.set({ ...tabs.get(), [id]: { ...devOf(id), ...change } });
}

const devtools = <T>(op: string, id: string, args: Record<string, unknown> = {}) =>
  window.brigadierShell.devtools(op, { guest: guestOf(id), ...args }) as Promise<T>;

/** Starts the picker; ends with what was picked, or with nothing when the user leaves it. The tab's agent lets go first. */
export async function startPicking(id: string): Promise<void> {
  if (devOf(id).picking) return;
  changeDev(id, { picking: true, picked: null });
  try {
    if (isDriven(id)) await agentDrive(id, false);
    const picked = await devtools<PickedElement | null>("pick", id);
    changeDev(id, { picking: false, picked });
  } catch (error) {
    changeDev(id, { picking: false });
    throw error;
  }
}

export const stopPicking = (id: string): Promise<void> => devtools("pickStop", id);
export const openDevTools = (id: string, bounds: BrowserBounds): Promise<void> => devtools("open", id, { bounds });
export const placeDevTools = (id: string, bounds: BrowserBounds | null): Promise<void> => devtools("place", id, { bounds });
export const closeDevTools = (id: string): Promise<void> => devtools("close", id);

/** Lays the tab's page out as `device`, shown at `scale` to fit; answers whether its user agent changed. */
export const applyDevice = (id: string, device: DeviceSize, scale: number): Promise<boolean> => devtools("device", id, { device: { ...device, scale } });
export const clearDevice = (id: string): Promise<boolean> => devtools("deviceClear", id);

/** The share of the tab's area a size can show in: 1 at most, so it is never enlarged. */
export function fitScale(device: Pick<DeviceSize, "width" | "height">, room: { width: number; height: number }): number {
  if (room.width <= 0 || room.height <= 0) return 1;
  return Math.min(1, room.width / device.width, room.height / device.height);
}

/** A picked element as the agent reads it in a message: what it is and where, never a value. */
export function elementText(picked: PickedElement): string {
  const attrs = Object.entries(picked.attrs).map(([name, value]) => `${name}="${value}"`).join(" ");
  const rows = [
    `The element I picked on ${picked.url}:`,
    `- selector: ${picked.selector}`,
    `- element: <${picked.tag}${attrs ? ` ${attrs}` : ""}>`,
    picked.password ? "- a password field" : "",
    picked.component ? `- React component: ${picked.component}` : "",
    picked.text ? `- text: ${picked.text}` : "",
    `- size: ${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)}`,
    `- styles: ${Object.entries(picked.styles).map(([name, value]) => `${name}: ${value}`).join("; ")}`,
  ];
  return rows.filter(Boolean).join("\n");
}
