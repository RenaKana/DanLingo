import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { settingsSection } from './settings-navigation.mjs';

export async function verifySettings({options,rpc,report,root,endpoint,settings,setMode,release}) {
  const checks={};
  const waitForRequest=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('Mock request was not received');await new Promise(done=>setTimeout(done,25));}};
  const status=options.locator('#test-result');
  const storage=()=>options.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
  const waitIdle=()=>options.waitForFunction(()=>!document.getElementById('test-model').disabled);
  const getModels=async()=>{await settingsSection(options,'service');await options.locator('#get-models').click();await waitIdle();};
  const test=async()=>{await settingsSection(options,'service');await options.locator('#test-model').click();await waitIdle();};
  const priorStorage=await storage(),priorOverview=await rpc({type:'overview'});
  await getModels();
  assert.equal(await options.locator('#model-list').evaluate(node=>node.tagName),'SELECT');
  assert.deepEqual(await options.locator('#model-list option').evaluateAll(nodes=>nodes.map(n=>n.value)),['deterministic-mock','second-mock','']);
  await options.locator('#model-list').selectOption('second-mock');
  await settingsSection(options,'advanced');await options.locator('#profile').evaluate(el=>el.closest('details').open=true);await options.locator('#profile').selectOption('deepseek');await settingsSection(options,'service');
  await options.locator('#thinking-effort').selectOption('high');
  const saveStatus=await options.locator('#result').textContent();assert.match(saveStatus,/未保存/);
  await test();
  assert.match(await status.textContent(),/second-mock.*测试通过/);
  assert.equal(report.requests.at(-1).model,'second-mock');
  assert.equal(report.requests.at(-1).reasoningEffort,'high');
  assert.deepEqual(report.requests.at(-1).thinking,{type:'enabled'});
  assert.equal(report.requests.at(-1).items,1);
  assert.deepEqual(await storage(),priorStorage,'A test must not save draft settings or touch credentials');
  const afterTest=await rpc({type:'overview'});
  assert.deepEqual(afterTest.cache,priorOverview.cache);
  assert.deepEqual(afterTest.engine,priorOverview.engine);
  assert.equal(await options.locator('#result').textContent(),saveStatus);
  assert.ok(await options.locator('#models-result').evaluate(el=>el.parentElement.querySelector('#get-models')!==null));
  assert.ok(await status.evaluate(el=>el.parentElement.querySelector('#test-model')!==null));
  checks.draftTest={model:'second-mock',thinking:'high',singleRequest:true,savedKeyReused:true,storageCacheEngineUnchanged:true};
  await options.screenshot({path:resolve(root,'settings-test-success.png'),fullPage:true});

  await options.locator('#model-list').selectOption('');
  assert.equal(await options.locator('#model').inputValue(),'second-mock');
  await options.locator('#model').fill('manual-test-model');
  assert.equal(await status.textContent(),'');
  await test();assert.match(await status.textContent(),/manual-test-model.*测试通过/);
  const testedCount=report.requests.length;
  await options.locator('#model').fill('');await test();
  assert.match(await status.textContent(),/先选择或填写模型/);assert.equal(report.requests.length,testedCount);
  await options.locator('#model').fill('manual-test-model');

  for(const [mode,expected] of [['unauthorized',/拒绝 Key/],['limited',/限流/],['rejected-params',/请求参数/],['invalid-response',/响应格式/]]) {
    setMode(mode);const before=report.requests.length;await test();
    assert.match(await status.textContent(),expected);assert.equal(report.requests.length,before+1);
    assert.doesNotMatch(await status.textContent(),/private provider body/);
  }
  await options.locator('#thinking-effort').selectOption('off');
  await settingsSection(options,'advanced');await options.locator('#timeout').evaluate(el=>el.closest('details').open=true);await options.locator('#timeout').fill('1000');setMode('slow');await test();
  assert.match(await status.textContent(),/超过 1 秒/);
  assert.deepEqual((await rpc({type:'overview'})).engine,priorOverview.engine,'Testing rejected credentials must not pause the video engine');
  checks.testFailures=['401','429','422','invalid-response','timeout'];

  setMode('held');const beforeHeld=report.requests.length;
  await options.locator('#test-model').click();
  await options.waitForFunction(()=>document.getElementById('test-result').textContent.includes('正在测试'));
  await waitForRequest(()=>report.requests.length>beforeHeld);
  assert.equal(await options.locator('#get-models').isDisabled(),true);assert.equal(await options.locator('#save').isDisabled(),true);
  await options.locator('#model').fill('edited-while-testing');release();await waitIdle();
  assert.equal(await status.textContent(),'');assert.equal(await options.locator('#model').inputValue(),'edited-while-testing');
  checks.staleTestIgnored=true;

  setMode('success');await getModels();
  await options.locator('#model-list').selectOption('second-mock');
  await options.locator('#api-key').fill('temporary-test-key');
  assert.equal(await options.locator('#model').inputValue(),'second-mock');
  assert.equal(await options.locator('#model').isVisible(),true);
  assert.deepEqual(await options.locator('#model-list option').evaluateAll(nodes=>nodes.map(n=>n.value)),['']);
  await options.locator('#api-key').fill('');await getModels();
  await settingsSection(options,'advanced');await options.locator('#local-http').uncheck();
  assert.equal(await options.locator('#model-list option').count(),1);
  await options.locator('#local-http').check();
  for(const [mode,pattern] of [['models-empty',/未返回可用模型/],['models-unsupported',/未提供此模型列表接口/]]) {
    setMode(mode);await getModels();assert.match(await options.locator('#models-result').textContent(),pattern);
    assert.equal(await options.locator('#model').isVisible(),true);assert.equal(await options.locator('#model-list option').count(),1);
  }
  checks.manualAndListFailures=true;

  setMode('models-held');const queries=report.modelQueries.length;
  await options.locator('#get-models').click();
  await waitForRequest(()=>report.modelQueries.length>queries);
  await options.locator('#endpoint').fill(endpoint.replace('/v1/chat/completions','/changed/v1'));
  release();await waitIdle();
  assert.equal(await options.locator('#models-result').textContent(),'');assert.equal(await options.locator('#model-list option').count(),1);
  checks.staleListIgnored=true;

  // Exact origin binding includes the port, even though browser host grants cannot express it.
  const changedOrigin=new URL(endpoint);changedOrigin.port=String(Number(changedOrigin.port)+1);
  const calls=report.requests.length;
  const crossOrigin=await rpc({type:'test-model',settings:{...settings,endpoint:changedOrigin.href}});
  assert.equal(crossOrigin.ok,false);assert.equal(crossOrigin.error,'请为此服务填写 API Key');assert.equal(report.requests.length,calls);
  const invalidKey=await rpc({type:'test-model',settings,apiKey:'bad\nkey'});
  assert.equal(invalidKey.ok,false);assert.equal(report.requests.length,calls);
  assert.deepEqual(await storage(),priorStorage);
  checks.credentialBoundary=true;

  setMode('success');await options.locator('#endpoint').fill(endpoint);await getModels();
  await options.locator('#model-list').selectOption('second-mock');
  await options.locator('#save').click();await waitIdle();
  assert.equal((await rpc({type:'settings'})).settings.model,'second-mock');
  assert.match(await options.locator('#result').textContent(),/^已保存/);
  checks.selectedModelSaved=true;
  await options.setViewportSize({width:420,height:900});
  await getModels();await test();
  assert.ok(await options.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Settings must fit a narrow viewport');
  await options.screenshot({path:resolve(root,'settings-narrow.png'),fullPage:true});
  await options.setViewportSize({width:1440,height:1000});
  // Restore this isolated test profile for callers that run additional checks.
  await rpc({type:'save',settings,remember:false});
  console.log('PASS: settings dropdown, draft model test, failure states, credentials and stale-response isolation');
  return checks;
}
