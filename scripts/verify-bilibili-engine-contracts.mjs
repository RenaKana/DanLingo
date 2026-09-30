/**
 * Offline checks of selected methods from pinned Bilibili DanmakuX engine sources.
 * Usage: node scripts/verify-bilibili-engine-contracts.mjs --source 1.1.21=PATH [--source 1.1.22=PATH ...]
 * The supplied files are parsed, never loaded as modules or executed as bundles.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const BUILDS = Object.freeze({
  '1.1.21': {
    lastCompiled: '2026-04-09T15:46:43+08:00',
    sha256: ['531bb3741b507f8414f92e13a13e9e29531463b7888714ce1440c02922b1282d'],
    symbols: { spread: 'wn', live: 'A', common: 'M', interact: 'B', special: 'z', hidden: 'xt',
      roll: 'S', quota: 'C', converted: 'F', density: 'J', shrink: 'I', destroyMap: 'N',
      prefix: 'H', worker: 'Gt', timeline: 'K' },
  },
  '1.1.22': {
    lastCompiled: '2026-07-14T14:26:03+08:00',
    sha256: ['f9fdb3312ebb6d489b768c0a589a36ea14e675466d58e5b37be589cab224e207'],
    symbols: { spread: 'e1', live: 'I', common: 'G', interact: 'V', special: 'Z', hidden: 'tD',
      roll: 'T', quota: 'W', converted: 'X', density: 'tu', shrink: 'N', destroyMap: '$',
      prefix: 'Q', worker: 'tQ', timeline: 'tl' },
  },
  '1.1.24': {
    lastCompiled: '2026-09-10T15:18:49+08:00',
    // Original widget and the previously verified AST-equivalent readable copy.
    sha256: ['2bf80d1994d2e6390427f79ceb0ce4d07c0fb6e832170664615be90a2a0dd9a6',
      '4cf972b4659b9e1a65d10c31555faf59daf216b99e0eae779d7820d7cb9ea4b2'],
    symbols: { spread: 'e1', live: 'I', common: 'G', interact: 'V', special: 'Z', hidden: 'tD',
      roll: 'T', quota: 'W', converted: 'X', density: 'tu', shrink: 'N', destroyMap: '$',
      prefix: 'Q', worker: 'tQ', timeline: 'tl' },
  },
});

const sha256 = source => createHash('sha256').update(source).digest('hex');

function parseArguments(args) {
  const sources = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--source' || !args[i + 1])
      throw new Error('Usage: --source 1.1.21=PATH [--source 1.1.22=PATH ...]');
    const match = /^(1\.1\.(?:21|22|24))=(.+)$/.exec(args[i + 1]);
    if (!match || sources.has(match[1])) throw new Error(`Unsupported or duplicate source: ${args[i + 1]}`);
    sources.set(match[1], match[2]);
  }
  if (!sources.size) throw new Error('Supply at least one --source VERSION=PATH');
  return sources;
}

function hasCall(node, name, firstString) {
  let found = false;
  function visit(child) {
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
        child.expression.name.text === name &&
        (firstString === undefined || ts.isStringLiteral(child.arguments[0]) &&
          child.arguments[0].text === firstString)) found = true;
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function hasNumber(node, value) {
  let found = false;
  function visit(child) {
    if (ts.isNumericLiteral(child) && Number(child.text) === value) found = true;
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function hasMember(node, name) {
  let found = false;
  function visit(child) {
    if (ts.isPropertyAccessExpression(child) && child.name.text === name) found = true;
    if (!found) ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function selectOne(candidates, name, predicate) {
  const selected = candidates.filter(predicate);
  if (selected.length !== 1) throw new Error(`${name}: expected one native method, found ${selected.length}`);
  return selected[0];
}

function objectStringProperty(node, key) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const property = node.properties.find(item => ts.isPropertyAssignment(item) &&
    (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === key);
  return property && ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
}

function extractMethods(source, path, expected, version) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`Source parse failure: ${ast.parseDiagnostics[0].messageText}`);
  const methods = [];
  const spreads = [];
  const advertised = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === expected.symbols.spread && ts.isFunctionExpression(node.initializer))
      spreads.push(node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(left.expression) &&
          left.expression.name.text === 'prototype' && ts.isFunctionExpression(node.right)) {
        methods.push({ name: left.name.text, expression: node.right });
      }
      if (ts.isIdentifier(left) && left.text === expected.symbols.spread && ts.isFunctionExpression(node.right))
        spreads.push(node.right);
      if (ts.isPropertyAccessExpression(left) && left.name.text === '__danmaku_x_metadata__')
        advertised.push(node.right);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const metadata = selectOne(methods, 'getMetadata', entry => entry.name === 'getMetadata');
  const returned = metadata.expression.body.statements.find(ts.isReturnStatement)?.expression;
  if (objectStringProperty(returned, 'version') !== version ||
      objectStringProperty(returned, 'lastCompiled') !== expected.lastCompiled ||
      advertised.length !== 1 || objectStringProperty(advertised[0], 'version') !== version ||
      objectStringProperty(advertised[0], 'lastCompiled') !== expected.lastCompiled)
    throw new Error(`Native metadata disagrees with ${version}/${expected.lastCompiled}`);
  if (spreads.length !== 1 || !hasMember(spreads[0], 'concat') || !hasMember(spreads[0], 'slice'))
    throw new Error('Native shallow-array spread helper missing or ambiguous');

  const required = {
    insert: entry => entry.name === 'insert' && hasCall(entry.expression, 'callHooks', 'beforeRender') &&
      hasCall(entry.expression, 'validate') && hasCall(entry.expression, 'initRender'),
    validate: entry => entry.name === 'validate' && hasCall(entry.expression, 'filter'),
    initRender: entry => entry.name === 'initRender' && hasCall(entry.expression, 'push'),
    fetchAndInitDm: entry => entry.name === 'fetchAndInitDm' && hasCall(entry.expression, 'getItemsByRange'),
    parseDm: entry => entry.name === 'parseDm' && hasCall(entry.expression, 'replace'),
    add: entry => entry.name === 'add' && hasCall(entry.expression, 'pushDm'),
    pushDm: entry => entry.name === 'pushDm' && hasCall(entry.expression, 'insert'),
    addList: entry => entry.name === 'addList' && hasNumber(entry.expression, 200) &&
      hasCall(entry.expression, 'postMessage'),
    getItemsByRange: entry => entry.name === 'getItemsByRange' && hasCall(entry.expression, 'getItemsByRange') &&
      hasCall(entry.expression, 'push'),
    destroy: entry => entry.name === 'destroy' && hasCall(entry.expression, 'remove') &&
      hasCall(entry.expression, 'push'),
  };
  const selected = { getMetadata: metadata.expression, spread: spreads[0] };
  for (const [name, predicate] of Object.entries(required))
    selected[name] = selectOne(methods, name, predicate).expression;
  return Object.fromEntries(Object.entries(selected).map(([name, expression]) =>
    [name, expression.getText(ast)]));
}

function createHarness(extracted, symbols) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const run = script => vm.runInContext(script, context, { timeout: 250 });
  // Only the AST-selected expressions are evaluated, never the source bundle.
  run(`globalThis.methods = {${Object.entries(extracted).map(([name, code]) =>
    `${JSON.stringify(name)}: (${code})`).join(',')}}`);
  const stub = Object.create(null);
  stub[symbols.spread] = context.methods.spread;
  stub[symbols.live] = { LiveToVod: -99 };
  stub[symbols.common] = { 1: true };
  stub[symbols.interact] = {};
  stub[symbols.special] = {};
  stub[symbols.hidden] = { hidden: 'hidden' };
  stub[symbols.roll] = { Roll: 1 };
  stub[symbols.quota] = {};
  stub[symbols.converted] = {};
  stub[symbols.density] = { validateLive({ density, pool }) {
    context.densityCalls.push({ density, pool });
    return pool !== -1;
  } };
  stub[symbols.shrink] = { HIDE: -1 };
  stub[symbols.destroyMap] = {};
  stub[symbols.prefix] = 'native-test';
  for (const [name, value] of Object.entries(stub)) context[name] = value;
  run(`globalThis.densityCalls = [];
    globalThis.document = {hidden: false};
    globalThis.scheduled = [];
    globalThis.window = {setTimeout(fn, delay) { scheduled.push({fn, delay}); return scheduled.length; }};
    globalThis.Timeline = class {
      constructor(list = []) { this.list = list; this.ranges = []; }
      reset() { this.list.length = 0; }
      insert(row) { this.list.push(row); }
      remove(row) { this.list.splice(this.list.indexOf(row), 1); }
      getItemsByRange(start, end) {
        this.ranges.push([start.stime, end.stime]);
        return this.list.filter(row => row.stime >= start.stime && row.stime < end.stime);
      }
    };
    globalThis.WorkerStub = class {
      postMessage(rows) { this.sent = JSON.parse(JSON.stringify(rows)); this.postCount = (this.postCount || 0) + 1; }
    };`);
  context[symbols.worker] = context.WorkerStub;
  context[symbols.timeline] = context.Timeline;
  return run;
}

function checkMethodContracts(run, expected, version) {
  const metadata = JSON.parse(JSON.stringify(run('methods.getMetadata()')));
  assert.deepEqual(metadata, { version, lastCompiled: expected.lastCompiled });

  const admission = JSON.parse(JSON.stringify(run(`(() => {
    const events = [], modelItems = [], modelOn = [], filterItems = [];
    const visual = {textData: {text: 'already visible'}};
    const items = [
      {text:'original',mode:1,rawMode:1,stime:10,pool:0,on:false},
      {text:'blocked',mode:1,rawMode:1,stime:10,pool:0,on:false},
      {text:'already on',mode:1,rawMode:1,stime:10,pool:0,on:true},
      {text:'density blocked',mode:1,rawMode:1,stime:10,pool:-1,on:false},
    ];
    function Model({textData, manager}) {
      events.push('model:' + textData.text); modelItems.push(textData); modelOn.push(textData.on);
      this.textData = textData; this.manager = manager; this.id = 'model';
      this.config = {container:'stage'};
      this.element = {className:'old',innerHTML:'old',style:{cssText:'old'}};
      this.spaceManager = {remove: () => events.push('remove')};
    }
    const manager = {
      config: {scene:{isMini:false},setting:{visible:true,noDanmakuXTypes:[],limit:300},
        fn:{filter(item) {filterItems.push(item); events.push('filter:' + item.text);
          return item.text === 'blocked';}}},
      container:{ownerDocument:{hidden:false}}, currentTime:10, shrinkState:0,
      danmakuFilterInfo:{}, visualArray:[visual], cDmlist:[], cycleDoms:{stage:[]},
      modeMap:{1:{model:Model}}, limitNumber:0, squareArea:1,
      getRollDanmakuMaxCountPerSecond() {return 100;},
      danmaku:{callHooks(name,shown,pending) {
        events.push('hook:' + name);
        this.proof = {shownCopy:shown !== manager.visualArray, pendingCopy:pending !== items,
          shownIdentity:shown[0] === visual, itemIdentity:pending[0] === items[0],
          originalText:pending[0].text};
        shown.push({}); pending.push({text:'injected'});
      }},
      validate:methods.validate, initRender:methods.initRender,
    };
    methods.insert.call(manager, items);
    const onAfterAdmission = items.map(item => item.on);
    const created = manager.cDmlist[0];
    methods.destroy.call(created);
    return {hook:manager.danmaku.proof,events,onAfterAdmission,
      originalArrays:manager.visualArray.length === 1 && items.length === 4,
      filterIdentity:filterItems.every((item, index) => item === items[index]),
      modelIdentity:modelItems[0] === items[0], modelOn, models:modelItems.length,
      densityCalls:densityCalls.map(x => [x.density,x.pool]),
      afterDestroy:items[0].on === false && manager.cycleDoms.stage[0] === created.element,
      removed:events.includes('remove')};
  })()`)));
  assert.deepEqual(admission.hook, { shownCopy: true, pendingCopy: true, shownIdentity: true,
    itemIdentity: true, originalText: 'original' });
  assert.equal(admission.originalArrays, true);
  assert.equal(admission.filterIdentity, true);
  assert.equal(admission.modelIdentity, true);
  assert.deepEqual(admission.modelOn, [true]);
  assert.equal(admission.models, 1);
  assert.deepEqual(admission.onAfterAdmission, [true, false, true, false]);
  assert.deepEqual(admission.events.slice(0, 7), ['hook:beforeRender', 'filter:original',
    'filter:blocked', 'filter:already on', 'filter:density blocked', 'model:original', 'remove']);
  assert.deepEqual(admission.densityCalls, [[300, 0], [300, 0], [300, -1]]);
  assert.equal(admission.afterDestroy && admission.removed, true);

  const visibility = JSON.parse(JSON.stringify(run(`(() => {
    let filtered = 0, hooked = 0, modeled = 0;
    const row = {text:'hidden',mode:1,rawMode:1,pool:0,on:false};
    const manager = {
      config:{scene:{isMini:false},setting:{visible:false,noDanmakuXTypes:[],limit:300},
        fn:{filter() {filtered++; return false;}}}, container:{ownerDocument:{hidden:false}},
      danmaku:{callHooks() {hooked++;}}, danmakuFilterInfo:{}, visualArray:[],
      getRollDanmakuMaxCountPerSecond() {return 1;}, validate:methods.validate,
      initRender() {modeled++;},
    };
    methods.insert.call(manager, [row]);
    return {filtered,hooked,modeled,on:row.on};
  })()`)));
  assert.deepEqual(visibility, { filtered: 0, hooked: 1, modeled: 0, on: false });

  const rate = JSON.parse(JSON.stringify(run(`(() => {
    const rows = ['first','second','liked'].map(text =>
      ({text,mode:1,rawMode:1,pool:0,on:false,likes:text === 'liked' ? 1 : 0}));
    const accepted = [];
    const manager = {
      config:{scene:{isMini:false},setting:{visible:true,noDanmakuXTypes:[],limit:300},
        fn:{filter() {return false;}}}, container:{ownerDocument:{hidden:false}},
      danmaku:{callHooks() {}}, danmakuFilterInfo:{}, visualArray:[],
      getRollDanmakuMaxCountPerSecond() {return 1;}, validate:methods.validate,
      initRender(row) {accepted.push(row.text);},
    };
    methods.insert.call(manager, rows);
    return {accepted,states:rows.map(row => row.on),exceeded:manager.danmakuFilterInfo['dm-count-exceed-limit']};
  })()`)));
  assert.deepEqual(rate, { accepted: ['first', 'liked'], states: [true, false, true], exceeded: 1 });

  const lists = JSON.parse(JSON.stringify(run(`(() => {
    function database() {
      return {dmArray:[],cmdDmList:[],timeLine:new Timeline(),isInsertingDm:false,
        dmParser:{parseDm:methods.parseDm,parse(row) {return row;}},
        add:methods.add,pushDm:methods.pushDm,addList:methods.addList};
    }
    const small = database(), first = {text:'a\\rb',stime:1};
    small.addList([first,{text:'',stime:2}]);
    const large = database();
    const originals = Array.from({length:200}, (_, i) => ({text:'row' + i,stime:i}));
    large.addList(originals);
    const beforeReply = {count:large.dmArray.length, original:large.dmArray[0] === originals[0],
      timelineEmpty:large.timeLine.list.length === 0, pending:large.isInsertingDm,
      workerPosts:large.worker.postCount, workerClone:large.worker.sent[0] !== originals[0]};
    large.addList([{text:'retry',stime:300}, ...originals]);
    const deferred = {delay:scheduled.at(-1)?.delay, posts:large.worker.postCount};
    large.worker.onmessage({data:large.worker.sent});
    return {small:{text:first.text,dbIdentity:small.dmArray[0] === first,
      timelineIdentity:small.timeLine.list[0] === first, count:small.dmArray.length,
      worker:small.worker === undefined},beforeReply,deferred,
      afterReply:{timelineCount:large.timeLine.list.length,
        timelineClone:large.timeLine.list[0] !== originals[0],
        dbIdentity:large.dmArray[0] === originals[0],pending:large.isInsertingDm}};
  })()`)));
  assert.deepEqual(lists, {
    small:{text:'ab',dbIdentity:true,timelineIdentity:true,count:1,worker:true},
    beforeReply:{count:200,original:true,timelineEmpty:true,pending:true,workerPosts:1,workerClone:true},
    deferred:{delay:5000,posts:1},
    afterReply:{timelineCount:200,timelineClone:true,dbIdentity:true,pending:false},
  });

  const windowing = JSON.parse(JSON.stringify(run(`(() => {
    const timeline = new Timeline([{text:'old',stime:9.8},{text:'first',stime:10.25},
      {text:'next',stime:11.25},{text:'seek',stime:15},{text:'future',stime:20.5}]);
    const cmd = {text:'command',stime:9.5,duration:2,on:false};
    const db = {timeLine:timeline,cmdDmList:[cmd],getItemsByRange:methods.getItemsByRange};
    const calls = [];
    const manager = {lastTime:0,config:{setting:{videoSpeed:1,preTime:1,speedSync:true,
      speedPlus:1,duration:6,limit:300}},containerSize:{width:512},dataBase:db,
      insert(items,override) {calls.push({items:items.map(item => item.text),override,
        effectiveLimit:this.config.setting.limit});}};
    methods.fetchAndInitDm.call(manager, 9, 10, undefined);
    methods.fetchAndInitDm.call(manager, 9.5, 10.5, undefined);
    methods.fetchAndInitDm.call(manager, 20, 20, 20);
    return {ranges:timeline.ranges.map(bounds => bounds.map(value => Number(value.toFixed(3)))),
      calls,restoredLimit:manager.config.setting.limit};
  })()`)));
  assert.deepEqual(windowing.ranges, [[9.999, 10.999], [10.998, 11.499], [14, 20.999]]);
  assert.deepEqual(windowing.calls, [
    { items:['first','command'], effectiveLimit:300 },
    { items:['next','command'], effectiveLimit:300 },
    { items:['seek','future'], override:10000, effectiveLimit:10000 },
  ]);
  assert.equal(windowing.restoredLimit, 300);

  return {
    metadata: true,
    beforeRenderShallowArraysAndOriginalIdentity: true,
    originalTextFilterThenOnThenModel: true,
    nativeModelDestroyClearsOn: true,
    visibilityAndRollLimit: true,
    smallListOriginalIdentityVsWorkerClones: true,
    forwardAndSeekWindows: true,
  };
}

async function checkSource(version, path) {
  const expected = BUILDS[version];
  if ((await stat(path)).size > 3_000_000) throw new Error(`${version}: source exceeds 3 MB bound`);
  const bytes = await readFile(path);
  const hash = sha256(bytes);
  if (!expected.sha256.includes(hash)) throw new Error(`${version}: unsupported SHA-256 ${hash}`);
  const extracted = extractMethods(bytes.toString('utf8'), path, expected, version);
  const run = createHarness(extracted, expected.symbols);
  const assertions = checkMethodContracts(run, expected, version);
  return { version, lastCompiled:expected.lastCompiled, source:path, sha256:hash,
    methods:Object.fromEntries(Object.entries(extracted).map(([name, code]) => [name, sha256(code)])),
    assertions };
}

try {
  const sources = parseArguments(process.argv.slice(2));
  const results = [];
  for (const [version, path] of sources) results.push(await checkSource(version, path));
  console.log(JSON.stringify({ contract:'bilibili-official-engine-extracted-v1', passed:true, results,
    limits:['Pinned source snapshots and isolated native methods with stubbed DOM, renderer, parser, worker and timeline;',
      'worker cloning is modeled by JSON round-trip; this is not native browser, controller-rule, first-pixel, or site-runtime proof.'] }, null, 2));
} catch (error) {
  console.error(`Official engine contract check failed: ${error.stack || error}`);
  process.exitCode = 1;
}
