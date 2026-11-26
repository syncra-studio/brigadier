// The browser tool's hand in a Browser tab's page (see `browser_agent.rs`): one call reads the
// page or acts on one of its controls, and returns what came of it. It runs fresh for each call,
// keeping nothing in the page but each control's ref, so a page can't stand in for it between
// calls. The test page (fixtures/agent-browser.html) runs this same file.
//
// Ops: { kind: "read", max } -> { url, title, text }
//        (a control with no role reads as "clickable"; `handled`: where the page's own click handlers are, from the shell)
//      { kind: "click", target, declared, approved } -> { done } | { ask, url } | { error }
//      { kind: "type", target, text, submit, declared, approved } -> the same
// A password field, seen by its type, its autocomplete, its computed text security or its names, shows only as a line
// with no ref and nothing goes into it, yes or no: only the user fills those in. An action that pays, sends or signs in
// (declared by the agent), a click on a button or link named or showing Buy, Pay, Send, Delete and the like, or Enter in a field whose form's button is one, or one that enters or submits a card or a one-time code or submits a password (seen here), or any at Ask (`always`),
// returns `ask` and does nothing unless the user said yes to it on this page (`approved`: the address the yes was given at, which the app
// passes only while the tab is still on the page it was given on; `approvedFor`: what the control asked for then, none for any).
//
// With `trusted: true` (the Electron shell, in an isolated world) a click or typing isn't done here:
// it answers { point: { x, y } } for the shell to do with real input, or an error if something covers
// the control. { kind: "place", ...the click's or typing's own, typing } answers where the control is now, without scrolling, or an
// error or `ask` as the click or typing would, and for typing refuses a field that lost the focus. With `isolated: true` it runs in a world of its own: refs are kept there, not
// in the page's DOM, where the page could see or forge them. { kind: "void" } forgets them.
// { kind: "sweep" } answers every password field's place and value, for the shell's own use: it never reaches an agent.
// `waits: true` (a click, typing, hover, or press with a target, the first look and place) answers { error, waits, modals, page } instead
// where waiting may change it, with nothing done: `waits` is what for, `modals` the dialogs over the page, `page` the document. With
// `still: true` it does nothing at all: a promise of such a refusal, any other, or { still: true, modals, page } where a click or a hover's
// control isn't moving over two frames, and typing's or a press's may go on, with the dialogs there were `before`. With `page` it answers only in that document.
// `shownUrl`: an address as an agent sees it, from the shell.
(op, shownUrl = (url) => url) => {
  const REF = "data-brigadier-ref";
  const NEXT = "data-brigadier-next-ref";
  const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
  const cut = (text, most = 80) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
  const quoted = (text) => JSON.stringify(cut(clean(text)));

  const boxed = (element) => {
    if (element.checkVisibility) return element.checkVisibility({ visibilityProperty: true });
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  // A display: contents wrapper has no box of its own: what it holds shows or not by itself.
  const shown = (element) => boxed(element) || getComputedStyle(element).display === "contents";

  const INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", file: "button", color: "button",
  };
  const ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton",
    "treeitem",
  ]);

  /** The control's role, or null for anything that isn't one. */
  const roleOf = (element) => {
    const role = (element.getAttribute("role") || "").split(" ")[0];
    if (ROLES.has(role)) return role;
    switch (element.localName) {
      case "a": return element.hasAttribute("href") ? "link" : null;
      case "button": case "summary": return "button";
      case "select": return "combobox";
      case "textarea": return "textbox";
      case "iframe": return "frame";
      case "input": {
        if (element.type === "hidden") return null;
        return INPUT_ROLES[element.type] || "textbox";
      }
      default:
        return element.isContentEditable && !element.parentElement?.isContentEditable ? "textbox" : null;
    }
  };

  const pointer = (element) => element && getComputedStyle(element).cursor === "pointer";
  const around = (element) => element.parentElement || element.getRootNode().host || null;
  /**
   * A control with no role of its own, as a card that opens a page: it takes the hand cursor, not from what holds it, or
   * has a click handler the page set on it. The page's handlers are out of this world's sight, so the shell looks for
   * them in the page's and hands over where they are (`op.handled`, places in document order), kept until it does again.
   */
  if (op.handled) {
    const all = document.getElementsByTagName("*");
    window.__brigadierHandled = new WeakSet(op.handled.map((at) => all[at]).filter(Boolean));
  }
  const handled = () => (window.__brigadierHandled ??= new WeakSet());
  const isClickable = (element) => {
    if (roleOf(element) || element === document.body || element === document.documentElement) return false;
    // A label's click is its control's, which has a ref.
    if (element.localName === "label" && element.control) return false;
    return element.hasAttribute("onclick") || handled().has(element) || (pointer(element) && !pointer(around(element)));
  };
  /** The role a control answers to: its own, or that it can only be clicked. */
  const controlOf = (element) => roleOf(element) || (isClickable(element) ? "clickable" : null);

  const labelled = (element) => {
    const ids = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    return ids.map((id) => element.getRootNode().getElementById?.(id)?.textContent || "").join(" ");
  };

  /** The control's name, as a screen reader would say it. */
  const nameOf = (element) => {
    const candidates = [
      element.getAttribute("aria-label"),
      labelled(element),
      element.labels?.[0]?.innerText,
      element.localName === "input" && ["button", "submit", "reset"].includes(element.type) ? element.value : "",
      element.localName === "iframe" ? element.title : "",
      element.localName === "textarea" || element.localName === "input" || element.isContentEditable ? "" : element.innerText,
      element.getAttribute("placeholder"),
      element.getAttribute("alt"),
      element.querySelector?.("img[alt]")?.getAttribute("alt"),
      element.getAttribute("title"),
    ];
    for (const candidate of candidates) {
      const name = clean(candidate);
      if (name) return name;
    }
    return "";
  };

  /** Fields that were password fields once, in this world: a "show password" toggle changes nothing. */
  const wasPassword = () => (window.__brigadierPasswordFields ??= new WeakSet());

  /** What kind of private thing a field takes: a password, a card or a one-time code. */
  const fieldKind = (element) => {
    if (!element?.getAttribute) return null;
    const editable = element.isContentEditable;
    const field = ["input", "textarea"].includes(element.localName);
    if (!field && !editable) return null;
    if (op.isolated && wasPassword().has(element)) return "credentials";
    const auto = (element.getAttribute("autocomplete") || "").toLowerCase();
    const hint = [element.name, element.id, element.getAttribute("aria-label"), element.placeholder, element.labels?.[0]?.innerText]
      .join(" ").toLowerCase();
    const password = () => {
      if (op.isolated) wasPassword().add(element);
      return "credentials";
    };
    if (element.type === "password" || /\b(current|new)-password\b/.test(auto)) return password();
    // A text field disguised as a password field.
    if ((getComputedStyle(element).webkitTextSecurity || "none") !== "none") return password();
    if (!field) return null;
    if (/\bcc-(number|csc|exp|exp-month|exp-year)\b/.test(auto) ||
        /card.?number|\bcc.?num|\bcvc\b|\bcvv\b|\bcsc\b|security code|expiry|expiration/.test(hint)) return "card";
    if (/\bone-time-code\b/.test(auto) ||
        /\botp\b|one.?time|verification code|2fa|two.?factor|auth(entication)? code/.test(hint)) return "oneTimeCode";
    if (["", "text", "search"].includes(element.getAttribute("type") ?? "") && /pass(word|wd|phrase|code)|pwd/.test(hint)) return password();
    return null;
  };

  /** What a button or link named so does, as the user would ask about it: pay, send or delete. */
  const namedKind = (name) =>
    /\b(buy|pay|purchase|checkout|check out|place order|order now|subscribe)\b/i.test(name) ? "pay"
      : /\bsend\b/i.test(name) ? "send"
      : /\b(delete|remove|erase|destroy)\b/i.test(name) ? "delete" : null;

  /** The most of what a control draws that counts as its words, as of a name shown: a card's paragraph doesn't. */
  const MOST_WORDS = 80;

  /**
   * The words a control draws, whatever its label says: its text, whole, and each picture's, button's and tooltip's. Its
   * text is read as its name's is, hidden by opacity or for screen readers too, and without that, so such text can't
   * make what's seen too long. Never what another control in it draws, unless that takes the control's own click.
   */
  const drawnIn = (control) => {
    const texts = [];
    const marks = [];
    let size = 0;
    const box = control.getBoundingClientRect();
    const another = (element) => {
      const role = roleOf(element);
      if (!role && !element.hasAttribute("onclick") && !handled().has(element)) return false;
      const own = element.getBoundingClientRect();
      const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
      const middle = own.left <= x && x <= own.right && own.top <= y && y <= own.bottom;
      return !middle || (role && getComputedStyle(element).pointerEvents !== "none");
    };
    const walk = (element, outer) => {
      if (element !== control && another(element)) return;
      if (element.localName === "title") marks.push(element.textContent);
      const style = getComputedStyle(element);
      if (!element.checkVisibility() && style.display !== "contents") return;
      const drawn = style.visibility === "visible";
      const rect = element.getBoundingClientRect();
      const clipped = style.overflow !== "visible" && style.display !== "contents" && (rect.width <= 1 || rect.height <= 1);
      const seen = outer && style.opacity !== "0" && !clipped;
      if (drawn) {
        marks.push(element.getAttribute("alt"), element.getAttribute("title"));
        if (element.localName === "input" && ["button", "submit", "reset"].includes(element.type)) marks.push(element.value);
        if (element.localName === "svg" || element.getAttribute("role") === "img") marks.push(element.getAttribute("aria-label"));
      }
      const slotted = element.localName === "slot" ? element.assignedNodes({ flatten: true }) : [];
      for (const child of slotted.length ? slotted : (element.shadowRoot ?? element).childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) walk(child, seen);
        else if (child.nodeType === Node.TEXT_NODE && drawn) {
          texts.push({ text: child.data, seen });
          if (seen) size += clean(child.data).length;
        }
        if (size > MOST_WORDS) return;
      }
    };
    walk(control, true);
    if (size > MOST_WORDS) return [];
    // Words split over elements read as one where the page draws them so.
    const whole = [texts.filter((each) => each.seen), texts].flatMap((some) => [" ", ""].map((by) => some.map((each) => each.text).join(by)));
    return [...whole, ...marks].map(clean).filter((words) => words && words.length <= MOST_WORDS);
  };

  /** What a control's name and the words it draws say it does, paying first, and those words where its name doesn't say it. */
  const saidBy = (element) => {
    const named = namedKind(nameOf(element));
    const drawn = drawnIn(element).map((words) => ({ kind: namedKind(words), words })).filter(({ kind }) => kind && kind !== named);
    const kinds = ["pay", "send", "delete"].filter((kind) => kind === named || drawn.some((each) => each.kind === kind));
    return { kinds, words: drawn.find((each) => each.kind === kinds.find((kind) => kind !== named))?.words };
  };

  const isPassword = (element) => fieldKind(element) === "credentials";
  const HANDS_OFF = "That is a password field, and only the user fills those in, so nothing was done. Ask them to sign in in this tab, and go on when they say so.";

  /** The private kind a filled field of `scope` holds (`also` counts as filled), if any. */
  const filledKind = (scope, also) => {
    for (const field of scope.querySelectorAll("input, textarea")) {
      const kind = fieldKind(field);
      if (kind && (field === also || field.value)) return kind;
    }
    return null;
  };

  /** What a control submits with: its form, else the nearest few levels around it. */
  const scopeOf = (element) => {
    const form = element.form || element.closest("form");
    if (form) return form;
    let around = element.parentElement;
    for (let level = 0; around && level < 4; level++, around = around.parentElement) {
      if (filledKind(around)) return around;
    }
    return element.parentElement || document;
  };

  /** Every element under `root`, open shadow roots included, in document order. */
  const each = function* (root) {
    for (const child of root.children) {
      yield child;
      if (child.shadowRoot) yield* each(child.shadowRoot);
      yield* each(child);
    }
  };

  const refs = () => (window.__brigadierRefs ??= { next: 1, byRef: new Map(), of: new WeakMap() });

  const find = (ref) => {
    if (op.isolated) return refs().byRef.get(ref)?.deref() ?? null;
    for (const element of each(document)) if (element.getAttribute(REF) === ref) return element;
    return null;
  };

  const refOf = (element) => {
    if (op.isolated) {
      const store = refs();
      let own = store.of.get(element);
      if (!own) {
        own = `e${store.next++}`;
        store.of.set(element, own);
        store.byRef.set(own, new WeakRef(element));
      }
      return own;
    }
    let ref = element.getAttribute(REF);
    if (ref) return ref;
    const root = document.documentElement;
    const next = Number(root.getAttribute(NEXT)) || 1;
    root.setAttribute(NEXT, String(next + 1));
    ref = `e${next}`;
    element.setAttribute(REF, ref);
    return ref;
  };

  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link"]);
  const BLOCK = /^(address|article|aside|blockquote|br|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/;

  const read = (most) => {
    const lines = [];
    let line = "";
    const flush = () => {
      const text = clean(line);
      if (text) lines.push(text);
      line = "";
    };
    const describe = (element, role) => {
      let text = `[${refOf(element)}] ${role} ${quoted(nameOf(element))}`;
      if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "slider" || role === "spinbutton") {
        const value = element.isContentEditable ? element.innerText
          : element.localName === "select" ? element.selectedOptions?.[0]?.text : element.value;
        // A card number or code is never read out, only whether it is filled.
        if (fieldKind(element)) text += value ? " (filled)" : "";
        else if (value) text += ` value=${quoted(value)}`;
        if (element.localName === "select") {
          const options = [...element.options].slice(0, 12).map((option) => clean(option.text));
          text += ` options=${JSON.stringify(options)}`;
        }
      }
      if (role === "checkbox" || role === "radio" || role === "switch") {
        const on = element.checked ?? element.getAttribute("aria-checked") === "true";
        text += on ? " (checked)" : " (not checked)";
      }
      if (role === "link") {
        const href = element.getAttribute("href") || "";
        if (href && !href.startsWith("javascript:")) text += ` -> ${cut(shownUrl(URL.parse(href, document.baseURI)?.href ?? href), 100)}`;
      }
      if (element.disabled || element.getAttribute("aria-disabled") === "true") text += " (disabled)";
      const kind = fieldKind(element);
      if (kind) text += ` (${kind === "card" ? "card" : "one-time code"} field)`;
      return text;
    };
    // A label's own text is its control's name, read with the control.
    // A display: contents wrapper passes `shown` with no box: its own text shows only while it's
    // visible (its elements check their own).
    const walk = (node, labelling = false) => {
      const quiet = labelling || (node.nodeType === Node.ELEMENT_NODE &&
        getComputedStyle(node).display === "contents" && getComputedStyle(node).visibility !== "visible");
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (!quiet) line += ` ${child.textContent}`;
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.localName;
        if (SKIP.has(tag) || !shown(child)) continue;
        const role = roleOf(child);
        if (role) {
          flush();
          // Nothing of a password field but that it is there: no ref to use, no name or value.
          lines.push(isPassword(child) ? "(A password field, hidden: only the user fills it in.)" : describe(child, role));
          continue;
        }
        const block = BLOCK.test(tag);
        if (block) flush();
        // What it holds is read too: a card's own buttons are controls of theirs.
        if (!labelling && isClickable(child)) {
          flush();
          lines.push(describe(child, "clickable"));
        }
        const heading = /^h[1-6]$/.test(tag) && !child.querySelector("a, button, input");
        if (heading) {
          lines.push(`${"#".repeat(Number(tag[1]))} ${clean(child.innerText)}`);
          continue;
        }
        if (tag === "img" && child.alt) line += ` [image: ${cut(clean(child.alt))}]`;
        walk(child, labelling || (tag === "label" && child.control !== null && child.contains(child.control)));
        if (child.shadowRoot) walk(child.shadowRoot);
        if (block) flush();
      }
    };
    if (document.body) walk(document.body);
    flush();
    let text = lines.join("\n");
    if (text.length > most) {
      const rest = text.length - most;
      text = `${text.slice(0, most)}\n(The page goes on: ${rest} more characters not shown.)`;
    }
    return { url: location.href, title: document.title, text };
  };

  /** What has the focus, through open shadow roots. */
  const deepFocused = () => {
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    return focused;
  };

  const target = () => {
    const element = find(op.target);
    if (!element || !element.isConnected) {
      return { error: `There is no ${op.target} on the page now: read it again for its controls' refs.` };
    }
    return { element };
  };

  /** The dialogs over the page. */
  const modals = () => [...document.querySelectorAll("dialog:modal, [aria-modal='true']")].filter(boxed).map(refOf);
  /** Which document this is: a ref means nothing in another, which may have its own of that name. */
  const page = performance.timeOrigin;
  /** A refusal that waiting may change. */
  const later = (error, waits) => (op.waits ? { error, waits, modals: modals(), page } : { error });
  /** Takes no input, by its own attribute, its fieldset's, or an aria-disabled on it or around it. */
  const disabled = (element) => {
    for (let at = element; at; at = around(at)) if (at.getAttribute("aria-disabled") === "true") return true;
    return Boolean(element.disabled) || element.matches(":disabled");
  };
  /** What keeps a control from being used that may pass: it doesn't show, or it's disabled. */
  const unready = (element, words = `${op.target} is disabled.`) =>
    !shown(element) ? later(`${op.target} doesn't show now.`, "it to show")
      : disabled(element) ? later(words, "it to be enabled") : null;

  /** The next frame; nothing where none comes within `most` ms. */
  const frame = (most) => new Promise((next) => {
    requestAnimationFrame(next);
    setTimeout(next, most);
  });
  /** Whether it, or what it's in, has an animation that never ends: its box never will be the same. */
  const endless = (element) => {
    for (let at = element; at; at = around(at)) if (at.getAnimations().some((each) => each.effect?.getComputedTiming().iterations === Infinity)) return true;
    return false;
  };
  /** Whether the control's box changes. One that pulses for ever about its middle is where its click goes all along. */
  const moves = async (element) => {
    // Nothing moves by frames on a page that's hidden, and its timers are held back; the pointer's own look is after it paints.
    if (document.hidden) return false;
    for (let from = element.getBoundingClientRect(), frames = 0; frames < 2; frames++) {
      // None in two frames' time: the page doesn't paint, so nothing moves. Once it does, a late frame is waited for.
      if (!(await frame(frames ? 100 : 33))) return false;
      const to = element.getBoundingClientRect();
      const changed = (side) => Math.abs(to[side] - from[side]) > 0.5;
      if (["left", "top", "right", "bottom"].some(changed)) {
        const off = Math.abs(to.left + to.right - from.left - from.right) > 1 || Math.abs(to.top + to.bottom - from.top - from.bottom) > 1;
        if (off || Math.min(from.width, from.height, to.width, to.height) < 1 || !endless(element)) return true;
      }
      from = to;
    }
    return false;
  };
  const refused = (error) => ({ error: `The page refused it: ${error && error.message ? error.message : String(error)}` });
  /** What `verb` does, or, for the look before it, whether what `stop` has nothing against is still. */
  const still = (verb, ...stops) => {
    if (!op.still) return verb();
    const before = modals();
    const look = async () => {
      const found = target();
      if (found.error) return found;
      const answers = stops.map((stop) => stop(found.element)).filter((answer) => answer && !answer.point);
      // What no waiting changes is said at once, whatever else it would wait for.
      const stopped = answers.find((answer) => !answer.waits) ?? answers[0];
      if (stopped) return stopped;
      // Keys go in wherever a field is.
      const placed = op.kind === "click" || op.kind === "hover";
      if (placed && (await moves(found.element))) return later(op.kind === "click" ? `${op.target} keeps moving, so it wasn't clicked. Try again in a moment.` : `${op.target} keeps moving, so nothing was done.`, "it to stop moving");
      return { still: true, modals: modals(), page };
    };
    return look().catch(refused).then((answer) => ({ ...answer, before }));
  };

  /** Asks the user first, unless their yes covers every one of `reasons`: why, and the control as the page names it, with the `words` it draws that ask. */
  const ask = (reasons, element, words) => {
    const needed = reasons.filter(Boolean);
    // The yes was for this page, at this address, and for what the control was then: not for what it became. One for the
    // session covers no paying, card, password, code or sign-in.
    const yes = op.approved && op.approved === location.href;
    const covers = (each) => (op.covered ? ["action", "delete", "send", "script"].includes(each) : each === "action" || !op.approvedFor || op.approvedFor.includes(each));
    const sensitive = needed.find((each) => !yes || !covers(each));
    if (!sensitive) return null;
    const what = `${controlOf(element) || element.localName} ${quoted(nameOf(element))}${words ? `, which shows ${quoted(words)}` : ""}`;
    return { ask: { sensitive, reasons: needed, what }, url: location.href };
  };

  /** What a click on the control is refused or asked for, as it is now. */
  const clickStop = (element) => {
    if (isPassword(element)) return { error: HANDS_OFF };
    // A control with no role acts as a button does, whatever it's made of, so it asks as one.
    const role = controlOf(element) || "clickable";
    const kind = role === "button" || role === "clickable" ? filledKind(scopeOf(element)) : null;
    const said = role === "button" || role === "link" || role === "clickable" ? saidBy(element) : null;
    return ask([op.declared, kind, ...(said?.kinds ?? []), op.always && "action"], element, said?.words) ?? unready(element);
  };

  /** What Enter in a field presses, as its click would say: its form's default button, else the first button it submits with. */
  const submitKinds = (element) => {
    const form = element.form || element.closest("form");
    const button = form ? [...form.elements].find((each) => each.type === "submit" || each.type === "image")
      : scopeOf(element).querySelector("button, input[type=submit], input[type=image], [role=button]");
    return button ? saidBy(button).kinds : [];
  };

  /** What typing in the field asks for, as it is now: a card or code field as what it is, whatever the agent declared, so the card never shows the secret typed into it. */
  const typeAsk = (element) => {
    const own = fieldKind(element);
    const submits = op.submit ? submitKinds(element) : [];
    return ask([own, op.declared, own || (op.submit ? filledKind(scopeOf(element), element) : null), ...submits, op.always && "action"], element);
  };

  const point = (element, type) => {
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    };
    const Kind = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
    return element.dispatchEvent(new Kind(type, { ...init, pointerType: "mouse", isPrimary: true }));
  };

  /** The element at a point of the page, through open shadow roots. */
  const deepest = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const within = (outer, inner) => {
    for (let at = inner; at; at = at.parentNode || at.host) if (at === outer) return true;
    return false;
  };

  const FRAMES = new Set(["iframe", "frame", "fencedframe", "object", "embed"]);
  /** Where real input reaches the control, or what is over it; null when it has no place to click. */
  const placeOf = (element) => {
    const rects = element.getClientRects();
    const rect = rects.length ? rects[0] : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    const hit = deepest(x, y);
    const label = hit?.closest?.("label");
    if (hit && !within(element, hit) && !within(hit, element) && !label?.contains(element) && label?.control !== element) {
      const role = controlOf(hit);
      return later(`${op.target} is covered by ${role || hit.localName} ${quoted(nameOf(hit) || hit.innerText || "")}: deal with that first.`, "what covers it to go");
    }
    const hovering = op.kind === "hover";
    // What a frame holds can't be seen here, and the click would be its.
    if (!hovering && hit && hit !== element && FRAMES.has(hit.localName)) {
      return { error: `${op.target}'s middle is a frame, which agents can't see into, so nothing was clicked: use another control, or ask the user.` };
    }
    const roled = roleOf(element);
    let depth = 1;
    if (!roled || within(element, hit)) {
      // A card's middle may be a control it holds, whose click is another. One with a role is read with no refs for what it holds, so there it asks.
      for (let at = hit; at && at !== element; at = around(at), depth++) {
        const role = controlOf(at);
        if (role && !roled) return { error: `${op.target}'s middle is its ${role} ${quoted(nameOf(at))}, so clicking it would click that: use that one's own ref.` };
        // A handler set with addEventListener can't be seen: what is named as a sensitive control may be one, so it asks.
        const said = !hovering && (role || !roled) && within(element, at) ? saidBy(at) : null;
        const asked = said && ask(said.kinds, at, said.words);
        if (asked) return asked;
      }
    }
    // `depth`: how many elements up from the middle the control is, for the shell's look for closed shadow roots.
    return { point: { x, y, depth: within(element, hit) ? depth : 1 } };
  };

  const click = () => {
    const found = target();
    if (found.error) return found;
    const { element } = found;
    const stop = clickStop(element);
    if (stop) return stop;
    if (op.trusted) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      // With no box it only takes the page's own click below.
      const place = placeOf(element);
      if (place) return place;
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    point(element, "pointerdown");
    point(element, "mousedown");
    element.focus?.({ preventScroll: true });
    point(element, "pointerup");
    point(element, "mouseup");
    element.click();
    return { done: true };
  };

  const NO_KEYBOARD = `${op.target} can't take the keyboard: click it, or press without --ref.`;

  /**
   * Where a press's key goes, looked at first: never a password field or a frame we can't see into, and Enter or
   * Space on a sensitive control asks as its click or submit would.
   */
  const pressStop = (element) => {
    if (isPassword(element) || isPassword(deepFocused())) return { error: HANDS_OFF };
    if (element.localName === "iframe" || element.localName === "frame") return { error: "The focus is inside a frame, which agents can't see into, so no key was sent." };
    const role = element === document.body ? null : controlOf(element);
    const activates = op.key === "Enter" || op.key === "Space";
    let kind = null;
    let said = null;
    if (activates && (role === "button" || role === "link" || role === "clickable")) {
      kind = role === "button" || role === "clickable" ? filledKind(scopeOf(element)) : null;
      said = saidBy(element);
    } else if (op.key === "Enter" && element !== document.body) {
      kind = fieldKind(element) || filledKind(scopeOf(element), element);
      // Shift+Enter in a text area is a new line; a plain Enter there may send, as a composer's does by its script.
      const newline = op.modifiers?.includes("shift") && (element.localName === "textarea" || element.isContentEditable);
      said = { kinds: newline ? [] : submitKinds(element) };
    } else if (op.key !== "Tab" && op.key !== "Escape") {
      // A key into a card or code field asks as typing there does: presses mustn't fill it by the character.
      kind = fieldKind(element);
    }
    return ask([op.declared, kind, ...(said?.kinds ?? []), op.always && "action"], element, said?.words) ?? (op.target ? unready(element, NO_KEYBOARD) : null);
  };

  /** With a ref, that control takes the focus. */
  const press = () => {
    let element;
    if (op.target) {
      const found = target();
      if (found.error) return found;
      element = found.element;
    } else element = deepFocused() || document.body;
    const stop = pressStop(element);
    if (stop) return stop;
    if (op.target) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      element.focus?.({ preventScroll: true });
      const focused = deepFocused();
      if (!focused || !within(element, focused)) return { error: NO_KEYBOARD };
      // Its focus handler may have made it a password field meanwhile.
      if (isPassword(element) || isPassword(focused)) return { error: HANDS_OFF };
    }
    return { done: true };
  };

  const setValue = (element, value) => {
    const proto = element.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  };

  const key = (element, type) =>
    element.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true,
    }));

  const typeStop = (element) => {
    if (isPassword(element)) return { error: HANDS_OFF };
    const role = roleOf(element);
    if (!["textbox", "searchbox", "combobox", "spinbutton"].includes(role)) {
      return { error: `${op.target} isn't a field to type in (it is a ${role || element.localName}).` };
    }
    const asked = typeAsk(element);
    if (asked) return asked;
    if (disabled(element) || element.readOnly || element.getAttribute("aria-readonly") === "true") return later(`${op.target} can't be typed in now.`, "it to be editable");
    return unready(element);
  };

  const type = () => {
    const found = target();
    if (found.error) return found;
    const { element } = found;
    const stop = typeStop(element);
    if (stop) return stop;
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    element.focus({ preventScroll: true });
    if (element.localName === "select") {
      const wanted = clean(op.text).toLowerCase();
      const option = [...element.options].find((each) => clean(each.text).toLowerCase() === wanted || each.value === op.text);
      if (!option) return { error: `${op.target} has no option ${quoted(op.text)}.` };
      element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (op.trusted && op.text) {
      // Only where it is: the cursor goes there first, then { kind: "insert" }.
      const rect = element.getBoundingClientRect();
      return { point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
    } else if (element.isContentEditable) {
      document.getSelection()?.selectAllChildren(element);
      document.execCommand("insertText", false, op.text);
    } else {
      setValue(element, op.text);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: op.text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (op.submit) {
      const going = key(element, "keydown");
      key(element, "keypress");
      key(element, "keyup");
      const form = element.form;
      if (going && form && element.localName !== "textarea") form.requestSubmit();
    }
    return { done: true };
  };

  const hover = () => {
    const found = target();
    if (found.error) return found;
    found.element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return placeOf(found.element) ?? later(`${op.target} has no place to hover now.`, "it to show");
  };

  /** What an agent's script gave, as text: JSON where it can be, never a field's live value unless the script read one. */
  const evalAnswer = (value) => {
    const seen = new WeakSet();
    const outline = (node) => `<${node.localName}${node.id ? `#${node.id}` : ""}>`;
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return `${item}n`;
      if (typeof item === "function") return `(function ${item.name})`;
      if (typeof item === "symbol") return String(item);
      if (item instanceof Element) return outline(item);
      if (item instanceof Error) return `${item.name}: ${item.message}`;
      if (item && typeof item === "object") {
        if (seen.has(item)) return "(seen above)";
        seen.add(item);
        if (item instanceof Map) return Object.fromEntries(item);
        if (item instanceof Set) return [...item];
      }
      return item;
    }, 2);
    return { text: typeof value === "string" ? value : json === undefined ? String(value) : json };
  };

  /** A picked element for the chat: what it is and where, never what a field holds. The shell scrubs this too. */
  const describe = (element) => {
    const password = isPassword(element);
    const field = element.localName === "input" || element.localName === "textarea" || element.localName === "select" || element.isContentEditable;
    const attrs = {};
    for (const { name, value } of element.attributes) {
      if (name === "value" || name === "style" || name.startsWith("on")) continue;
      if (password && !["type", "id", "name", "autocomplete"].includes(name)) continue;
      attrs[name] = cut(value, 200);
    }
    const piece = (node) => {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && node.getRootNode().querySelectorAll(`#${node.id}`).length === 1) return `#${node.id}`;
      const siblings = node.parentElement ? [...node.parentElement.children].filter((other) => other.localName === node.localName) : [];
      return siblings.length > 1 ? `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})` : node.localName;
    };
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node.localName !== "html"; node = node.parentElement) {
      parts.unshift(piece(node));
      if (parts[0].startsWith("#")) break;
    }
    const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
    let component = null;
    for (let fiber = fiberKey ? element[fiberKey] : null; fiber && !component; fiber = fiber.return) {
      if (typeof fiber.type === "function") component = fiber.type.displayName || fiber.type.name || null;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const styles = {};
    for (const name of ["display", "position", "color", "background-color", "font-size", "font-family", "margin", "padding", "border-radius"]) styles[name] = style.getPropertyValue(name);
    return {
      url: location.href,
      selector: parts.join(" > "),
      tag: element.localName,
      attrs,
      text: field ? "" : cut(clean(element.innerText || element.textContent), 400),
      password,
      component,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles,
    };
  };

  try {
    if (op.page && op.page !== page) return { error: "The page went to another before its control was ready, so nothing was done. Read it again." };
    switch (op.kind) {
      case "read": return read(op.max || 20000);
      case "click": return still(click, clickStop, placeOf);
      case "type": return still(type, typeStop);
      case "sweep": {
        const answer = { fields: [], values: [], width: innerWidth, frames: [] };
        const plain = (rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
        for (const element of each(document)) {
          if (element.localName === "iframe") {
            let origin = location.origin;
            try {
              if (element.getAttribute("src")) origin = new URL(element.src).origin;
            } catch { /* The page's own, then. */ }
            answer.frames.push({ origin: origin === "null" ? location.origin : origin, rect: plain(element.getBoundingClientRect()) });
          }
          if (!isPassword(element)) continue;
          const value = element.isContentEditable ? element.innerText : element.value;
          if (value) answer.values.push(value);
          for (const rect of element.getClientRects()) answer.fields.push(plain(rect));
        }
        return answer;
      }
      case "press": return still(press, pressStop);
      case "hover": return still(hover);
      case "scroll": {
        if (op.target) {
          const found = target();
          if (found.error) return found;
          found.element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          return { done: true };
        }
        const step = Math.round(innerHeight * 0.8) * (op.way === "up" ? -1 : 1);
        return { point: { x: innerWidth / 2, y: innerHeight / 2 }, scroll: step };
      }
      case "evalAnswer": return evalAnswer(op.value);
      case "describe": return describe(op.element);
      case "void":
        window.__brigadierRefs = undefined;
        return { done: true };
      case "insert": {
        // The page's own editing, which needs no window focus: a debugger's insertText is routed by the window's.
        const found = target();
        if (found.error) return found;
        const { element } = found;
        // Looked at again right before: the page may have made it one, or moved the focus to one.
        const focused = deepFocused();
        if (isPassword(element) || isPassword(focused)) return { error: HANDS_OFF };
        if (element.isContentEditable) document.getSelection()?.selectAllChildren(element);
        else element.select?.();
        if (!document.execCommand("insertText", false, op.text)) {
          setValue(element, op.text);
          element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: op.text }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { done: true };
      }
      case "place": {
        const found = target();
        if (found.error) return found;
        if (op.typing) {
          const focused = deepFocused();
          if (isPassword(found.element) || isPassword(focused)) return { error: HANDS_OFF };
          if (!focused || !within(found.element, focused)) return { error: `The page moved the focus away from ${op.target}, so nothing was typed. Read it again.` };
          return typeAsk(found.element) ?? { done: true };
        }
        // The control may have become another under the pointer: it's asked about again, as it is now.
        return clickStop(found.element) ?? placeOf(found.element) ?? later(`${op.target} has no place to click now.`, "it to show");
      }
      default: return { error: `unknown op ${op.kind}` };
    }
  } catch (error) {
    return refused(error);
  }
}
