// Offline index finalization for the explicitly frozen native-chat candidate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, cp, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const provenancePath = '.artifacts/live/native-chat-migration/candidate-PHkx5C/provenance.json';
const provenance = await json(provenancePath);
for (const [file, digest] of Object.entries(provenance.sourceFiles)) assert.equal(hash(await readFile(file)), digest, 'Frozen source mismatch: ' + file);
const archive = resolve('.output/danlingo-0.2.0-chrome.zip');
const manualPackage = resolve('.artifacts/live/manual-acceptance/package-6zMvne');
const manualArchive = resolve(manualPackage, 'danlingo-0.2.0-youtube-native.zip');
const bytes = await readFile(archive);
assert.equal(hash(bytes), provenance.archiveSha256);
assert.equal(hash(await readFile(manualArchive)), provenance.archiveSha256);
const packageCheck = await json('.artifacts/live/native-chat-migration/package-check.json');
assert.equal(packageCheck.status, 'PASS_ARTIFACT_CONSISTENCY');
assert.equal(packageCheck.archiveSha256, provenance.archiveSha256);
const docs = ['docs/YOUTUBE_NATIVE_CHAT_2026-09-13.md', 'docs/YOUTUBE_NATIVE_CHAT_MANUAL_2026-09-13.md'];
let checkedLinks = 0;
for (const path of docs) {
  const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|C:|#)/i.test(match[1])) continue;
    await access(resolve(dirname(path), match[1].split('#')[0])); checkedLinks++;
  }
}
const previousCandidateIndex = resolve('.artifacts/live/native-chat-migration/candidate-PHkx5C/previous-manual-index.json');
const previous = await json('.artifacts/live/current-candidate-manual.json');
if (previous.archiveSha256 !== provenance.archiveSha256) await cp('.artifacts/live/current-candidate-manual.json', previousCandidateIndex, { force:false, errorOnExist:true });
const index = {
  capturedAt:new Date().toISOString(),status:'NATIVE_CHAT_FUNCTIONAL_CANDIDATE_MANUAL_ACCEPTANCE_PENDING',version:'0.2.0',
  archive,build:resolve('.output/chrome-mv3'),archiveSha256:hash(bytes),archiveBytes:bytes.length,manualArchive,manualPackage,
  sourceProvenance:provenancePath,sourceHashes:provenance.sourceFiles,previousCandidateIndex,
  manualGuide:docs[1],report:docs[0],documentationLinksChecked:checkedLinks,
  evidence:{coreTests:314,niconicoNativeTests:28,typecheck:'PASS',
    fixtures:['.artifacts/live/native-chat/fixture-chromium-6LKnhP/report.json','.artifacts/live/native-chat/fixture-edge-ItMzdu/report.json'],
    fixtureChecksPerBrowser:13,realYoutubeLocalMock:'.artifacts/live/native-real/verify-RxoNm4/report.json',
    packageConsistency:'.artifacts/live/native-chat-migration/package-check.json',credentialScan:'.artifacts/live/credential-scans/run-YEquQj/report.json'},
  actualProviderRequestsThisStage:0,browserControl:'nodeRepl.fetch request failed; daily Chrome not connected',
  incomplete:['Daily logged-in Chrome acceptance and separate real Edge lifecycle matrix','Real Provider translation quality and C32 four-buffer fixed-window performance',
    '60 events/s, 60-second repeated and low-repeat controlled load with production quotas','Two active rooms and native chat reconnection/fullscreen/scroll/filter acceptance',
    'Actual installation, permissions and same-ID 0.1.0 upgrade with remembered settings/Key'],
};
for(const path of ['.artifacts/live/current-candidate-native-chat.json','.artifacts/live/current-candidate-manual.json'])await writeFile(path,JSON.stringify(index,null,2)+'\n');
console.log(JSON.stringify({status:index.status,archiveSha256:index.archiveSha256,archiveBytes:bytes.length,checkedLinks}));
