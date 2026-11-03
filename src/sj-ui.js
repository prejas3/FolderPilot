// SJ Utility UI 1.0 (2026-11-02): select, tooltip, dialog, flyout, menu. Pairs with sj-ui.css.
// FolderPilot 0.2 copy: unchanged from Clickloom 0.3.1.
// Copied from Netlume 0.2.1; Clickloom adds flyout() and menu() (spec 6, Menu / flyout).

/** Where a popup for `el` goes: inside its modal dialog when it has one (a modal makes the rest
 * of the page inert and paints over it), else the body.
 * @param {Element} el @returns {HTMLElement} */
const layerOf = (el) => /** @type {HTMLElement} */ (el.closest("dialog[open]") ?? document.body);

const chevron = `<svg class="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M2.14645 4.64645C2.34171 4.45118 2.65829 4.45118 2.85355 4.64645L6 7.79289L9.14645 4.64645C9.34171 4.45118 9.65829 4.45118 9.85355 4.64645C10.0488 4.84171 10.0488 5.15829 9.85355 5.35355L6.35355 8.85355C6.15829 9.04882 5.84171 9.04882 5.64645 8.85355L2.14645 5.35355C1.95118 5.15829 1.95118 4.84171 2.14645 4.64645Z"/></svg>`; // Fluent UI System Icons, MIT

/** ComboBox: a button whose listbox flyout opens with the chosen option over the field.
 * @param {{ options: {value: string, label: string}[], value: string, label: string, onChange: (value: string) => void }} config
 * @returns {HTMLButtonElement & { value: string }} */
export function select({ options, value, label, onChange }) {
  const button = /** @type {any} */ (document.createElement("button"));
  button.type = "button"; button.className = "btn select";
  button.setAttribute("aria-haspopup", "listbox"); button.setAttribute("aria-label", label);
  const render = () => {
    button.innerHTML = `<span></span>${chevron}`;
    button.firstElementChild.textContent = options.find((o) => o.value === button.value)?.label ?? "";
  };
  button.value = value; render();
  button.addEventListener("click", () => openList());
  button.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openList(); }
  });

  function openList() {
    const list = document.createElement("div");
    list.className = "flyout"; list.setAttribute("role", "listbox"); list.tabIndex = -1;
    list.setAttribute("aria-label", label);
    let active = Math.max(0, options.findIndex((o) => o.value === button.value));
    const items = options.map((o, i) => {
      const item = document.createElement("div");
      item.setAttribute("role", "option"); item.id = `sj-opt-${i}`; item.textContent = o.label;
      item.setAttribute("aria-selected", String(o.value === button.value));
      item.addEventListener("click", () => choose(i));
      item.addEventListener("pointermove", () => mark(i));
      return item;
    });
    list.append(...items); layerOf(button).append(list);
    const box = button.getBoundingClientRect();
    list.style.minWidth = `${box.width}px`;
    list.style.left = `${Math.min(box.left, innerWidth - list.offsetWidth - 8)}px`;
    // A long list fits the window and scrolls; the chosen option still opens over the field where it can.
    list.style.maxHeight = `${innerHeight - 16}px`;
    const want = box.top - items[active].offsetTop - 1 + (box.height - items[active].offsetHeight) / 2;
    const top = Math.max(8, Math.min(want, innerHeight - list.offsetHeight - 8));
    list.style.top = `${top}px`;
    list.scrollTop = top - want;
    mark(active); list.focus();

    function mark(i) {
      active = i; items.forEach((item, n) => item.classList.toggle("is-active", n === i));
      list.setAttribute("aria-activedescendant", items[i].id);
      items[i].scrollIntoView({ block: "nearest" });
    }
    let open = true;
    // Removing the focused list fires focusout, which calls close() again: run once.
    function close() {
      if (!open) return; open = false;
      removeEventListener("pointerdown", outside, true); list.remove(); button.focus();
    }
    function choose(i) {
      close();
      if (options[i].value !== button.value) { button.value = options[i].value; render(); onChange(button.value); }
    }
    /** @param {PointerEvent} e */
    function outside(e) { if (!list.contains(/** @type {Node} */ (e.target))) close(); }
    addEventListener("pointerdown", outside, true);
    list.addEventListener("focusout", (e) => { if (!list.contains(/** @type {Node} */ (e.relatedTarget))) close(); });
    list.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") mark(Math.min(items.length - 1, active + 1));
      else if (e.key === "ArrowUp") mark(Math.max(0, active - 1));
      else if (e.key === "Home") mark(0);
      else if (e.key === "End") mark(items.length - 1);
      else if (e.key === "Enter" || e.key === " ") choose(active);
      else if (e.key === "Escape" || e.key === "Tab") close();
      else return;
      e.preventDefault(); e.stopPropagation();
    });
  }
  return button;
}

