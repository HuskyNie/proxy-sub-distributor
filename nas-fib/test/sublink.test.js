import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSubscriptionLinks } from '../src/fib.js';
import { resolveSubscription } from '../src/sublink.js';
import { solveChallenge } from '../src/pow.js';
import { IssueState } from '../src/issue-state.js';
import { createTaskGate } from '../src/task-gate.js';
import { runSync } from '../src/sync.js';
import { SubscriptionCache } from '../src/cache.js';

const empty = { ret: 1, fp: '', box: '<button id="sublink-issue">领取订阅链接</button>' };
const ready = { ret: 1, fp: 'fingerprint', box: '<a class="sublink-import" data-import="clash" data-url="https://sub.example.com/once?a=1&amp;b=2">一键导入</a>' };
const fib = { baseUrl: 'https://fib.example.com', email: 'test@example.com', password: 'secret' };
const challenge = 'test.session.timestamp.8.signature';
const yaml = 'proxies:\n  - {name: node, type: ss, server: localhost, port: 1234, cipher: aes-128-gcm, password: test}\nproxy-groups:\n  - {name: PROXY, type: select, proxies: [node]}\nrules: [MATCH,PROXY]\n';
const json = x => new Response(JSON.stringify(x));
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'fib-issue-')); t.after(() => rm(dir, {recursive:true,force:true})); return dir; }
function options(fetchImpl, extra = {}) {
  return { html: '<div id="sublink-box"></div>', fib, cookie: 'sid=test', fetchImpl, ...extra };
}

test('modern parser selects Clash import and decodes attributes without confusing other clients', () => {
  const links = extractSubscriptionLinks('<a data-import="v2rayn" data-url="https://sub.example.com/v2">导入</a>' + ready.box);
  assert.equal(links.clash, 'https://sub.example.com/once?a=1&b=2');
  assert.throws(() => extractSubscriptionLinks('<a data-import="clash" data-url="javascript:bad">导入</a>'));
});

test('existing modern link does not request a challenge or consume quota', async () => {
  const calls = [];
  const links = await resolveSubscription(options(async url => {calls.push(url); return json(ready);}));
  assert.equal(calls.length,1); assert.match(calls[0], /\/box$/); assert.match(links.clash, /once/);
});

test('full new issuance and download saves cache once and retains sign-in workflow', async t => {
  const dir = await temp(t), calls = [], events = []; let issued = false;
  const result = await runSync({fib, cache: new SubscriptionCache(dir), eventLog: {append: async (e,d) => events.push({e,...d})}, fetchImpl: async (url, opts) => {
    const path = new URL(url).pathname; calls.push(path);
    if (path === '/auth/login') return new Response('{"ret":1}', {headers:{'set-cookie':'sid=test; Path=/'}});
    if (path === '/user/checkin') return json({ret:1,msg:'ok'});
    if (path === '/user') return new Response('<div id="sublink-box"></div>');
    if (path.startsWith('/user/sublink/')) assert.equal(opts.headers.cookie,'sid=test');
    if (path.endsWith('/box')) return json(issued ? ready : empty);
    if (path.endsWith('/challenge')) return json({ret:1,challenge});
    if (path.endsWith('/issue')) {
      assert.equal(opts.method,'POST');
      const digest = createHash('sha256').update(`${challenge}:${opts.body.get('nonce')}`).digest();
      assert.equal(digest[0],0); issued = true; return json({ret:1});
    }
    if (path === '/once') { assert.equal(opts.headers.cookie,undefined); return new Response(yaml); }
    throw Error('Unexpected request');
  }});
  assert.equal(result.proxyCount,1);
  assert.equal(calls.filter(x => x === '/once').length,1);
  assert.equal(calls.filter(x => x.endsWith('/issue')).length,1);
  assert.equal(await new SubscriptionCache(dir).readLatest(),yaml);
  assert.deepEqual(events.map(e=>e.e),['fib_sync_started','fib_checkin_succeeded','fib_issue_started','fib_issue_succeeded','fib_sync_succeeded']);
  assert.doesNotMatch(JSON.stringify(events),/secret|sid=test|signature|once\?/);
});

for (const [name, box, pattern] of [
  ['disabled', {...empty,box:'<button id="sublink-issue" disabled>领取</button>'},/unavailable/],
  ['unrecognized existing format', {...ready,box:'<span>unsupported</span>'},/not found/],
  ['invalid payload', {ret:1,box:''},/invalid/],
  ['expired session', {ret:0,msg:'请登录'},/rejected/]
]) test(`does not issue for ${name}`,async () => {
  let calls = 0;
  await assert.rejects(resolveSubscription(options(async () => { calls++; return json(box); })),pattern);
  assert.equal(calls,1);
});

