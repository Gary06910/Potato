'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CLIENT_IDS, FORK_ONLY_CLIENT_IDS } = require('../../src/shared/clientCatalog');
const { SOURCE_MARKERS } = require('../../src/shared/clientSourceRegistration');
const { sourceRegistryFingerprint } = require('../../src/shared/clientSourceFingerprint');
const { clientSourceRoots, clientSourceChecks, watchIgnoreMatcher, watchAttributionRootsForClients, clientsForWatchPath, startCollector } = require('../../src/shared/collector');
const { assertQoderCnSourceReadable } = require('../../src/shared/providers/qodercn/sourceGuard');
const { catpawDataSources } = require('../../src/shared/providers/catpaw/paths');
const { isolatedProbeEnv } = require('../../src/shared/tokscaleProbeEnv');
const { CUSTOM_SCAN_CLIENT_IDS } = require('../../src/shared/customScanPaths');
const { clientHealthPlaceholderDetail } = require('../../src/electron/renderer/clientHealthPresentation');
const { visibleDiagnosticRoots } = require('../../src/shared/clientSourceObservations');
const home = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'potato-p13-'));

test('Devin database evidence and DB/WAL/SHM attribution agree with concrete scan roots', () => {
  const h = home(), options = { homeDir: h, platform: process.platform, env: {} };
  const roots = clientSourceRoots('devin', options).devin;
  const cli = roots.find(r => r.id === 'devin-cli-db');
  fs.mkdirSync(cli.dir, { recursive: true });
  assert.equal(clientSourceChecks('devin', options).devin[0].exists, false);
  fs.writeFileSync(cli.sourcePath, 'fixture');
  assert.equal(clientSourceChecks('devin', options).devin[0].exists, true);
  const ignored = watchIgnoreMatcher('devin', options), attribution = watchAttributionRootsForClients('devin', null, options);
  for (const suffix of ['', '-wal', '-shm']) {
    assert.equal(ignored(cli.sourcePath + suffix), false);
    assert.deepEqual(clientsForWatchPath(cli.sourcePath + suffix, attribution), ['devin']);
  }
  assert.equal(ignored(path.join(cli.dir, 'logs', 'sessions.db')), true);
  assert.equal(ignored(path.join(cli.dir, 'other.db')), true);
});

test('WSL source markers are unique ordered valid catalog identities', () => {
  assert.equal(new Set(SOURCE_MARKERS.map(r => r.marker)).size, SOURCE_MARKERS.length);
  assert.ok(SOURCE_MARKERS.every(r => CLIENT_IDS.includes(r.client)));
  assert.deepEqual(SOURCE_MARKERS.filter(r => r.client === 'goose').map(r => r.marker), ['.local/share/goose/sessions/sessions.db', '.local/share/Block/goose/sessions/sessions.db']);
  for (const id of ['goose','muse','devin','fx','mcode','pi','omp','mimo']) assert.ok(SOURCE_MARKERS.some(r => r.client === id), id);
});

test('unsupported custom scan controls cannot claim Goose/MCode/fork support', () => {
  for (const id of ['goose','mcode',...FORK_ONLY_CLIENT_IDS]) assert.ok(!CUSTOM_SCAN_CLIENT_IDS.includes(id));
  for (const id of ['muse','devin','fx']) assert.ok(CUSTOM_SCAN_CLIENT_IDS.includes(id));
});

test('empty CatPaw edition directories are watch anchors but never detected usage sources', () => {
  const h=home(), options={homeDir:h,platform:'win32',env:{HOME:h},windowsFolders:{profile:h,roaming:path.join(h,'AppData','Roaming')}};
  for (const dir of catpawDataSources(options).roots) fs.mkdirSync(dir,{recursive:true});
  assert.deepEqual(clientSourceChecks('catpaw',options).catpaw,[{id:'catpaw-db',exists:false}]);
  const detail=clientHealthPlaceholderDetail({sources:visibleDiagnosticRoots('catpaw',options).catpaw});
  assert.equal(detail.groups[0].state,'missing');
});

test('source fingerprints invalidate custom roots and CatPaw account additions/removals', () => {
  const h=home(), options={homeDir:h,platform:'darwin',env:{}};
  const first=sourceRegistryFingerprint('catpaw,codex',options);
  assert.notEqual(first,sourceRegistryFingerprint('catpaw,codex',{...options,customScanPaths:{codex:['/tmp/p13-extra']}}));
  const dir=catpawDataSources(options).roots[0];fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'catpaw-memory-account.db');fs.writeFileSync(file,'fixture');
  assert.notEqual(first,sourceRegistryFingerprint('catpaw,codex',options));
  fs.renameSync(file,file+'.retained');assert.equal(first,sourceRegistryFingerprint('catpaw,codex',options));
});

