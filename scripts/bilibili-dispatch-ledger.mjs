import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const LEDGER_SCHEMA = 'danlingo-bilibili-dispatch-ledger';
export const LEDGER_VERSION = 1;

export const LEDGER_LIMITS = Object.freeze({
  maxFormalStarts: 4,
  maxRecoveryStarts: 2,
  maxTotalProviderCalls: 220,
  maxProviderCallsPerSegment: 55,
  maxInputItemsPerSegment: 55,
  maxInputCharsPerSegment: 600,
});

const RECOVERY_REASONS = new Set([
  'stale-page',
  'temporary-connection',
  'playback-start-failed',
  'playback-state-changed',
  'viewport-state-changed',
  'runtime-state-changed',
  'other-environmental',
]);
const SETTLED_STATUSES = new Set(['completed', 'environment-invalid', 'hard-failure']);
const COUNT_FIELDS = ['providerCalls', 'sentInputItems', 'sentInputChars', 'cancelled'];

function fail(message) {
  throw new Error(`Invalid Bilibili dispatch ledger: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, name, maxLength = 512) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line string`);
  }
  return value;
}

function readCount(value, name, max, { nullable = true } = {}) {
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer from 0 to ${max}${nullable ? ' or null' : ''}`);
  }
  return value;
}

function limitsMatch(value) {
  return isRecord(value)
    && Object.keys(LEDGER_LIMITS).every(key => value[key] === LEDGER_LIMITS[key])
    && Object.keys(value).length === Object.keys(LEDGER_LIMITS).length;
}

function retryDecision(segments) {
  if (segments.length === 0) return { group: 'B', recoveryReason: null };

  const previous = segments.at(-1);
  if (previous.status === 'reserved' || previous.status === 'hard-failure') return null;
  if (previous.status === 'completed') {
    if (previous.group === 'B' && !segments.some(segment => segment.group === 'A')) {
      return { group: 'A', recoveryReason: null };
    }
    return null;
  }
  if (previous.status === 'environment-invalid') {
    return { group: previous.group, recovery: true };
  }
  return null;
}

function conservativeCalls(segment) {
  return segment.actual.providerCalls === null
    ? LEDGER_LIMITS.maxProviderCallsPerSegment
    : segment.actual.providerCalls;
}

function segmentId(index) {
  return `segment-${String(index).padStart(2, '0')}`;
}

export function createLedger() {
  return {
    schema: LEDGER_SCHEMA,
    version: LEDGER_VERSION,
    limits: { ...LEDGER_LIMITS },
    segments: [],
  };
}

export function getLedgerUsage(input) {
  const ledger = validateLedger(input);
  const pending = ledger.segments.filter(segment => segment.status === 'reserved').length;
  const knownProviderCalls = ledger.segments
    .filter(segment => segment.status !== 'reserved' && segment.actual.providerCalls !== null)
    .reduce((sum, segment) => sum + segment.actual.providerCalls, 0);
  const providerCalls = ledger.segments.reduce((sum, segment) => sum + conservativeCalls(segment), 0);
  const formalStarts = ledger.segments.length;
  const recoveryStarts = ledger.segments.filter(segment => segment.recoveryReason !== null).length;
  return {
    formalStarts,
    remainingFormalStarts: LEDGER_LIMITS.maxFormalStarts - formalStarts,
    recoveryStarts,
    remainingRecoveryStarts: LEDGER_LIMITS.maxRecoveryStarts - recoveryStarts,
    knownProviderCalls,
    pendingReservedProviderCalls: pending * LEDGER_LIMITS.maxProviderCallsPerSegment,
    providerCalls,
    remainingProviderCalls: LEDGER_LIMITS.maxTotalProviderCalls - providerCalls,
  };
}

export function reserveSegment(input, { group, buildId, configFingerprint, reason } = {}) {
  const ledger = validateLedger(input);
  if (group !== 'B' && group !== 'A') throw new Error('group must be B or A');
  requireText(buildId, 'buildId');
  requireText(configFingerprint, 'configFingerprint');

  const decision = retryDecision(ledger.segments);
  if (!decision) throw new Error('No formal segment may start from the current ledger state');
  if (group !== decision.group) throw new Error(`The next required group is ${decision.group}`);

  let recoveryReason = null;
  if (decision.recovery) {
    if (!RECOVERY_REASONS.has(reason)) {
      throw new Error('An environmental recovery reason code is required for a retry');
    }
    recoveryReason = reason;
  } else if (reason !== undefined && reason !== null) {
    throw new Error('A recovery reason is only valid for an environmental recovery start');
  }

  const usage = getLedgerUsage(ledger);
  if (usage.formalStarts >= LEDGER_LIMITS.maxFormalStarts) throw new Error('The four-start budget is exhausted');
  if (recoveryReason && usage.recoveryStarts >= LEDGER_LIMITS.maxRecoveryStarts) {
    throw new Error('The two environmental recovery starts are exhausted');
  }
  if (usage.providerCalls + LEDGER_LIMITS.maxProviderCallsPerSegment > LEDGER_LIMITS.maxTotalProviderCalls) {
    throw new Error('Reserving this segment would exceed the 220-call total budget');
  }

  const segment = {
    id: segmentId(ledger.segments.length + 1),
    group,
    buildId,
    configFingerprint,
    recoveryReason,
    reserved: {
      providerCalls: LEDGER_LIMITS.maxProviderCallsPerSegment,
      sentInputItems: LEDGER_LIMITS.maxInputItemsPerSegment,
      sentInputChars: LEDGER_LIMITS.maxInputCharsPerSegment,
    },
    actual: { providerCalls: null, sentInputItems: null, sentInputChars: null, cancelled: null },
    status: 'reserved',
    reason: null,
    rawPath: null,
    rawSha256: null,
  };
  const next = { ...ledger, segments: [...ledger.segments, segment] };
  validateLedger(next);
  return { ledger: next, segment };
}

export function settleSegment(input, id, settlement = {}) {
  const ledger = validateLedger(input);
  requireText(id, 'segment id', 64);
  const index = ledger.segments.findIndex(segment => segment.id === id);
  if (index === -1) throw new Error(`Unknown segment id: ${id}`);
  const current = ledger.segments[index];
  if (current.status !== 'reserved') throw new Error(`Segment ${id} has already been settled`);

  const status = settlement.status;
  if (!SETTLED_STATUSES.has(status)) throw new Error('status must be completed, environment-invalid, or hard-failure');

  const actual = {
    providerCalls: readCount(settlement.providerCalls ?? null, 'providerCalls', LEDGER_LIMITS.maxProviderCallsPerSegment),
    sentInputItems: readCount(settlement.sentInputItems ?? null, 'sentInputItems', LEDGER_LIMITS.maxInputItemsPerSegment),
    sentInputChars: readCount(settlement.sentInputChars ?? null, 'sentInputChars', LEDGER_LIMITS.maxInputCharsPerSegment),
    cancelled: readCount(settlement.cancelled ?? null, 'cancelled', LEDGER_LIMITS.maxProviderCallsPerSegment),
  };
  if (actual.providerCalls !== null && actual.cancelled !== null && actual.cancelled > actual.providerCalls) {
    throw new Error('cancelled cannot exceed providerCalls');
  }

  const rawPath = settlement.rawPath == null ? null : requireText(settlement.rawPath, 'rawPath', 4096);
  const rawSha256 = settlement.rawSha256 == null ? null : String(settlement.rawSha256).toLowerCase();
  if ((rawPath === null) !== (rawSha256 === null)) throw new Error('rawPath and rawSha256 must be supplied together');
  if (rawSha256 !== null && !/^[a-f0-9]{64}$/.test(rawSha256)) throw new Error('rawSha256 must be a 64-character SHA-256 hex digest');

  let reason = null;
  if (status === 'environment-invalid' || status === 'hard-failure') reason = requireText(settlement.reason, 'reason', 1000);
  else if (settlement.reason != null) reason = requireText(settlement.reason, 'reason', 1000);

  const settled = {
    ...current,
    actual,
    status,
    reason,
    rawPath,
    rawSha256,
  };
  const segments = [...ledger.segments];
  segments[index] = settled;
  const next = { ...ledger, segments };
  validateLedger(next);
  return { ledger: next, segment: settled };
}

export function validateLedger(value) {
  if (!isRecord(value) || value.schema !== LEDGER_SCHEMA || value.version !== LEDGER_VERSION) {
    fail('unsupported schema or version');
  }
  if (!limitsMatch(value.limits)) fail('fixed limits do not match this schema version');
  if (!Array.isArray(value.segments)) fail('segments must be an array');
  if (value.segments.length > LEDGER_LIMITS.maxFormalStarts) fail('too many formal starts');

  let recoveryStarts = 0;
  let previous = null;
  let terminal = false;
  for (let index = 0; index < value.segments.length; index += 1) {
    const segment = value.segments[index];
    if (!isRecord(segment)) fail(`segment ${index + 1} must be an object`);
    if (segment.id !== segmentId(index + 1)) fail(`segment ${index + 1} has an invalid id`);
    if (segment.group !== 'B' && segment.group !== 'A') fail(`${segment.id} has an invalid group`);
    try {
      requireText(segment.buildId, `${segment.id}.buildId`);
      requireText(segment.configFingerprint, `${segment.id}.configFingerprint`);
    } catch (error) {
      fail(error.message);
    }
    if (!isRecord(segment.reserved)
      || segment.reserved.providerCalls !== LEDGER_LIMITS.maxProviderCallsPerSegment
      || segment.reserved.sentInputItems !== LEDGER_LIMITS.maxInputItemsPerSegment
      || segment.reserved.sentInputChars !== LEDGER_LIMITS.maxInputCharsPerSegment) {
      fail(`${segment.id} reservation does not match the fixed per-segment limits`);
    }
    if (!isRecord(segment.actual)) fail(`${segment.id}.actual must be an object`);
    for (const field of COUNT_FIELDS) {
      try {
        readCount(segment.actual[field], `${segment.id}.actual.${field}`, field === 'sentInputItems'
          ? LEDGER_LIMITS.maxInputItemsPerSegment
          : field === 'sentInputChars' ? LEDGER_LIMITS.maxInputCharsPerSegment : LEDGER_LIMITS.maxProviderCallsPerSegment);
      } catch (error) {
        fail(error.message);
      }
    }
    if (segment.actual.providerCalls !== null && segment.actual.cancelled !== null
      && segment.actual.cancelled > segment.actual.providerCalls) fail(`${segment.id} cancelled count exceeds provider calls`);

    if (!['reserved', ...SETTLED_STATUSES].includes(segment.status)) fail(`${segment.id} has an invalid status`);
    if (segment.recoveryReason !== null) {
      if (!RECOVERY_REASONS.has(segment.recoveryReason)) fail(`${segment.id} has an invalid environmental recovery reason`);
      recoveryStarts += 1;
    }
    if (recoveryStarts > LEDGER_LIMITS.maxRecoveryStarts) fail('more than two environmental recovery starts');

    if (index === 0) {
      if (segment.group !== 'B' || segment.recoveryReason !== null) fail('the first formal start must be B without a recovery reason');
    } else {
      if (terminal) fail('a segment follows a terminal ledger state');
      if (!previous) fail('segment sequence is invalid');
      if (previous.status === 'environment-invalid') {
        if (segment.group !== previous.group || segment.recoveryReason === null) fail('environmental recovery must repeat the invalid group');
      } else if (previous.status === 'completed' && previous.group === 'B') {
        if (segment.group !== 'A' || segment.recoveryReason !== null) fail('the first A segment must follow a completed B segment');
      } else {
        fail('a new segment is not allowed after the preceding status');
      }
    }

    if (segment.status === 'reserved') {
      if (index !== value.segments.length - 1) fail('an unsettled reservation must be the final segment');
      if (COUNT_FIELDS.some(field => segment.actual[field] !== null)
        || segment.reason !== null || segment.rawPath !== null || segment.rawSha256 !== null) {
        fail(`${segment.id} reservation must retain unknown actuals until settlement`);
      }
    } else {
      if (segment.status === 'environment-invalid' || segment.status === 'hard-failure') {
        try { requireText(segment.reason, `${segment.id}.reason`, 1000); }
        catch (error) { fail(error.message); }
      } else if (segment.reason !== null) {
        try { requireText(segment.reason, `${segment.id}.reason`, 1000); }
        catch (error) { fail(error.message); }
      }
      if ((segment.rawPath === null) !== (segment.rawSha256 === null)) fail(`${segment.id} raw artifact path and hash must be paired`);
      if (segment.rawPath !== null) {
        try { requireText(segment.rawPath, `${segment.id}.rawPath`, 4096); }
        catch (error) { fail(error.message); }
        if (typeof segment.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(segment.rawSha256)) fail(`${segment.id} has an invalid raw SHA-256`);
      }
      if (segment.status === 'completed' && segment.group === 'A') terminal = true;
      if (segment.status === 'hard-failure') terminal = true;
    }
    previous = segment;
  }

  const usage = value.segments.reduce((sum, segment) => sum + conservativeCalls(segment), 0);
  if (usage > LEDGER_LIMITS.maxTotalProviderCalls) fail('conservative provider-call total exceeds 220');
  return value;
}

export async function writeJSON(filePath, data) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}

export async function loadLedger(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  return validateLedger(parsed);
}
