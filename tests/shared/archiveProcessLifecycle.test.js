'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { fixture, stop } = require('../fixtures/sessionArchiveProcess');

test('archive ready precedes all file operations and retains the startup timeline', async t => {
  const f=fixture(t); const child=f.worker();
  await child.wait('ready');
  assert.deepEqual(child.diagnostics().timeline.filter(e=>e.event==='startup').map(e=>e.stage),
    ['module-entry','modules-loaded','runtime-init','memory-sqlite-query','send-ready']);
  assert.equal(require('node:fs').existsSync(f.options.databasePath),false);
  await stop(child);
  assert.deepEqual(child.diagnostics().exit,{code:0,signal:null});
  assert.equal(child.diagnostics().closed,true);
});
for(const [fault,code] of [['exit-before-ready',23],['clean-exit-before-ready',0]]) {
  test(`archive ${fault} rejects ready and preserves exact exit`,async t=>{
    const child=fixture(t).worker({lifecycleFault:fault});
    await assert.rejects(child.wait('ready'),e=> {
      // Disconnect may precede exit; the close result below is authoritative.
      assert.match(e.message,/archive child ready failed/);return true;
    });
    assert.deepEqual(await child.exited,{code,signal:null});
    await assert.rejects(child.wait('ready'), e=>e.diagnostics.exit.code===code && e.diagnostics.closed);
  });
}
test('archive spawn error rejects ready and resolves cleanup without an exit event',async t=>{
  const child=fixture(t).worker({}, {execPath:path.join(__dirname,'missing-r3-node-executable')});
  await assert.rejects(child.wait('ready'),e=>e.diagnostics.spawnError?.code==='ENOENT');
  await child.exited;
  assert.equal(child.diagnostics().timeline.some(e=>e.event==='close'),true);
});
test('archive IPC disconnect cannot satisfy ready',async t=>{
  const child=fixture(t).worker({lifecycleFault:'disconnect-before-ready'});
  await assert.rejects(child.wait('ready'),/ipc-disconnect|closed-before-message/);
  await child.exited;
  assert.equal(child.messages.some(m=>m.type==='ready'),false);
});
test('archive test cancellation rejects pending ready and records abort',async t=>{
  const controller=new AbortController();
  const child=fixture(t).worker({}, {signal:controller.signal});
  const waiting=child.wait('ready'); controller.abort();
  await assert.rejects(waiting,/test-abort/);
  assert.equal(child.diagnostics().timeline.some(e=>e.event==='test-abort'),true);
});

test('archive startup exception retains stderr and its exit code', async t => {
  const child = fixture(t).worker({ lifecycleFault: 'startup-throw' });
  await assert.rejects(child.wait('ready'), error => {
    assert.equal(error.diagnostics.exit.code, 1);
    assert.match(error.diagnostics.stderr, /synthetic archive startup exception/);
    return true;
  });
});

test('archive external termination before ready records the parent request and real exit', async t => {
  const child = fixture(t).worker({ lifecycleFault: 'hold-before-ready' });
  await child.wait('startup');
  const waiting = child.wait('ready');
  child.proc.kill('SIGTERM');
  await assert.rejects(waiting, error => {
    assert.equal(error.diagnostics.timeline.some(event => event.event === 'parent-kill-request'), true);
    assert.equal(error.diagnostics.closed, true);
    assert.deepEqual(error.diagnostics.exit, { code: null, signal: 'SIGTERM' });
    return true;
  });
});
