import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { showToast } from "../components/toast";
import { ArrowUpRight, Globe } from "../icons";
import { selectTab, setTabUrl, type Tab, tabOpenAnywhere } from "../shell/tab-store";
import { browserAddress, shownAddress, webAddress } from "./address";
import { closeFind, findInPage, findState, openFind, useBrowserFind } from "./find";
import { followLayout } from "./follow";
import { showPage } from "./hole";
import { type BrowserKey, browserKey, stepZoom } from "./keys";
import { type BrowserBounds, focusPage, go, placePage, printPage } from "./layer";
import { closeBrowserPage, dismissBlocked, openPage, originOf, syncZoom, useBrowserPage, zoomPage } from "./pages";
import { handBack, pageShows, type SignInStop, useAgentPause, userUsed } from "./pause";
import { dismissSignInRejected, useSignInRejected } from "./sign-in";
import { OsRefusedNotice, PermissionPrompt } from "./permission";
import { SiteInfo } from "./site-info";
import { useDriverName } from "./tab-icon";
import { BrowserOptions } from "./options";
import { ProfileButton } from "./profile-button";
import { AgentPill, AgentSessionBar, Banner, FindBar, type NavAction, NavigationCapsule } from "./toolbar-parts";
import { BrowserDevButton, BrowserDevFrame, BrowserPickerBar } from "./devtools";
import { BrowserDeviceBar } from "./device-sizes";
import { AddressSuggestions, stepSuggestion, type Suggestion, useAddressSuggestions } from "./suggestions";

/**
 * A Browser tab: one page, such as the app a worker is running on localhost. The page is a <webview> in the layer
 * under the app (layer.ts), made on the tab's address and hidden whenever the tab is; the app cuts a hole where it
 * shows (hole.ts), so its menus and dialogs draw over the live page.
 */

const MAC = window.brigadier?.platform === "darwin";
/** The longest address Rust keeps for a tab (tabs.rs's URL_MAX); a longer one isn't followed. */
const URL_MAX = 8192;

function boundsOf(element: HTMLElement): BrowserBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function failed(cause: unknown) {
  showToast(cause instanceof Error ? cause.message : String(cause), { tone: "error" });
}

const openOutside = (url: string) => window.brigadier?.openLink(url);

/** Why a tab's agent stopped for the user at a page only they can go through. */
function SignInStopWords({ stop, driver }: { stop: SignInStop; driver: string }) {
  const who = <span className="font-medium">{driver}</span>;
  if (stop.kind === "ask") return <>{who} asks you: {stop.what}</>;
  if (stop.kind === "rejected") return <>Google refused this sign-in, so {who} stopped. Hand the page back when you're done here.</>;
  if (stop.kind === "captcha") return <>This page shows a captcha, so {who} stopped. Solve it, then hand it back.</>;
  if (stop.window) return <>A sign-in window opened, so {who} stopped. Finish in that window, then hand it back.</>;
  return <>This page asks you to sign in, so {who} stopped. Agents don't sign in: do it here, then hand it back.</>;
}

