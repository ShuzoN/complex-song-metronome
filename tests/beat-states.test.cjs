const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');

function load(names = ['Domain', 'Yaml', 'SequenceMapper', 'PatternService', 'SoundGateway']) {
  const context = vm.createContext({});
  for (const name of names) {
    const start = html.indexOf(`  const ${name} = (() => {`);
    assert.ok(start >= 0, `${name} exists`);
    const end = html.indexOf('\n  })();', start) + '\n  })();'.length;
    vm.runInContext(html.slice(start, end), context);
  }
  return code => vm.runInContext(code, context);
}

test('application JavaScript parses', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    new vm.Script(match[1]);
  }
});

test('beat cycles through accent, normal, mute; mutations preserve playback references', () => {
  const run = load();
  run(`
    const group = Domain.makeGroup({rhythms: [{num: 4, den: 4, tuplet: 3}]});
    const rhythm = group.pattern.rhythms[0];
    const history = [];
    const HistoryService = {commit() { history.push(JSON.stringify(rhythm)); }};
    const Store = {findGroup: () => group, apply: fn => fn()};
  `);
  for (const expected of ['accent', 'beat', 'mute', 'accent']) {
    assert.equal(run('Domain.clickLevel(rhythm, 0, 0)'), expected);
    assert.equal(run('Domain.clickLevel(rhythm, 0, 1)'), expected === 'mute' ? 'mute' : 'sub');
    assert.equal(run('group.pattern.rhythms[0] === rhythm'), true);
    assert.equal(run('Domain.pulses(rhythm)'), 12);
    run('PatternService.cycleBeat(group.id, 0, 0)');
  }
  run('PatternService.cycleBeat(group.id, 0, 1)');
  assert.equal(run('Domain.clickLevel(rhythm, 1, 0)'), 'mute');
  assert.equal(run('history.length'), 5);
});

test('mute survives YAML round-trip and independent group duplication', () => {
  const run = load();
  run(`
    const group = Domain.makeGroup({rhythms: [{num: 4, den: 4, accents: [0], muted: [1, 3], tuplet: 3}]});
    const sequence = Domain.makeSequence({groups: [group]});
    const yaml = Yaml.stringify(SequenceMapper.toDto(sequence));
    const restored = SequenceMapper.toEntity(Yaml.parse(yaml)).sequence.groups[0].pattern.rhythms[0];
    const copy = Domain.cloneGroup(group);
  `);
  assert.equal(run('JSON.stringify(restored)'), run('JSON.stringify(group.pattern.rhythms[0])'));
  assert.equal(run('JSON.stringify(copy.pattern.rhythms[0])'), run('JSON.stringify(restored)'));
  run('copy.pattern.rhythms[0].muted.push(2)');
  assert.equal(run('group.pattern.rhythms[0].muted.length'), 2);
});

test('legacy data has no muted beats and invalid/overlapping positions normalize', () => {
  const run = load();
  run(`const old = SequenceMapper.toEntity({groups: [{pattern: ['4/4']}]}).sequence.groups[0].pattern.rhythms[0];`);
  assert.equal(run('Domain.clickLevel(old, 0, 0)'), 'accent');
  assert.equal(run('Domain.clickLevel(old, 1, 0)'), 'beat');
  assert.equal(run('JSON.stringify(old.muted)'), '[]');
  run('const normalized = Domain.makeRhythm(4, 4, [0, 1], 1, [1, 1, -1, 8, "bad"]);');
  assert.equal(run('JSON.stringify(normalized.muted)'), '[1]');
  assert.equal(run('JSON.stringify(normalized.accents)'), '[0]');
});

test('mute does not create audio nodes', () => {
  const run = load();
  run(`
    let created = 0;
    const window = {AudioContext: class {
      createOscillator() { created++; return {frequency: {}, connect() { return {connect() {}}; }, start() {}, stop() {}}; }
      createGain() { return {gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}}; }
    }};
    SoundGateway.ensure();
    SoundGateway.click('mute', 0, 0.5);
  `);
  assert.equal(run('created'), 0);
  run("SoundGateway.click('accent', 0, 0.5); SoundGateway.click('beat', 0.5, 0.5)");
  assert.equal(run('created'), 2);
});


