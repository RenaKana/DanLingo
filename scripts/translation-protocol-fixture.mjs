// Local test/observation helper. It never sends traffic or accesses credentials.
import assert from 'node:assert/strict';

export function decodeTranslationFixtureRequest(body) {
  const content = body?.messages?.find(message => message.role === 'user')?.content;
  assert.equal(typeof content, 'string', 'Translation fixture requires user data');
  let envelope;
  try { envelope = JSON.parse(content); } catch { /* Multiple compact JSONL rows are parsed below. */ }
  const protocol = Array.isArray(envelope?.items) ? 'envelope' : 'jsonl';
  let sourceLanguage = envelope?.sourceLanguage, targetLanguage = envelope?.targetLanguage;
  const items = protocol === 'envelope' ? envelope.items : content.split('\n').filter(line => line.trim()).map(line => {
    const row = JSON.parse(line);
    assert.ok(Array.isArray(row) && row.length === 2 && Number.isSafeInteger(row[0]) && row[0] >= 0, 'Compact input requires an integer ID');
    return { id: row[0], text: row[1] };
  });
  if (protocol === 'jsonl') {
    // Read the actual compact header rather than substituting expected test configuration.
    const system = body.messages.find(message => message.role === 'system')?.content;
    const languages = typeof system === 'string'
      ? /^Translate comments from ("(?:\\.|[^"\\])*") to ("(?:\\.|[^"\\])*"); auto detects source\./.exec(system) : null;
    if (languages) { sourceLanguage = JSON.parse(languages[1]); targetLanguage = JSON.parse(languages[2]); }
  }
  assert.ok(items.length > 0 && items.length <= 200 && items.every(item => typeof item.text === 'string'
    && (protocol === 'jsonl' || typeof item.id === 'string')), 'Bounded translation fixture items');
  assert.equal(new Set(items.map(item => item.id)).size, items.length, 'Input fixture IDs must be unique');
  return { protocol, items, sourceLanguage, targetLanguage, stream: body.stream === true };
}

export function encodeTranslationFixtureResponse(request, items, usage) {
  const content = request.protocol === 'jsonl'
    ? items.map(item => JSON.stringify([item.id, item.text])).join('\n') : JSON.stringify({ items });
  if (request.stream) {
    assert.equal(request.protocol, 'jsonl', 'Streaming fixture is supported only for compact live requests');
    const event = value => `data: ${JSON.stringify(value)}\n\n`;
    const body = content.split('\n').map(line => event({ choices: [{ index: 0, delta: { content: line + '\n' } }] })).join('')
      + event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      + (usage === undefined ? '' : event({ choices: [], usage })) + 'data: [DONE]\n\n';
    return { contentType: 'text/event-stream', body };
  }
  return { contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }],
    ...(usage === undefined ? {} : { usage }) }) };
}
