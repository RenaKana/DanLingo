import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const NICONICO_EVIDENCE = 'real-anonymous-query-not-browser-rendering';
const BILIBILI_EVIDENCE = 'HTTP-discovered current page resources and static source; NOT a browser load trace';
const BILIBILI_HOSTS = new Set(['api.bilibili.com', 'www.bilibili.com', 's1.hdslb.com']);

export function requireFileOption(args, option) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== option
    || typeof args[1] !== 'string' || !args[1].trim() || args[1].startsWith('--')) {
    throw new Error(`Expected ${option} <json-file>`);
  }
  return resolve(args[1]);
}

async function readJsonFile(filePath, label) {
  let source;
  try { source = await readFile(resolve(filePath), 'utf8'); }
  catch { throw new Error(`Unable to read ${label} JSON input`); }
  let data;
  try { data = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid ${label} JSON input`); }
  return { data, fileName: basename(resolve(filePath)) };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateNiconicoRecording(recording) {
  if (!recording || typeof recording !== 'object' || Array.isArray(recording)
    || recording.evidence !== NICONICO_EVIDENCE) {
    throw new Error('Real Niconico query evidence is required; synthetic fixtures are not accepted');
  }
  if (!isTimestamp(recording.capturedAt) || !/^(?:sm|so|nm)\d+$/.test(recording.watchId ?? '')
    || !Number.isFinite(recording.durationSeconds) || recording.durationSeconds <= 0
    || !isNonEmptyString(recording.sampling) || !Number.isSafeInteger(recording.totalReturned)
    || !Array.isArray(recording.threads) || !recording.threads.length
    || !Array.isArray(recording.messages) || !recording.messages.length || recording.messages.length > 2000) {
    throw new Error('Invalid Niconico recording structure');
  }
  let sourceUrl, endpoint;
  try {
    sourceUrl = new URL(recording.sourceUrl);
    endpoint = new URL(recording.endpoint);
  } catch {
    throw new Error('Invalid Niconico recording source URLs');
  }
  if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'www.nicovideo.jp'
    || sourceUrl.pathname !== `/watch/${recording.watchId}` || sourceUrl.search || sourceUrl.hash
    || endpoint.protocol !== 'https:' || !['nvcomment.nicovideo.jp', 'public.nvcomment.nicovideo.jp'].includes(endpoint.hostname)
    || !endpoint.pathname.replace(/\/+$/, '').endsWith('/v1/threads') || endpoint.username || endpoint.password) {
    throw new Error('Niconico recording must identify its public watch page and comment endpoint');
  }
  if (recording.totalReturned < recording.messages.length || !recording.messages.every(message =>
    message && typeof message === 'object' && isNonEmptyString(String(message.id ?? ''))
      && isNonEmptyString(String(message.threadId ?? '')) && isNonEmptyString(message.fork)
      && typeof message.body === 'string' && message.body.length <= 100_000
      && Number.isFinite(message.vposMs) && message.vposMs >= 0
      && Array.isArray(message.commands) && message.commands.every(isNonEmptyString))) {
    throw new Error('Invalid Niconico recording messages');
  }
  return recording;
}

export async function readNiconicoRecording(filePath) {
  const input = await readJsonFile(filePath, 'Niconico recording');
  validateNiconicoRecording(input.data);
  return { recording: input.data, fileName: input.fileName };
}

export function validateBilibiliSourceEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.evidenceLevel !== BILIBILI_EVIDENCE) {
    throw new Error('Real Bilibili source evidence is required; synthetic fixtures are not accepted');
  }
  if (!/^BV[0-9A-Za-z]{10}$/.test(evidence.bvid ?? '')
    || (evidence.capturedAt !== undefined && !isTimestamp(evidence.capturedAt))
    || evidence.runtimeVerified !== false || evidence.safeRemeasureVerified !== false
    || !Array.isArray(evidence.sources) || evidence.sources.length < 3
    || !Array.isArray(evidence.quotations) || !evidence.quotations.length
    || !Array.isArray(evidence.missingAnchors) || evidence.missingAnchors.length
    || evidence.error) {
    throw new Error('Invalid Bilibili source evidence structure');
  }
  const labels = new Set();
  for (const source of evidence.sources) {
    let url;
    try { url = new URL(source?.url); }
    catch { throw new Error('Invalid Bilibili source evidence URLs'); }
    if (!isNonEmptyString(source.label) || labels.has(source.label)
      || url.protocol !== 'https:' || !BILIBILI_HOSTS.has(url.hostname) || url.username || url.password
      || source.status !== 200 || !isTimestamp(source.fetchedAt)
      || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')
      || source.credentials !== 'anonymous; no cookies or tokens') {
      throw new Error('Invalid Bilibili source evidence response record');
    }
    labels.add(source.label);
  }
  const pageSource = evidence.sources.find(source => source.label === 'page');
  const pageUrl = pageSource ? new URL(pageSource.url) : null;
  if (!pageSource || pageUrl.hostname !== 'www.bilibili.com'
    || pageUrl.pathname !== `/video/${evidence.bvid}/` || pageUrl.search || pageUrl.hash
    || !evidence.quotations.every(quote => quote && typeof quote === 'object'
      && labels.has(quote.source) && isNonEmptyString(quote.name) && isNonEmptyString(quote.excerpt))) {
    throw new Error('Invalid Bilibili source evidence quotations');
  }
  return evidence;
}

export async function readBilibiliSourceEvidence(filePath) {
  const input = await readJsonFile(filePath, 'Bilibili source evidence');
  validateBilibiliSourceEvidence(input.data);
  return { evidence: input.data, fileName: input.fileName };
}
