import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSubscriptionInfo } from '../src/subscription-info.js';
import { SubscriptionCache } from '../src/cache.js';
import { syncFromSubscriptionUrl, runSync } from '../src/sync.js';
import { createServer } from '../src/server.js';

const info='upload=12; download=34; total=1000; expire=1806474133';
const yaml='proxies:\n  - {name: node, type: ss, server: localhost, port: 1234}\nproxy-groups:\n  - {name: PROXY, type: select, proxies: [node]}\n';
async function cacheFor(t){const dir=await mkdtemp(join(tmpdir(),'fib-info-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new SubscriptionCache(dir);}

test('normalizes upstream header and rejects injection, duplicates, unsafe numbers and partial usage',()=>{
 assert.equal(normalizeSubscriptionInfo(' Download=034;upload=12; total=1000;expire=1806474133 '),info);
 for(const v of [null,'upload=1; total=2','upload=1; download=2; total=3\r\nx:1','upload=-1; download=2; total=3','upload=1; upload=2; download=2; total=3','upload=1; download=2; total=99999999999999999999'])assert.equal(normalizeSubscriptionInfo(v),null);
 assert.equal(normalizeSubscriptionInfo('upload=0;download=0;total=0'),'upload=0; download=0; total=0');
});

test('account sync captures headers from the same single YAML download',async t=>{
 const cache=await cacheFor(t);let downloads=0;
 await runSync({cache,fib:{baseUrl:'https://example.com',email:'test@example.com',password:'test'},fetchImpl:async url=>{
  if(url.endsWith('/auth/login')||url.endsWith('/user/checkin'))return new Response('{"ret":1}');
  if(url.endsWith('/user'))return new Response('<button data-clipboard-text="https://sub.example.com/once">Clash</button>');
  downloads++;return new Response(yaml,{headers:{'subscription-userinfo':info}});
 }});
 assert.equal(downloads,1);assert.equal((await cache.readMetadata()).subscriptionUserinfo,info);
});

test('manual sync, failure preservation, missing headers and history rollback keep version-specific info',async t=>{
 const cache=await cacheFor(t);
 const first=await syncFromSubscriptionUrl({cache,subscriptionUrl:'https://example.com/once',now:()=>new Date('2026-11-11T01:00:00Z'),fetchImpl:async()=>new Response(yaml,{headers:{'subscription-userinfo':info}})});
 await assert.rejects(syncFromSubscriptionUrl({cache,subscriptionUrl:'https://example.com/once',fetchImpl:async()=>new Response('proxies: []',{headers:{'subscription-userinfo':'upload=0;download=0;total=1'}})}));
 assert.equal((await cache.readMetadata()).subscriptionUserinfo,info);
 const second=await syncFromSubscriptionUrl({cache,subscriptionUrl:'https://example.com/once',now:()=>new Date('2026-11-11T02:00:00Z'),fetchImpl:async()=>new Response(yaml)});
 assert.equal(second.subscriptionUserinfo,null);
 assert.equal((await cache.restoreHistoryVersion(first.version)).subscriptionUserinfo,info);
 await rm(join(cache.historyDir,second.version+'.info.json'));
 assert.equal((await cache.restoreHistoryVersion(second.version)).subscriptionUserinfo,null);
});

test('GET and HEAD return cached info only after auth; concurrent-version mismatch suppresses stale info',async t=>{
 const cache=await cacheFor(t);await cache.saveSuccessfulConfig(yaml,{fetchedAt:'2026-11-11T00:00:00Z',subscriptionUserinfo:info});
 const server=createServer({cache,devices:{router:{token:'test-token'}},syncToken:'admin'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/sub/router`;
 for(const method of ['GET','HEAD']){
  const r=await fetch(base+'?token=test-token',{method});assert.equal(r.status,200);assert.equal(r.headers.get('subscription-userinfo'),info);
  if(method==='HEAD')assert.equal(await r.text(),'');else assert.match(await r.text(),/node/);
  const denied=await fetch(base,{method});assert.equal(denied.status,403);assert.equal(denied.headers.get('subscription-userinfo'),null);
 }
 await writeFile(cache.latestPath,yaml+'# changed\n');
 const mismatch=await fetch(base+'?token=test-token');assert.equal(mismatch.status,200);assert.equal(mismatch.headers.get('subscription-userinfo'),null);
});