test('Qoder corrupt and exclusively locked databases reject collection without parsing usage', () => {
  const h=home(), file=path.join(h,'local.db'), options={homeDir:h,env:{TOKEN_MONITOR_QODER_CN_DB_PATH:file}};
  fs.writeFileSync(file,'corrupt fixture');assert.throws(()=>assertQoderCnSourceReadable(options));
  fs.renameSync(file,file+'.retained');const db=new DatabaseSync(file);db.exec('CREATE TABLE chat_message (id INTEGER); BEGIN EXCLUSIVE');
  assert.throws(()=>assertQoderCnSourceReadable(options),/unreadable|locked/);
  db.exec('ROLLBACK');db.close();assert.doesNotThrow(()=>assertQoderCnSourceReadable(options));
});

test('fork-only probe clears mixed-case path overrides and isolates every source', () => {
  const h=home(), env=isolatedProbeEnv(h,{Tokscale_Extra_Dirs:'qodercn:C:/private',Token_Monitor_Qoder_Cn_Db_Path:'C:/private.db',HOME:'C:/private'});
  assert.equal(env.HOME,h);assert.equal(env.Tokscale_Extra_Dirs,undefined);assert.equal(env.Token_Monitor_Qoder_Cn_Db_Path,undefined);
  assert.ok(env.APPDATA.startsWith(h));assert.ok(env.TOKSCALE_CONFIG_DIR.startsWith(h));
});

test('continuous account changes discard both mixed scans, replay once and recover on next request', async t => {
  const h=home(), options={homeDir:h,platform:'darwin',env:{}};
  const dir=catpawDataSources(options).roots[0];fs.mkdirSync(dir,{recursive:true});
  let calls=0,churn=true;const updates=[];
  const handle=startCollector({...options,clients:'catpaw',deviceId:'test',allTimeSince:'2024-01-01',intervalMs:3600000,watchEnabled:false,historyEnabled:false,wslScanEnabled:false,anchorPersistenceEnabled:false,
    runTokscale:async()=>{calls++;if(churn&&calls%3===1)fs.writeFileSync(path.join(dir,`catpaw-memory-a${calls}.db`),'');return {entries:[{client:'catpaw',model:'m',input:10}]};},onUpdate:s=>updates.push(s)});
  t.after(()=>handle.stop());await handle.whenIdle();assert.equal(calls,6);assert.equal(updates.length,0);
  churn=false;assert.equal(await handle.tick('manual'),true);assert.equal(calls,9);assert.equal(updates.length,1);
});

test('a CatPaw source change during graph collection cannot persist a mixed history archive', async t => {
  const h=home(), options={homeDir:h,platform:'darwin',env:{}};
  const dir=catpawDataSources(options).roots[0];fs.mkdirSync(dir,{recursive:true});
  let graphs=0;const writes=[],updates=[];
  const handle=startCollector({...options,clients:'catpaw',deviceId:'test',allTimeSince:'2024-01-01',intervalMs:3600000,watchEnabled:false,historyEnabled:true,wslScanEnabled:false,anchorPersistenceEnabled:false,dailyHistoryArchiveEnabled:true,
    dailyHistoryArchiveOptions:{path:path.join(h,'daily.json'),readJson:()=>({}),writeJsonAtomic:(_file,value)=>writes.push(JSON.stringify(value))},
    runTokscale:async()=>({entries:[{client:'catpaw',model:'m',input:10}]}),
    runGraph:async()=>{graphs++;if(graphs===1)fs.writeFileSync(path.join(dir,'catpaw-memory-added.db'),'');return {contributions:[{date:'2026-08-20',clients:[{client:'catpaw',modelId:'m',tokens:{input:graphs===1?999:10},messages:1,cost:0}]}]};},onUpdate:s=>updates.push(s)});
  t.after(()=>handle.stop());await handle.whenIdle();
  assert.equal(graphs,2);assert.equal(updates.length,1);assert.ok(writes.length>0);
  assert.ok(writes.every(value=>!value.includes('999')),'discarded graph must never reach durable history');
});
