import { emoteAliases, emoteUrl, emotesIntact, type InlineEmotes } from './emotes.ts';

export interface NativeBody {
  text: string;
  nodes: Text[];
  images: HTMLImageElement[];
  /** Edits text nodes only. Native image nodes and their event handlers remain intact. */
  write(text: string): Text[] | null;
}

export function readNativeBody(body: HTMLElement, original: string, emotes: InlineEmotes = {}): NativeBody | null {
  const ownerDocument: Document = body.ownerDocument;
  const view = ownerDocument.defaultView as (Window & typeof globalThis) | null;
  const NodeCtor: typeof globalThis.Node = view?.Node ?? globalThis.Node;
  const ElementCtor: typeof globalThis.Element = view?.Element ?? globalThis.Element;
  const HTMLElementCtor: typeof globalThis.HTMLElement = view?.HTMLElement ?? globalThis.HTMLElement;
  const HTMLImageElementCtor: typeof globalThis.HTMLImageElement = view?.HTMLImageElement ?? globalThis.HTMLImageElement;
  const tokens = Object.keys(emotes), aliases = emoteAliases(original, tokens);
  const groups: Text[][] = [[]], images: HTMLImageElement[] = [];
  let count = 0;
  const walk = (parent: Element, depth: number): boolean => {
    if (depth > 4) return false;
    for (const child of parent.childNodes) {
      if (++count > 200) return false;
      if (child.nodeType === NodeCtor.TEXT_NODE) groups.at(-1)!.push(child as Text);
      else if (child instanceof HTMLImageElementCtor) {
        const alias = aliases[images.length];
        if (!alias || emoteUrl(child.getAttribute('src')) !== emotes[alias]) return false;
        images.push(child); groups.push([]);
      } else if (child instanceof ElementCtor && child.classList.contains('content-message-icon')) {
        // Reviewed SC decoration; it is not part of the message body.
      } else if (child instanceof HTMLElementCtor && child.tagName === 'SPAN') {
        if (!walk(child, depth + 1)) return false;
      } else return false;
    }
    return true;
  };
  if (!walk(body, 0) || images.length && images.length !== aliases.length) return null;
  const text = groups.map((group, index) => group.map(node => node.data).join('') + (images[index] ? aliases[index] : '')).join('');
  if (!text || images.length && !emotesIntact(original, text, tokens)) return null;
  const nodes = groups.flat();
  return { text, nodes, images, write(next) {
    if (!emotesIntact(original, next, tokens)) return null;
    const parts: string[] = [];
    let at = 0;
    for (let index = 0; index < images.length; index++) {
      const alias = aliases[index]!, offset = next.indexOf(alias, at);
      if (offset < 0) return null;
      parts.push(next.slice(at, offset)); at = offset + alias.length;
    }
    parts.push(next.slice(at));
    const added: Text[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!, value = parts[index]!;
      if (group.length) { group[0]!.data = value; for (const node of group.slice(1)) node.data = ''; }
      else if (value) {
        const node = ownerDocument.createTextNode(value), nextImage = images[index];
        if (nextImage) nextImage.before(node); else if (images.length) images.at(-1)!.after(node); else body.append(node);
        added.push(node);
      }
    }
    return added;
  } };
}