test('daily limit and cooldown survive restart, and corruption fails closed',async t => {
  const dir = await temp(t); const time = new Date('2026-11-11T01:00:00Z');
  await new IssueState(dir).reserve(time);
  await assert.rejects(new IssueState(dir).reserve(new Date(+time+60000)),/cooldown/);
  for(let i=1;i<8;i++) await new IssueState(dir).reserve(new Date(+time+i*65000));
  await assert.rejects(new IssueState(dir).reserve(new Date(+time+8*65000)),/daily/);
  await new IssueState(dir).reserve(new Date(+time+86400000));
  await writeFile(join(dir,'issue-state.json'),'bad');
  await assert.rejects(new IssueState(dir).reserve(time),/unreadable/);
});

test('lost issue response is not retried and following sync reuses server-issued link',async t => {
  const dir=await temp(t);let issued=false, posts=0;
  const fetchImpl=async url=>{
    if(url.endsWith('/box'))return json(issued?ready:empty);
    if(url.endsWith('/challenge'))return json({ret:1,challenge});
    posts++;issued=true;throw Error('network lost');
  };
  const args=options(fetchImpl,{issueState:new IssueState(dir),solve:async()=> '1'});
  await assert.rejects(resolveSubscription(args),/network lost/);
  assert.match((await resolveSubscription(args)).clash,/once/);assert.equal(posts,1);
});

test('proof rejects excessive difficulty and stops on deadline',async()=>{
  await assert.rejects(solveChallenge('a.b.c.32.d'),/unsupported/);
  await assert.rejects(solveChallenge('a.b.c.24.d',{timeoutMs:1}),/timed out/);
});

test('gate coalesces simultaneous sync and serializes cache rollback, recovers after failure',async()=>{
  const gate=createTaskGate(); const seen=[];let release;
  const a=gate('account',async()=>{seen.push('sync');await new Promise(r=>release=r);throw Error('fail');});
  const b=gate('account',()=>{throw Error('duplicate');});assert.equal(a,b);
  const health=gate('health',()=>seen.push('health'));
  await Promise.resolve(); assert.deepEqual(seen,['sync']);release();
  await assert.rejects(a,/fail/);await health;
  assert.deepEqual(seen,['sync','health']);assert.equal(await gate('account',()=>42),42);
});

test('quota failure keeps previously cached YAML and records safe failure',async t=>{
  const cache=new SubscriptionCache(await temp(t));
  await cache.saveSuccessfulConfig(yaml,{fetchedAt:'2026-11-10T00:00:00Z'});
  await assert.rejects(runSync({fib,cache,fetchImpl:async url=>{
    if(url.endsWith('/auth/login')||url.endsWith('/user/checkin'))return json({ret:1});
    if(url.endsWith('/user'))return new Response('<div id="sublink-box"></div>');
    if(url.endsWith('/box'))return json(empty);
    if(url.endsWith('/challenge'))return json({ret:0,msg:'今天领取次数达到上限'});
    throw Error('unexpected');
  }}),/quota exhausted/);
  assert.equal(await cache.readLatest(),yaml);
  assert.match((await cache.readMetadata()).lastError.message,/quota/);
});

test('one-time download failure is not retried and cannot replace cache', async t => {
  const cache=new SubscriptionCache(await temp(t));let downloads=0;
  await cache.saveSuccessfulConfig(yaml,{fetchedAt:'2026-11-10T00:00:00Z'});
  await assert.rejects(runSync({fib,cache,fetchImpl:async url=>{
    if(url.endsWith('/auth/login')||url.endsWith('/user/checkin'))return json({ret:1});
    if(url.endsWith('/user'))return new Response('<div id="sublink-box"></div>');
    if(url.endsWith('/box'))return json(ready);
    downloads++;return new Response('already used',{status:410});
  }}),/HTTP 410/);
  assert.equal(downloads,1);assert.equal(await cache.readLatest(),yaml);
});

test('successful issue with missing link fails without issuing again',async t=>{
  let posts=0;
  await assert.rejects(resolveSubscription(options(async url=>{
    if(url.endsWith('/box'))return json(empty);
    if(url.endsWith('/challenge'))return json({ret:1,challenge});
    posts++;return json({ret:1});
  },{issueState:new IssueState(await temp(t)),solve:async()=> '1'})),/no Clash/);
  assert.equal(posts,1);
});