test('denominator picker accepts standard note values and resets obsolete selections', () => {
  const run = load();
  assert.equal(run('JSON.stringify(Domain.DENOMINATORS)'), '[1,2,4,8,16,32]');
  for (const den of [1, 2, 4, 8, 16, 32]) {
    assert.equal(run(`Domain.pickerDen("${den}")`), den);
  }
  for (const value of ['5', '11', '64', '0', 'null', 'undefined', '4.5']) {
    assert.equal(run(`Domain.pickerDen(${value})`), 4);
  }
});

test('existing unusual meters survive loading and saving', () => {
  const run = load();
  run(`const sequence = SequenceMapper.toEntity({groups: [{pattern: ['4/5', '7/8', '8/11']}]}).sequence;`);
  assert.equal(run('JSON.stringify(SequenceMapper.toDto(sequence).groups[0].pattern)'), '["4/5","7/8","8/11"]');
});


function playbackHarness(video = false) {
  const run = load(['Domain', 'PlaybackService', 'PlaybackScheduler', 'Transport']);
  run(`
    const group = Domain.makeGroup({reps:2, rhythms:[{num:1, den:4}]});
    const state = {groups:[group], activeId:group.id, bpm:120};
    const Store = {getState:()=>state, findGroup:id=>state.groups.find(g=>g.id===id),
      apply: patch => Object.assign(state, patch)};
    const clearTimeout = () => {};
    let now = 0, videoTime = 12, videoState = 1;
    const clicks = [], seeks = [];
    const SoundGateway = {ensure(){}, ready:true, click:(level,time)=>clicks.push({level,time})};
    const ClockGateway = {now:()=>now, hidden:()=>false, every:()=>()=>{}, frame(){}};
    const VideoGateway = {armed:()=>${video}, time:()=>videoTime, pause(){},
      syncOn:()=>${video}, stateCode:()=>videoState};
    const VideoSync = {cancel(){}, startAtCue:(kind,cue)=>seeks.push(cue)};
  `);
  return run;
}

test('group loop repeats seamlessly and normal playback still finishes', () => {
  const run = playbackHarness();
  run(`Transport.start('solo', {loop:true}); PlaybackScheduler.pump(3);`);
  assert.equal(run('Transport.looping()'), true);
  assert.equal(run('PlaybackScheduler.finished()'), false);
  assert.equal(run('clicks.length'), 6);
  assert.equal(run('JSON.stringify(PlaybackScheduler.queue.map(e=>e.cycle))'), '[0,0,1,1,2,2]');
  assert.equal(run('clicks.every((e,i)=>i===0 || Math.abs(e.time-clicks[i-1].time-0.5)<1e-9)'), true);
  run(`Transport.stop(false); Transport.start('solo'); PlaybackScheduler.pump(3);`);
  assert.equal(run('Transport.looping()'), false);
  assert.equal(run('PlaybackScheduler.finished()'), true);
  run('now = 4; Transport.wake();');
  assert.equal(run('Transport.running()'), false);
});

test('video loop seeks to its original start and can be cancelled during seeking', () => {
  const run = playbackHarness(true);
  run(`Transport.start('solo', {loop:true}); Transport.clearArm(); Transport.beginPlayback('solo');
    PlaybackScheduler.pump(2); videoTime = 14; now = 2; Transport.wake();`);
  assert.equal(run('JSON.stringify(seeks)'), '[12,12]');
  assert.equal(run('Transport.armKind()'), 'solo');
  run('Transport.armCancel();');
  assert.equal(run('Transport.looping()'), false);
  assert.equal(run('Transport.armKind()'), null);
});

test('empty groups do not start infinite playback', () => {
  const run = playbackHarness();
  run(`group.pattern.rhythms = []; Transport.start('solo', {loop:true});`);
  assert.equal(run('Transport.running()'), false);
  assert.equal(run('Transport.looping()'), false);
});
