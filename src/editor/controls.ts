// Small form controls for the editor. Each returns its element and an
// update() that re-reads the value from the voice, so the page can refresh
// every control after any change (undo, load, paste) without rebuilding it.

export interface Control {
  el: HTMLElement;
  update(): void;
}

export interface SliderSpec {
  label: string;
  max: number;
  min?: number;
  get(): number;
  set(v: number): void;
  format?(v: number): string;
  hint?: string;
  /** larger, for the most important value in a group */
  big?: boolean;
}

let uid = 0;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
};

export function slider(spec: SliderSpec): Control {
  const id = `p${++uid}`;
  const el = h("div", `param${spec.big ? " param-big" : ""}`);
  const label = h("label", "param-name", spec.label);
  label.htmlFor = id;
  if (spec.hint) el.title = spec.hint;
  const out = h("output", "param-val");
  out.htmlFor.add(id);
  const input = h("input");
  Object.assign(input, { type: "range", id, min: String(spec.min ?? 0), max: String(spec.max), step: "1" });
  const min = spec.min ?? 0;
  const show = (v: number) => {
    out.textContent = spec.format ? spec.format(v) : String(v);
    input.style.setProperty("--fill", `${((v - min) / (spec.max - min)) * 100}%`);
    input.setAttribute("aria-valuetext", out.textContent);
  };
  input.addEventListener("input", () => {
    const v = Number(input.value);
    spec.set(v);
    show(v);
  });
  el.append(label, out, input);
  return {
    el,
    update() {
      const v = spec.get();
      if (Number(input.value) !== v) input.value = String(v);
      show(v);
    },
  };
}

export interface ChoiceSpec {
  label: string;
  options: { label: string; title?: string; icon?: string }[];
  get(): number;
  set(v: number): void;
}

/** A row of buttons, one per option (a segmented control). */
export function choice(spec: ChoiceSpec): Control {
  const el = h("div", "param choice");
  const name = h("span", "param-name", spec.label);
  name.id = `c${++uid}`;
  const group = h("div", "seg");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-labelledby", name.id);
  const buttons = spec.options.map((o, i) => {
    const b = h("button", "seg-btn");
    b.type = "button";
    b.setAttribute("role", "radio");
    if (o.icon) {
      b.innerHTML = o.icon;
      b.setAttribute("aria-label", o.label);
      b.title = o.title ?? o.label;
    } else {
      b.textContent = o.label;
      if (o.title) b.title = o.title;
    }
    b.onclick = () => spec.set(i);
    group.append(b);
    return b;
  });
  el.append(name, group);
  return {
    el,
    update() {
      const v = spec.get();
      buttons.forEach((b, i) => b.setAttribute("aria-checked", String(i === v)));
    },
  };
}

export interface ToggleSpec {
  label: string;
  hint?: string;
  get(): boolean;
  set(v: boolean): void;
}

export function toggle(spec: ToggleSpec): Control {
  const el = h("label", "toggle");
  if (spec.hint) el.title = spec.hint;
  const input = h("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.onchange = () => spec.set(input.checked);
  el.append(input, h("span", "toggle-track"), h("span", "", spec.label));
  return {
    el,
    update() {
      input.checked = spec.get();
    },
  };
}

export const group = (title: string, ...children: (Control | HTMLElement)[]): HTMLElement => {
  const el = h("section", "ed-group");
  el.append(h("h3", "ed-group-title", title), ...children.map((c) => (c instanceof HTMLElement ? c : c.el)));
  return el;
};
