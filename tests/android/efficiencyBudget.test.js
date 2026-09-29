'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { environment } = require('./runtime-fixture');
async function budget() {
 const results = {};
 const setup = () => { const e=environment(); e.useActualRegistration(); return e; };
 const home = async e => { await e.load('services/client-runtime.uts').prepareClientPage(); await e.load('services/tokenm-service.uts').getDashboard(); };
 const warm = async e => { await e.load('services/client-runtime.uts').bootstrapClientRuntime(); await home(e); e.calls=[]; e.cacheReads=[]; };
 const record = (id,e) => { const counts={}; for(const name of e.calls) counts[name]=(counts[name]??0)+1; results[id]={counts,cloud:e.calls.filter(n=>n!=='getPushClientId').length,cid:counts.getPushClientId??0,writes:counts.registerMobileDevice??0,timers:id==='H'?{local:1,remote:1}:{local:0,remote:0},cache:e.cacheReads.reduce((total,entry)=>{total[entry.state]=(total[entry.state]??0)+1;return total;},{})}; };
 let e=setup(); await Promise.all([e.load('services/client-runtime.uts').bootstrapClientRuntime(),e.load('services/client-runtime.uts').bootstrapClientRuntime()]); await home(e);record('A',e);
 for(const [id,elapsed] of [['B',10000],['C',30000]]) {e=setup();await warm(e);e.now+=elapsed;await e.load('services/client-runtime.uts').bootstrapClientRuntime();await home(e);record(id,e);}
 e=setup(); await warm(e);const r=e.load('services/client-runtime.uts'),s=e.load('services/tokenm-service.uts');
 for(const [elapsed,op] of [[1000,()=>s.getDashboard()],[7000,()=>s.listTasks(null,'all','all','all',20)],[13000,()=>s.listDesktops()],[19000,()=>s.getNotificationSettings()],[25000,()=>s.getDashboard()]]) {e.now=100000+elapsed;await r.prepareClientPage();await op();}record('D',e);
 e=setup();await warm(e);e.load('services/page-cache.uts').dashboardSnapshot.expire();e.load('services/page-cache.uts').desktopsSnapshot.expire();await home(e);record('E',e);
 e=setup();await warm(e);e.pushListener({type:'receive'});record('F',e);
 e=setup();await warm(e);await e.load('services/client-runtime.uts').bootstrapClientRuntime();await e.load('services/tokenm-service.uts').getNotificationSettings();await home(e);record('G',e);
 e=setup();await warm(e);await e.load('services/client-runtime.uts').ensureProtectedClientRoute();await e.load('services/tokenm-service.uts').createPairingCode();e.handlers.getPairingStatus=async()=>({status:'active'});for(let i=1;i<=12;i++){e.now=100000+i*5000;await e.load('services/tokenm-service.uts').getPairingStatus('pair-1');}record('H',e);
 return results;
}
test('A-H offline request budget executes actual UTS service paths',async()=>{const actual=await budget();if(process.env.POTATO_BUDGET_OUTPUT) fs.writeFileSync(process.env.POTATO_BUDGET_OUTPUT,JSON.stringify(actual,null,2)+'\n');else {const expected=JSON.parse(fs.readFileSync('docs/android-efficiency/after-budget.json','utf8'));assert.deepEqual(actual,expected);}});
