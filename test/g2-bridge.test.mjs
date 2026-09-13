import test from 'node:test';
import assert from 'node:assert/strict';
import { G2Bridge } from '../src/g2-bridge.mjs';

function fixture() {
  const calls = []; let listener;
  const bridge = {
    onEvenHubEvent(fn) { listener = fn; return () => calls.push('unsubscribe'); },
    async createStartUpPageContainer(page) { calls.push(['start', page]); return 0; },
    async rebuildPageContainer(page) { calls.push(['display', page]); return true; },
    async audioControl(enabled, source) { calls.push(['audio', enabled, source]); return true; },
    async shutDownPageContainer(mode) { calls.push(['exit', mode]); return true; },
  };
  return { calls, bridge, emit: event => listener(event) };
}

test('G2 startup has a visible, event-capturing bounded page', async () => {
  const { calls, bridge } = fixture(); const g2 = new G2Bridge(bridge);
  await g2.start('Vault Lens\nスマートフォンで設定してください');
  await g2.start('duplicate');
  assert.equal(calls.filter(x => x[0] === 'start').length, 1);
  assert.equal(calls[0][1].textObject[0].isEventCapture, 1);
  assert.ok(calls[0][1].textObject[0].content.includes('設定'));
  await g2.dispose();
});

test('G2 zero-valued gestures normalize without treating audio/empty events as clicks', async () => {
  const f = fixture(); const gestures = [];
  const g2 = new G2Bridge(f.bridge, { onGesture: x => gestures.push(x) });
  await g2.start('hello');
  f.emit({}); f.emit({ audioEvent: { audioPcm: new Uint8Array([0, 0]) } });
  f.emit({ textEvent: {} }); f.emit({ textEvent: { eventType: 0 } });
  f.emit({ sysEvent: { eventType: 4 } }); f.emit({ sysEvent: { eventType: 5 } });
  f.emit({ textEvent: { eventType: 3 } });
  assert.deepEqual(gestures, ['click', 'click', 'double']);
  await g2.dispose();
});

test('G2 records bounded PCM, stops the mic and discards buffers on exit', async () => {
  const f = fixture(); const g2 = new G2Bridge(f.bridge);
  await g2.start('hello'); await g2.startRecording();
  f.emit({ audioEvent: { audioPcm: new Uint8Array([1, 2, 3, 4]) } });
  assert.deepEqual(await g2.stopRecording(), new Uint8Array([1, 2, 3, 4]));
  assert.equal(g2.bytes, 0); await g2.startRecording();
  f.emit({ audioEvent: { audioPcm: new Uint8Array([5, 6]) } });
  await g2.rootExit(); assert.equal(g2.bytes, 0);
  assert.deepEqual(f.calls.at(-1), ['exit', 1]);
  await g2.dispose();
});

test('G2 surfaces startup and microphone failures', async () => {
  const f = fixture(); const g2 = new G2Bridge(f.bridge);
  await assert.rejects(g2.startRecording(), /先に/);
  f.bridge.createStartUpPageContainer = async () => 1;
  await assert.rejects(g2.start('x'), /作成できません/);
  assert.equal(g2.ready, false);
});
