import { onLocaleChange } from '../i18n/text.ts';

type TextTarget = Element & { textContent: string | null };
type AttributeRenderers = Map<string, () => string>;

const textRenderers = new WeakMap<TextTarget, () => string | null>();
const attributeRenderers = new WeakMap<Element, AttributeRenderers>();
const references = new Set<WeakRef<Element>>();
const tracked = new WeakSet<Element>();

function track(target: Element) {
  if (tracked.has(target)) return;
  tracked.add(target);
  references.add(new WeakRef(target));
}

onLocaleChange(() => {
  for (const reference of references) {
    const target = reference.deref();
    if (!target) { references.delete(reference); continue; }
    const renderText = textRenderers.get(target as TextTarget);
    if (renderText) {
      try { (target as TextTarget).textContent = renderText(); } catch { /* Preserve the last visible value if its renderer is no longer valid. */ }
    }
    const renderAttributes = attributeRenderers.get(target);
    if (renderAttributes) for (const [name, render] of renderAttributes) {
      try { target.setAttribute(name, render()); } catch { /* Preserve the last visible value if its renderer is no longer valid. */ }
    }
  }
});

export function bindLocalizedText(target: TextTarget, render: () => string | null): void {
  target.removeAttribute('data-i18n');
  textRenderers.set(target, render);
  track(target);
  target.textContent = render();
}

export function bindLocalizedAttribute(target: Element, name: string, render: () => string): void {
  target.removeAttribute('data-i18n-' + name);
  let bindings = attributeRenderers.get(target);
  if (!bindings) { bindings = new Map(); attributeRenderers.set(target, bindings); }
  bindings.set(name, render);
  track(target);
  target.setAttribute(name, render());
}
