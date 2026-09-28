const WINDOW_MS = 5000;

interface WindowState {
  sent: { at: number; chars: number }[];
  reserved: Map<object, number>;
}

/** Shared across tabs in the background engine. Reservations are refundable until dispatch. */
export class HybridInputWindow {
  private readonly windows = new Map<string, WindowState>();

  reserve(key: string, token: object, chars: number, maxItems: number, maxChars: number, now: number): boolean {
    const state = this.windows.get(key) ?? { sent: [], reserved: new Map<object, number>() };
    state.sent = state.sent.filter(entry => entry.at + WINDOW_MS > now);
    if (state.reserved.has(token)) return true;
    const items = state.sent.length + state.reserved.size;
    const used = state.sent.reduce((sum, entry) => sum + entry.chars, 0)
      + [...state.reserved.values()].reduce((sum, value) => sum + value, 0);
    if (items >= maxItems || used + chars > maxChars) return false;
    state.reserved.set(token, chars);
    this.windows.set(key, state);
    return true;
  }

  release(key: string, token: object): void {
    const state = this.windows.get(key);
    state?.reserved.delete(token);
    if (state && !state.sent.length && !state.reserved.size) this.windows.delete(key);
  }

  dispatch(key: string, token: object, chars: number, now: number): void {
    const state = this.windows.get(key);
    if (!state?.reserved.delete(token)) return;
    state.sent.push({ at: now, chars });
  }

  clear(): void { this.windows.clear(); }
}
