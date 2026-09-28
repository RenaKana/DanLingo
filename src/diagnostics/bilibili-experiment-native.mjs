import { sourceMessageFromDanmaku } from '../platforms/bilibili/video.ts';
import { nativeRuleInputs } from './bilibili-native-branches.mjs';

/** Session-only, reversible demand hints. Native objects and admission are untouched. */
export function experimentFilterRows(binding, tracker, enabled) {
  const context = tracker.readContext();
  const rows = [];
  for (const source of binding.manager.dataBase.dmArray) {
    const row = sourceMessageFromDanmaku(source, binding.identity);
    if (!row) continue;
    const input = nativeRuleInputs(source);
    const inactive = input.onTruthy === false && !['accessor', 'inherited'].includes(input.onKind);
    const decision = enabled && inactive ? tracker.predict(input, context) : { decision: 'unknown' };
    rows.push({ id: row.id, originalText: row.originalText,
      state: decision.decision === 'exclude' ? 'filtered' : 'unknown' });
  }
  return { rows, fingerprint: context.fingerprint };
}

/** Publish one complete revision sequence before ready=true, then changes plus a lease heartbeat. */
export function createExperimentFilterPublisher(emit) {
  let revision = 0, previous = new Map(), fingerprint = null, first = true;
  return {
    publish(sample) {
      const next = new Map(sample.rows.map(row => [row.id, row]));
      const reset = first || fingerprint !== sample.fingerprint;
      const changed = reset ? sample.rows : sample.rows.filter(row => {
        const prior = previous.get(row.id);
        return !prior || prior.state !== row.state || prior.originalText !== row.originalText;
      });
      if (!reset) for (const [id, prior] of previous) if (!next.has(id))
        changed.push({ ...prior, state: 'unknown' });
      previous = next; fingerprint = sample.fingerprint; first = false;
      const count = Math.max(1, Math.ceil(changed.length / 200));
      for (let index = 0; index < count; index++) emit({ revision: ++revision,
        reset: reset && index === 0, ready: index === count - 1,
        items: changed.slice(index * 200, (index + 1) * 200) });
    },
    stop() {
      previous.clear(); first = true;
      emit({ revision: ++revision, reset: true, ready: false, items: [] });
    },
  };
}
