import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { transformClashYaml } from '../src/clash.js';
const options = {chainGroups:[{name:'chain',targetGroup:'global',secondHopPattern:'^TK$',firstHops:[{name:'XX2-TK',includePattern:'^XX2$'},{name:'WX-TK',includePattern:'^WX$'}]}]};
function render(names,opts=options) {
 return YAML.parse(transformClashYaml(YAML.stringify({proxies:names.map(name=>({name,type:'ss',server:'example.com',port:443})), 'proxy-groups':[{name:'global',type:'select',proxies:names}]}),opts));
}
test('missing first hop skips only unavailable chain',()=>{
 const out=render(['XX2','TK']);
 assert.deepEqual(out['proxy-groups'].find(g=>g.name==='chain').proxies,['XX2-TK']);
 assert.equal(out.proxies.find(p=>p.name==='XX2-TK')['dialer-proxy'],'XX2');
 assert.ok(!out.proxies.some(p=>p.name==='WX-TK'));
});
for(const names of [['TK'],['XX2'],['other']]) test(`no usable chain leaves base subscription intact: ${names}`,()=>{
 const out=render(names);
 assert.deepEqual(out['proxy-groups'],[{name:'global',type:'select',proxies:names}]);
 assert.deepEqual(out.proxies.map(p=>p.name),names);
});
test('ambiguous matches still fail rather than pick an arbitrary node',()=>{
 assert.throws(()=>render(['XX2','WX','TK','TK']),/exactly one proxy/);
});
test('invalid patterns remain configuration errors',()=>{
 const bad=structuredClone(options);bad.chainGroups[0].secondHopPattern='[';
 assert.throws(()=>render(['XX2','TK'],bad),/regular expression/);
});
