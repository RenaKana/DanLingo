type Source = { sourceId: string; originalText: string; text?: string };
type Identity = { sourceId: string; originalText: string };
type Binding = { source: Source; node: Text; applied: string };

const ROW = '[data-comment-type="normal"]';
const MAX_SOURCES = 1200;
const validText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() &&
  value.length <= 1000 && !/[\r\n]/u.test(value);

/** A second display of the existing live translation, never a second request.
 * Selectors and resource/rowIndex are from captured official nicolib/pc-watch
 * bundles (2026-09-12). Unknown markup, NG/deleted rows and rich text fail open.
 */
export class NiconicoCommentSidebar {
  private readonly sources = new Map<string, Source>();
  private readonly bindings = new Map<HTMLElement, Binding>();

  capture(sourceId: string, originalText: string): void {
    if (!sourceId || sourceId.length > 300 || !validText(originalText)) return;
    const previous = this.sources.get(sourceId);
    if (previous?.originalText === originalText) return;
    this.sources.set(sourceId, { sourceId, originalText });
    while (this.sources.size > MAX_SOURCES) this.sources.delete(this.sources.keys().next().value!);
  }

  translated(sourceId: string, originalText: string, text: string): void {
    const source = this.sources.get(sourceId);
    if (source?.originalText === originalText && validText(text)) source.text = text;
  }

  private identity(body: HTMLElement): Identity | undefined {
    // The official table cell exposes resource + rowIndex through its React
    // props, including a stable wire ID even when comment numbers are hidden.
    const key = Object.keys(body).find(k => /^__react(?:Fiber|InternalInstance)\$/.test(k));
    const attached = key ? (body as unknown as Record<string, any>)[key] : undefined;
    for (const start of [attached, attached?.alternate]) {
      for (let fiber = start, depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps, resource = props?.resource, index = props?.rowIndex;
        if (!resource || !Number.isSafeInteger(index) || index < 0 ||
            !['id', 'text', 'type', 'isNg', 'isDeleted'].every(name => typeof resource[name] === 'function')) continue;
        try {
          const sourceId = resource.id(index), originalText = resource.text(index);
          if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 300 || !validText(originalText)) continue;
          // Official generateRowProps keys the row by this ID. React's attached
          // fiber can retain an old rowIndex after scrolling; never use that
          // index if it now resolves to another keyed row, even for equal text.
          let keyed = false;
          for (let owner = fiber, hops = depth; owner && hops < 24; hops++, owner = owner.return) {
            if (owner.key === sourceId) { keyed = true; break; }
          }
          if (!keyed) continue;
          if (resource.type(index) !== 'normal' || resource.isNg(index) || resource.isDeleted(index)) return;
          return { sourceId, originalText };
        } catch { return; }
      }
    }
    // A number or matching text is not a stable identity. Unknown versions keep
    // their originals instead of guessing across duplicate or virtualized rows.
  }

  private restore(body: HTMLElement, binding: Binding): void {
    // Do not overwrite a site update, deletion marker or recycled row. Only
    // restore the exact text node and translated value we still own.
    const identity = this.identity(body);
    if (identity?.sourceId === binding.source.sourceId && identity.originalText === binding.source.originalText &&
        binding.node.parentNode === body && binding.node.data === binding.applied) binding.node.data = binding.source.originalText;
    this.bindings.delete(body);
  }

  scan(): void {
    const live = new Set<HTMLElement>();
    for (const body of Array.from(document.querySelectorAll<HTMLElement>(`${ROW} .comment-text`)).slice(0, 600)) {
      const row = body.closest<HTMLElement>(ROW);
      if (!row || !body.isConnected) continue;
      live.add(body);
      const identity = this.identity(body), candidate = identity && this.sources.get(identity.sourceId);
      const source = candidate?.originalText === identity?.originalText ? candidate : undefined;
      const previous = this.bindings.get(body);
      if (previous && (previous.source !== source || previous.node !== body.firstChild || body.childNodes.length !== 1)) this.restore(body, previous);
      if (!source?.text || body.childNodes.length !== 1 || body.firstChild?.nodeType !== 3) continue;
      const node = body.firstChild as Text, binding = this.bindings.get(body);
      if (node.data !== source.originalText && !(binding?.source === source && node.data === binding.applied)) {
        this.bindings.delete(body); continue;
      }
      if (node.data !== source.text) node.data = source.text;
      this.bindings.set(body, { source, node, applied: source.text });
    }
    for (const [body, binding] of this.bindings) if (!live.has(body)) this.restore(body, binding);
  }

  clear(): void {
    for (const [body, binding] of this.bindings) this.restore(body, binding);
    this.sources.clear();
  }
}
