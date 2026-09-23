// Explicitly authorized real service only. Key enters through hidden stdin or an explicitly selected local test file; never argv/reports.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readNiconicoRecording, requireFileOption } from './probes/recording-input.mjs';
import { ChatCompletionsProvider, discoverModels } from '../src/translation/provider.ts';
import { DEFAULT_SETTINGS, normalizeSettings, PROMPT_VERSION } from '../src/core/config.ts';

export async function readTestKey() {
  if (process.env.DANLINGO_E2E_CONFIG_FILE) {
    const { readAuthorizedLiveConfig, assertAuthorizedLiveSettings, authorizedTestOverrides } = await import('./authorized-live-config.mjs');
    const config = await readAuthorizedLiveConfig(process.env.DANLINGO_E2E_CONFIG_FILE);
    const selected = authorizedTestOverrides(config.settings, { model: process.env.DANLINGO_E2E_TEST_MODEL,
      profile: process.env.DANLINGO_E2E_TEST_PROFILE, thinkingEffort: process.env.DANLINGO_E2E_TEST_THINKING });
    assertAuthorizedLiveSettings(selected, process.env);
    return config.apiKey;
  }
  if (!process.stdin.isTTY) throw new Error('An interactive terminal is required for non-echoing credential input');
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
  process.stdout.write('Test API Key (input echo disabled): ');
  return new Promise((resolve, reject) => {
    let input='';
    const onData=chunk=>{
      if(chunk.includes('\u0003')) { finish(); reject(new Error('Cancelled')); return; }
      input+=chunk;
      if(!/[\r\n]/.test(input)) return;
      const key=input.trim(); input=''; finish();
      if(!key || /[\r\n]/.test(key)) reject(new Error('Invalid credential input')); else resolve(key);
    };
    function finish() {process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');}
    process.stdin.on('data',onData); process.stdin.resume();
  });
}

export async function sampleProvider(apiKey, settings, { recording, fileName }) {
  if (!recording || typeof fileName !== 'string') throw new Error('Validated Niconico recording input is required');
  const inputs=recording.messages.filter(m=>m.vposMs<320000 && /[\u3040-\u30ff]/.test(m.body) && m.body.length>4 && m.body.length<100).slice(0,8).map(m=>({id:m.id,text:m.body}));
  const report={capturedAt:new Date().toISOString(),evidence:'real-provider-with-recorded-real-comments-not-browser-render',
    endpoint:settings.endpoint,model:settings.model,profile:settings.profile,promptVersion:PROMPT_VERSION,
    source: { fileName, capturedAt: recording.capturedAt, resourceId: recording.watchId }, inputCount: inputs.length };
  const start=performance.now();
  try {
    const result=await new ChatCompletionsProvider().complete({settings,apiKey,items:inputs,budgetMs:settings.requestTimeoutMs});
    report.elapsedMs=Math.round(performance.now()-start);
    report.usage=result.usage;
    report.mappedAll=inputs.every(m=>typeof result.items.get(m.id)?.text==='string');
    report.mappedCount=inputs.filter(m=>typeof result.items.get(m.id)?.text==='string').length;
  } catch(error) { report.elapsedMs=Math.round(performance.now()-start); report.error=error.message; }
  return report;
}

if (process.argv[1]?.endsWith('verify-real-provider.mjs')) {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log('Usage: node --experimental-strip-types scripts/verify-real-provider.mjs --recording <json-file>\nValidates an externally captured real Niconico recording before credential input or service requests.');
  } else {
  const recordingPath = requireFileOption(args, '--recording');
  const source = await readNiconicoRecording(recordingPath);
  const endpoint=process.env.DANLINGO_E2E_ENDPOINT;
  if(!endpoint) throw new Error('Set DANLINGO_E2E_ENDPOINT to an authorized service base or endpoint');
  const apiKey=await readTestKey();
  const settings=normalizeSettings({...DEFAULT_SETTINGS,endpoint,allowLocalHttp:true,sourceLanguage:'ja',profile:'deepseek'});
  const models=await discoverModels({endpoint,allowLocalHttp:true,apiKey,timeoutMs:12000});
  settings.model=process.env.DANLINGO_E2E_MODEL || models.find(m=>m==='deepseek-flash') || models[0];
  if(!models.includes(settings.model)) throw new Error('Selected model absent from service list');
  const report=await sampleProvider(apiKey,settings,source); report.models=models;
  await mkdir('.artifacts/p1/real',{recursive:true});
  await writeFile(`.artifacts/p1/real/provider-${report.capturedAt.replaceAll(/[:.]/g,'-')}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(!report.mappedAll) process.exitCode=1;
  }
}