/** `children` show until a page is made; `onNavigate` takes the first address instead (the New tab, which becomes a page). */
export function BrowserTab({ owner, tab, active, children, onNavigate }: { owner: string; tab: Tab; active: boolean; children?: ReactNode; onNavigate?: (url: string) => void }) {
  const id = tab.id;
  const page = useBrowserPage(id);
  const area = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const address = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const finding = useBrowserFind(id).open;
  const [typed, setTyped] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  /** The suggestion the arrow keys are on; -1: the field itself. */
  const [highlight, setHighlight] = useState(-1);
  const [suggesting, setSuggesting] = useState(true);
  const made = page !== undefined;
  const initialUrl = tab.target;
  const pause = useAgentPause();
  const paused = id in pause.paused;
  const devtoolsOpen = id in pause.devtools;
  const signInStop = pause.asked[id];
  const signInRejected = useSignInRejected(id);
  const driver = useDriverName(tab.driver);

  useEffect(() => {
    if (!active || !initialUrl || made || !area.current) return;
    openPage(owner, id, initialUrl, boundsOf(area.current)).catch(failed);
  }, [owner, id, initialUrl, made, active]);

  // The page goes with its tab, not when the session's tabs are no longer on screen.
  useEffect(() => () => void (tabOpenAnywhere(id) || closeBrowserPage(id)), [id]);

  // Keep the page over this tab's area, and hide it when the tab goes.
  useEffect(() => {
    const element = area.current;
    if (!page?.ready || !element || !active) return;
    let placed = "";
    const place = () => {
      const rect = boundsOf(element);
      const bounds = !element.closest("[inert]") && rect.width > 0 && rect.height > 0 ? rect : null;
      const key = JSON.stringify(bounds);
      if (key === placed) return;
      placed = key;
      placePage(id, bounds);
      showPage(id, bounds);
      pageShows(id, bounds !== null);
    };
    const stop = followLayout(() => [element], place);
    return () => {
      stop();
      placePage(id, null);
      showPage(id, null);
      pageShows(id, false);
    };
  }, [id, page?.ready, active]);

  const url = page?.url ?? "";
  const loading = page?.loading === true;
  const zoom = page?.zoom ?? 1;
  const ready = page?.ready === true;

  // The tab follows its page, so it opens there again after a restart.
  const followed = useRef(tab.target);
  useEffect(() => {
    if (!/^https?:/i.test(url) || url.length > URL_MAX || url === followed.current) return;
    followed.current = url;
    setTabUrl(owner, id, url);
  }, [owner, id, url]);

  useEffect(() => {
    if (active && ready) syncZoom(id);
  }, [active, ready, id]);

  const act = (action: NavAction | "back-unless-typing" | "forward-unless-typing" | "force-reload") => {
    userUsed(id);
    try {
      go(id, action);
    } catch (error) {
      failed(error);
    }
  };

  /** A click on the toolbar took the keyboard from the page; it goes back, so the page can be used at once. */
  const keyboardToPage = () => focusPage(id);

  const showFind = () => {
    const { query, open } = findState(id);
    openFind(id);
    if (!open && query) void findInPage(id, query, "type");
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };
  const hideFind = () => {
    closeFind(id);
    // Back to the page, as before the find bar opened.
    if (made) keyboardToPage();
  };
  const zoomTo = (to: number) => {
    try {
      zoomPage(id, to);
    } catch (error) {
      failed(error);
    }
  };
  const print = () => {
    printPage(id).catch(failed);
  };

  /** Does what `key` asks of this tab; false when it has nothing to do it on. */
  const onBrowserKey = useEffectEvent((key: BrowserKey): boolean => {
    if (key === "address") {
      field.current?.focus();
      field.current?.select();
      return true;
    }
    if (!ready) return false;
    const find = findState(id);
    switch (key) {
      case "back":
      case "forward":
        // The page has the keyboard: a field of the page keeps ⌘← and ⌘→ for its caret.
        act(document.hasFocus() ? key : `${key}-unless-typing`);
        return true;
      case "reload":
      case "force-reload":
        act(key);
        return true;
      case "find":
        showFind();
        return true;
      case "find-next":
      case "find-previous":
        if (!find.open || !find.query) showFind();
        else void findInPage(id, find.query, key === "find-next" ? "next" : "previous");
        return true;
      case "zoom-in":
        zoomTo(stepZoom(zoom, 1));
        return true;
      case "zoom-out":
        zoomTo(stepZoom(zoom, -1));
        return true;
      case "zoom-reset":
        zoomTo(1);
        return true;
    }
  });

  // The tab's keys while it is in front (see `browserKey`): ⌘L the address, ⌘←/⌘→, ⌘R and ⇧⌘R
  // the page, ⌘F/⌘G/⇧⌘G finding, ⌘=/⌘-/⌘0 zoom. A field's own ⌘← and ⌘→ stay its own.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = browserKey(event, MAC);
      if (!key) return;
      const target = event.target instanceof Element ? event.target : null;
      if ((key === "back" || key === "forward") && target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
      if (onBrowserKey(key)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // A page loaded while the find bar is open: its matches are looked for again.
  const wasLoading = useRef(loading);
  useEffect(() => {
    const was = wasLoading.current;
    wasLoading.current = loading;
    if (!was || loading) return;
    const { open, query } = findState(id);
    if (open && query && ready) void findInPage(id, query, "type");
  }, [loading, id, ready]);

  const goTo = (text: string) => {
    const to = browserAddress(text);
    if (!to || !area.current) return;
    userUsed(id);
    setTyped(null);
    field.current?.blur();
    // Reading the page comes next, as in any browser.
    if (onNavigate) {
      onNavigate(to);
      keyboardToPage();
      return;
    }
    openPage(owner, id, to, boundsOf(area.current)).catch(failed);
    keyboardToPage();
  };
  const editing = focused || typed !== null;
  const suggestions = useAddressSuggestions(owner, id, focused ? typed : null);
  const suggestionsOpen = focused && suggesting && typed !== null && suggestions.length > 0;
  const pick = (row: Suggestion) => {
    setHighlight(-1);
    if (row.kind === "tab") {
      setTyped(null);
      field.current?.blur();
      selectTab(owner, row.id);
      return;
    }
    goTo(row.text);
  };
  // What Open in external browser opens: what is being typed, else the page.
  const outside = (typed !== null ? browserAddress(typed) : null) ?? (url || null);

  return (
    <div data-pane="browser" data-active={active || undefined} className="flex min-h-0 flex-1 flex-col">
      {/* No line under it on the New tab page, only over a page [D216]. */}
      <div data-slot="browser-toolbar" className={cx("@container/browser-toolbar flex h-panel-header shrink-0 items-center gap-1.5 px-2", !onNavigate && "border-b border-border")}>
        <NavigationCapsule
          disabled={!made}
          canGoBack={page?.canGoBack === true}
          canGoForward={page?.canGoForward === true}
          loading={loading}
          onAct={(action) => {
            act(action);
            keyboardToPage();
          }}
        />
        <form
          className="flex min-w-0 flex-1 justify-center px-1 @max-sm/browser-toolbar:px-0"
          onSubmit={(event) => {
            event.preventDefault();
            goTo(typed ?? url);
          }}
        >
          <div
            ref={address}
            data-slot="browser-address"
            title={page?.title || undefined}
            className="group/address flex h-control-md w-full max-w-browser-address min-w-0 items-center rounded-capsule bg-control p-0.5 ring-1 ring-glass-stroke ring-inset"
          >
            {!editing && <SiteInfo url={url} />}
            <input
              ref={field}
              // ⌘T opens the tab to type an address at once. A tab with an address has its page coming.
              autoFocus={active && !made && !initialUrl}
              value={typed ?? (focused ? url : shownAddress(url, false))}
              placeholder="Search or enter a URL"
              aria-label="Address"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={suggestionsOpen}
              aria-controls={suggestionsOpen ? "browser-suggestions" : undefined}
              aria-activedescendant={suggestionsOpen && highlight >= 0 ? `browser-suggestion-${highlight}` : undefined}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => {
                setTyped(event.target.value);
                setHighlight(-1);
                setSuggesting(true);
              }}
              onFocus={(event) => {
                setFocused(true);
                // The whole URL replaces the site first, then is selected.
                const input = event.target;
                // select() also focuses: by the next frame Return may have sent the keyboard to the page.
                requestAnimationFrame(() => {
                  if (document.activeElement === input) input.select();
                });
              }}
              onBlur={() => {
                setFocused(false);
                setHighlight(-1);
              }}
              onKeyDown={(event) => {
                if (suggestionsOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  setHighlight((at) => stepSuggestion(at, event.key === "ArrowDown" ? 1 : -1, suggestions.length));
                  return;
                }
                const row = suggestionsOpen && highlight >= 0 ? suggestions[highlight] : undefined;
                if (event.key === "Enter" && row) {
                  event.preventDefault();
                  pick(row);
                  return;
                }
                if (event.key === "Escape" && suggestionsOpen) {
                  // The first Esc closes the suggestions; the next puts the page's address back.
                  event.stopPropagation();
                  setSuggesting(false);
                  setHighlight(-1);
                  return;
                }
                if (event.key === "Escape" && typed !== null) {
                  event.stopPropagation();
                  setTyped(null);
                }
              }}
              className={cx(
                "browser-address-field h-full min-w-0 flex-1 bg-transparent px-2 text-label outline-none placeholder:text-muted-foreground",
                // Idle, the site sits in the middle; focused, the address reads from its start.
                focused ? "text-start" : "text-center",
              )}
            />
            {outside && (url || typed !== null) && (
              <TooltipIconButton
                tooltip="Open in external browser"
                size="icon-md"
                className="shrink-0 rounded-capsule @max-lg/browser-toolbar:hidden"
                // Typing goes on after the click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => openOutside(outside)}
              >
                <ArrowUpRight />
              </TooltipIconButton>
            )}
          </div>
          <AddressSuggestions
            anchor={address}
            rows={suggestions}
            open={suggestionsOpen}
            highlight={highlight}
            onPick={pick}
            onHighlight={setHighlight}
            onClose={() => setSuggesting(false)}
          />
          {/* Only over its own tab: a question waits, unanswered, while another tab is in front. */}
          <PermissionPrompt id={id} asking={active ? page?.asking : null} anchor={address} />
          <OsRefusedNotice id={id} refused={active && page?.osRefused?.origin === originOf(url) ? page?.osRefused : null} anchor={address} />
        </form>
        <ProfileButton owner={owner} tab={tab} />
        {/* shortcut: no screenshot until its section lands; it goes here. */}
        <BrowserDevButton id={id} ready={ready} />
        <BrowserOptions ready={ready} zoom={zoom} onFind={showFind} onPrint={print} onZoom={zoomTo} />
      </div>
      {finding && ready && <FindBar id={id} input={findInput} onClose={hideFind} />}
      <AgentSessionBar owner={owner} />
      {!paused && driver !== null && <AgentPill id={id} driver={driver} />}
      {paused && driver !== null && (
        <Banner
          slot="browser-paused"
          text={devtoolsOpen
            ? <>DevTools is open on this page, so <span className="font-medium">{driver}</span> is waiting. Close it to hand the page back.</>
            : signInStop
              ? <SignInStopWords stop={signInStop} driver={driver} />
              : <>You're using this page, so <span className="font-medium">{driver}</span> is waiting.</>}
        >
          <Button size="sm" disabled={devtoolsOpen} onClick={() => handBack(id, true)}>
            {signInStop && !devtoolsOpen ? "Done, hand it back" : "Continue"}
          </Button>
        </Banner>
      )}
      {signInRejected && (
        <Banner
          slot="browser-signin-rejected"
          text={<><span className="font-medium">Google refused this sign-in.</span> It decides which browsers it allows and has decided against this one. Your account and password are fine, but trying again here will probably get the same answer. Use your usual browser for this site if you need it now.</>}
          onDismiss={() => dismissSignInRejected(id)}
        >
          <Button size="sm" variant="ghost" onClick={() => openOutside("https://accounts.google.com/")}>
            Open in browser
          </Button>
        </Banner>
      )}
      <BrowserPickerBar id={id} />
      <BrowserDeviceBar id={id} />
      {page?.blocked && (
        <Banner text={<>This can't open here: <span className="text-muted-foreground">{page.blocked}</span></>} onDismiss={() => dismissBlocked(id)}>
          {webAddress(page.blocked) && (
            <Button size="sm" variant="ghost" onClick={() => page.blocked && openOutside(page.blocked)}>
              Open in browser
            </Button>
          )}
        </Banner>
      )}
      <BrowserDevFrame id={id} active={active}>
        <div ref={area} data-slot="browser-page" className="browser-device flex min-h-0 w-full flex-1">
          {!made &&
            (children ?? (
              <div className="m-auto p-6 text-center text-sm text-muted-foreground">
                <Globe aria-hidden className="mx-auto mb-3 size-6" />
                <p className="font-medium text-foreground">Start browsing</p>
                <p className="mt-1">Enter a URL to open a page</p>
              </div>
            ))}
        </div>
      </BrowserDevFrame>
    </div>
  );
}