/** Tooltips for every [data-tip] element: ~700 ms on hover, at once on keyboard focus. */
export function tooltips() {
  /** @type {HTMLDivElement | null} */ let tip = null; let timer = 0;
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; };
  /** @param {HTMLElement} el */
  const show = (el) => {
    hide(); tip = document.createElement("div"); tip.className = "tip"; tip.setAttribute("role", "tooltip");
    tip.textContent = el.dataset.tip ?? ""; layerOf(el).append(tip);
    const box = el.getBoundingClientRect();
    const below = box.bottom + 4 + tip.offsetHeight < innerHeight;
    tip.style.top = `${below ? box.bottom + 4 : box.top - tip.offsetHeight - 4}px`;
    tip.style.left = `${Math.max(8, Math.min(box.left + (box.width - tip.offsetWidth) / 2, innerWidth - tip.offsetWidth - 8))}px`;
  };
  /** @param {Event} e */
  const target = (e) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.("[data-tip]"));
  document.addEventListener("pointerover", (e) => {
    const el = target(e); if (!el) return;
    clearTimeout(timer); timer = window.setTimeout(() => show(el), 700);
  });
  document.addEventListener("pointerout", (e) => { if (target(e)) hide(); });
  document.addEventListener("focusin", (e) => {
    const el = target(e); if (el?.matches(":focus-visible")) show(el); else hide();
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}

/** Modal dialog: title (Subtitle), body, footer buttons (accent first). Esc closes; the dialog
 * is removed on close. An action returning false keeps it open.
 * @param {{ title: string, body: HTMLElement, actions: {label: string, accent?: boolean, run?: () => (boolean | void | Promise<boolean | void>)}[] }} config */
export function dialog({ title, body, actions }) {
  const d = document.createElement("dialog");
  d.className = "dialog"; d.setAttribute("aria-label", title);
  d.innerHTML = `<div class="dialog-body"><h2 class="t-subtitle"></h2></div><div class="dialog-foot"></div>`;
  d.querySelector("h2").textContent = title;
  d.firstElementChild.append(body);
  for (const action of actions) {
    const b = document.createElement("button");
    b.type = "button"; b.className = action.accent ? "btn accent" : "btn"; b.textContent = action.label;
    b.addEventListener("click", async () => { if ((await action.run?.()) !== false) d.close(); });
    d.lastElementChild.append(b);
  }
  d.addEventListener("close", () => d.remove());
  document.body.append(d); d.showModal();
  return d;
}

/** @type {null | (() => void)} */ let openFlyout = null;

/** Closes the open flyout or menu, if any. */
export function closeFlyout() { openFlyout?.(); }

/** Flyout beside an anchor (spec 6): slides 8 px from it, Esc or an outside click closes it,
 * focus goes to [data-autofocus] or the first control, and back to the anchor on close.
 * @param {Element} anchor @param {HTMLElement} content
 * @param {{ role?: string, label?: string, onClose?: () => void }} [config]
 * @returns {() => void} close */
export function flyout(anchor, content, { role = "dialog", label = "", onClose } = {}) {
  closeFlyout();
  const box = document.createElement("div");
  box.className = "flyout panel"; box.setAttribute("role", role);
  if (label) box.setAttribute("aria-label", label);
  box.append(content); layerOf(anchor).append(box);
  const at = anchor.getBoundingClientRect();
  const below = at.bottom + 4 + box.offsetHeight < innerHeight - 8;
  box.classList.toggle("above", !below);
  box.style.left = `${Math.max(8, Math.min(at.left, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${below ? at.bottom + 4 : Math.max(8, at.top - box.offsetHeight - 4)}px`;
  let open = true;
  const close = () => {
    if (!open) return; open = false;
    removeEventListener("pointerdown", outside, true); removeEventListener("keydown", key, true);
    box.remove(); if (openFlyout === close) openFlyout = null;
    if (!document.activeElement || document.activeElement === document.body) /** @type {HTMLElement} */ (anchor).focus?.();
    onClose?.();
  };
  /** @param {PointerEvent} e */
  // A select's listbox opened from inside this flyout is a flyout of its own: it doesn't count as outside.
  const outside = (e) => {
    const target = /** @type {Element} */ (e.target);
    if (!box.contains(target) && !anchor.contains(target) && !target.closest?.(".flyout")) close();
  };
  /** @param {KeyboardEvent} e */
  const key = (e) => {
    if (e.key !== "Escape" || document.activeElement?.closest(".flyout:not(.panel)")) return;
    e.preventDefault(); e.stopPropagation(); close(); /** @type {HTMLElement} */ (anchor).focus?.();
  };
  addEventListener("pointerdown", outside, true); addEventListener("keydown", key, true);
  openFlyout = close;
  /** @type {HTMLElement | null} */ (box.querySelector("[data-autofocus]") ?? box.querySelector("button, input, [tabindex]"))?.focus();
  return close;
}

/** Menu (spec 6): 32-36 px items with a 16 px icon and a hint on the right; arrows move,
 * Enter runs, Esc closes. A checked item carries the 3x16 accent indicator.
 * @param {Element} anchor
 * @param {{ label: string, icon?: string, hint?: string, checked?: boolean, disabled?: boolean, run: () => void }[]} items
 * @param {string} [label] */
export function menu(anchor, items, label = "") {
  const list = document.createElement("div");
  list.className = "menu"; list.setAttribute("role", "none");
  /** @type {() => void} */ let close = () => {};
  const buttons = items.map((item) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "menu-item"; b.disabled = !!item.disabled;
    b.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
    if (item.checked !== undefined) b.setAttribute("aria-checked", String(item.checked));
    b.innerHTML = `${item.icon ?? ""}<span class="menu-label"></span>${item.hint ? `<span class="menu-hint"></span>` : ""}`;
    /** @type {HTMLElement} */ (b.querySelector(".menu-label")).textContent = item.label;
    if (item.hint) /** @type {HTMLElement} */ (b.querySelector(".menu-hint")).textContent = item.hint;
    b.addEventListener("click", () => { close(); item.run(); });
    return b;
  });
  list.append(...buttons);
  list.addEventListener("keydown", (e) => {
    const live = buttons.filter((b) => !b.disabled);
    const at = live.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const go = { ArrowDown: at + 1, ArrowUp: at - 1 + live.length, Home: 0, End: live.length - 1 }[e.key];
    if (go === undefined || !live.length) return;
    e.preventDefault(); live[go % live.length].focus();
  });
  close = flyout(anchor, list, { role: "menu", label });
  /** @type {HTMLElement | undefined} */ (buttons.find((b) => b.getAttribute("aria-checked") === "true") ?? buttons.find((b) => !b.disabled))?.focus();
}
