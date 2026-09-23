/**
 * P0 observation only. Import in the page MAIN world and explicitly supply the
 * current player's danmakuX instance (public API: player.danmaku.getDanmakuX()).
 * No lookup of undocumented window globals, no add/send/seek/Canvas patching.
 * This file has NOT been executed in a real browser in this investigation.
 */
export function attachNativeObserver(instance, { resourceKey, maxRecords = 64 } = {}) {
  if (typeof resourceKey !== 'string' || !resourceKey || resourceKey.length > 128) throw new Error('Explicit BVID/CID/page resourceKey required');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 256) throw new Error('Record bound must be 1..256');
  const metadata = instance?.getMetadata?.();
  if (metadata?.version !== '1.1.23' || metadata.lastCompiled !== '2026-09-03T16:18:23+08:00') throw new Error('Unreviewed danmakuX version; inspect sources first');
  const hooks = instance.hooks, manager = instance.manager;
  if (!hooks || typeof hooks.beforeRender !== 'function' || !Array.isArray(manager?.visualArray)) throw new Error('Expected native hook/manager missing');
  const descriptor = Object.getOwnPropertyDescriptor(hooks, 'beforeRender');
  if (!descriptor || !('value' in descriptor) || !descriptor.writable) throw new Error('Expected writable own native hook');
  const previous = descriptor.value;
  let enabled = true, calls = 0, seenCount = 0;
  const identities = new WeakMap(), records = [];

  function wrapper(active, pending) {
    // Preserve existing native behavior, this value, return and thrown errors.
    const result = Reflect.apply(previous, this, arguments);
    if (!enabled) return result;
    try {
      calls++;
      if (!Array.isArray(pending) || !Array.isArray(active)) return result;
      const activeData = new Set(active.map(model => model?.textData));
      for (const item of pending) {
        if (!item || typeof item !== 'object' || item.on || activeData.has(item) || identities.has(item)) continue;
        // Limit evidence to ordinary text. No picture/emoji/BAS/commands.
        if (![1, 4, 5, 6].includes(item.mode) || (item.rawMode != null && item.rawMode !== item.mode) ||
            item.animation || item.emoticons || item.prefix || item.suffix || item.resource ||
            item.colorfulImg || item.colorful || item.likes || item.isHighLike || item.border ||
            item.pool || item.action || typeof item.text !== 'string') continue;
        const label = ++seenCount;
        identities.set(item, label);
        records.push({ label, mode: item.mode, rawMode: item.rawMode ?? null,
          stimeSeconds: Number.isFinite(item.stime) ? item.stime : null,
          color: item.color ?? null, size: item.size ?? null, textUtf16Length: item.text.length,
          sourceWasInactive: true });
        if (records.length > maxRecords) records.shift();
      }
    } catch { /* Observation must not interrupt native rendering. */ }
    return result;
  }
  hooks.beforeRender = wrapper;
  return {
    snapshot() {
      return { evidenceLevel: 'runtime observation only; no translation/replacement performed',
        resourceKey, metadata, calls, seenCount, enabled, ownsHook: hooks.beforeRender === wrapper,
        records: records.map(record => ({ ...record })),
        active: manager.visualArray.slice(0, 256).map(model => ({
          label: identities.get(model.textData) ?? null, mode: model.textData?.mode ?? null,
          width: Number.isFinite(model.width) ? model.width : null,
          height: Number.isFinite(model.height) ? model.height : null,
          textUtf16Length: typeof model.text === 'string' ? model.text.length : null,
          shown: !!model.showed,
        })),
        nativeReplacementPassed: false };
    },
    stop() {
      enabled = false;
      const restored = hooks.beforeRender === wrapper;
      if (restored) Object.defineProperty(hooks, 'beforeRender', descriptor);
      // If someone wrapped us later, leave their wrapper intact; ours is inert.
      records.length = 0;
      return { restored, laterWrapperPreserved: !restored };
    },
  };
}
