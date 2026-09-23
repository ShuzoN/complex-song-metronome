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

test('deleting meters stops at one and blocked deletion leaves undo history intact', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'PatternService']);
  run(`const group=Domain.makeGroup({rhythms:[{num:3,den:4},{num:7,den:8}]});
    Store.apply({groups:[group]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    PatternService.removeRhythm(group.id,0);
    PatternService.removeRhythm(group.id,0);
  `);
  assert.equal(run('Store.findGroup(group.id).pattern.rhythms.length'), 1);
  assert.equal(run('Store.findGroup(group.id).pattern.rhythms[0].num'), 7);
  run('HistoryService.undo()');
  assert.equal(run('Store.findGroup(group.id).pattern.rhythms.length'), 2);
  run('HistoryService.redo()');
  assert.equal(run('Store.findGroup(group.id).pattern.rhythms.length'), 1);
});

test('empty or invalid imported patterns receive one default meter', () => {
  const run = load();
  for (const pattern of ['[]', '["invalid"]', 'null']) {
    run(`var result=SequenceMapper.toEntity({groups:[{pattern:${pattern}}]});`);
    assert.equal(run('result.sequence.groups[0].pattern.rhythms.length'), 1);
    assert.equal(run('Domain.formatRhythm(result.sequence.groups[0].pattern.rhythms[0])'), '4/4');
    assert.ok(run('result.notes.some(n=>n.includes("4/4"))'));
  }
  assert.equal(run('SequenceMapper.toEntity({groups:[]}).sequence.groups[0].pattern.rhythms.length'), 1);
  assert.equal(run('Domain.makeGroup().pattern.rhythms.length'), 1);
});

test('meter editing preserves remaining beat settings, supports undo and persists', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'PatternService', 'Yaml', 'SequenceMapper']);
  run(`const Transport={running:()=>false};
    const group=Domain.makeGroup({rhythms:[{num:7,den:8,accents:[0,4],muted:[1,6],tuplet:3}]});
    Store.apply({groups:[group]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    PatternService.setMeter(group.id,0,3,4);
  `);
  assert.equal(run('JSON.stringify(Store.findGroup(group.id).pattern.rhythms[0])'),
    '{"num":3,"den":4,"muted":[1],"accents":[0],"tuplet":3}');
  run('HistoryService.undo()');
  assert.equal(run('Store.findGroup(group.id).pattern.rhythms[0].num'), 7);
  assert.equal(run('JSON.stringify(Store.findGroup(group.id).pattern.rhythms[0].muted)'), '[1,6]');
  run(`HistoryService.redo(); PatternService.setMeter(group.id,0,5,8);
    const saved=SequenceMapper.toEntity(Yaml.parse(Yaml.stringify(SequenceMapper.toDto(
      Domain.makeSequence({groups:Store.getState().groups})
    )))).sequence.groups[0].pattern.rhythms[0];`);
  assert.equal(run('saved.num'), 5);
  assert.equal(run('saved.den'), 8);
  assert.equal(run('Domain.clickLevel(saved,4,0)'), 'beat');
  assert.equal(run('saved.tuplet'), 3);
  run('PatternService.setMeter(group.id,0,4,5)');
  assert.equal(run('Store.findGroup(group.id).pattern.rhythms[0].den'), 8);
  run('Transport.running=()=>true; PatternService.setMeter(group.id,0,4,4)');
  assert.equal(run('Store.findGroup(group.id).pattern.rhythms[0].num'), 5);
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
  const run = load(['Domain', 'SpeedService', 'PlaybackService', 'PlaybackScheduler', 'Transport']);
  run(`
    const group = Domain.makeGroup({reps:2, rhythms:[{num:1, den:4}]});
    const state = {groups:[group], activeId:group.id, bpm:120};
    const Store = {getState:()=>state, findGroup:id=>state.groups.find(g=>g.id===id),
      apply: patch => Object.assign(state, patch)};
    const clearTimeout = () => {};
    let now = 0, videoTime = 12, videoState = 1, videoRate = 1, requestedRate = null;
    const clicks = [], seeks = [];
    const SoundGateway = {ensure(){}, retimePending(){}, cancelPending(){}, ready:true, click:(level,time)=>clicks.push({level,time})};
    const ClockGateway = {now:()=>now, hidden:()=>false, every:()=>()=>{}, frame(){}};
    const VideoGateway = {armed:()=>${video}, time:()=>videoTime, rate:()=>videoRate, rates:()=>[0.5,1,1.25,1.5,2], setRate:r=>{requestedRate=r;}, pause(){},
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

test('practice speed normalizes input without changing song BPM and survives stop', () => {
  const run = playbackHarness();
  for (const [value, expected] of [['80',80], ['82.7',83], ['0',50], ['999',150], ['NaN',150], ['Infinity',150], ['""',150]]) {
    run(`SpeedService.setPercent(${value})`);
    assert.equal(run('SpeedService.percent()'), expected);
  }
  run(`SpeedService.setPercent(80); Transport.start('solo'); Transport.stop(false);`);
  assert.equal(run('SpeedService.rate()'), 0.8);
  assert.equal(run('state.bpm'), 120);
  assert.equal(run('group.bpm'), null);
});

test('speed scales group ramps and tuplets while video coordinates remain unscaled', () => {
  const run = playbackHarness();
  run(`group.bpm=120; group.toBpm=160; group.reps=1;
    group.pattern.rhythms=[Domain.makeRhythm(2,4,[0],2)];
    SpeedService.setPercent(80); Transport.start('solo'); PlaybackScheduler.pump(3);`);
  assert.equal(run('JSON.stringify(PlaybackScheduler.queue.map(e=>e.bpm))'), '[96,96,128,128]');
  assert.ok(Math.abs(run('clicks[1].time-clicks[0].time') - 60/96/2) < 1e-9);
  assert.ok(Math.abs(run('clicks[3].time-clicks[2].time') - 60/128/2) < 1e-9);
  assert.equal(run('PlaybackService.at(1).vt'), 0.25);
  assert.equal(run('group.bpm'), 120);
  assert.equal(run('group.toBpm'), 160);
});

test('live speed changes rescale queued beats and completion, including loops', () => {
  const run = playbackHarness();
  run(`Transport.start('solo'); PlaybackScheduler.pump(1); now=0.25;
    SpeedService.setPercent(50); PlaybackScheduler.syncRate(now);`);
  assert.ok(Math.abs(run('PlaybackScheduler.queue[1].time') - 0.79) < 1e-9);
  assert.ok(Math.abs(run('PlaybackScheduler.endTime()') - 1.79) < 1e-9);
  assert.equal(run('PlaybackScheduler.queue[1].bpm'), 60);
  run(`Transport.stop(false); now=0; Transport.start('solo',{loop:true}); PlaybackScheduler.pump(3);`);
  assert.equal(run('PlaybackScheduler.finished()'), false);
  assert.equal(run('clicks.slice(-3).every((e,i,a)=>!i || Math.abs(e.time-a[i-1].time-1)<1e-9)'), true);
});

test('video speed uses confirmed rate only and rejects unsupported selections', () => {
  const run = playbackHarness(true);
  run('SpeedService.setPercent(80); SpeedService.setVideoRate(0.8);');
  assert.equal(run('requestedRate'), null);
  run('SpeedService.setVideoRate(0.5);');
  assert.equal(run('requestedRate'), 0.5);
  assert.equal(run('SpeedService.rate()'), 1);
  run('videoRate=0.5;');
  assert.equal(run('SpeedService.rate()'), 0.5);
  assert.equal(run('Transport.countInFor(group).bpm'), 60);
  assert.equal(run('Transport.countInFor(group).dur'), 1);
  run('VideoGateway.armed=()=>false;');
  assert.equal(run('SpeedService.rate()'), 0.8);
});

test('future audio nodes are cancelled and rescheduled on a live speed change', () => {
  const run = load(['SoundGateway']);
  run(`const nodes=[];
    const window={AudioContext:class {
      currentTime=0.25;
      createOscillator(){ const n={frequency:{}, connect(){return {connect(){}};}, start(t){this.startTime=t;},
        stop(t){this.stopTime=t;}, disconnect(){}}; nodes.push(n); return n; }
      createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},disconnect(){}};}
    }};
    SoundGateway.ensure(); SoundGateway.click('beat',0.1,0.5); SoundGateway.click('beat',0.5,0.5);
    SoundGateway.retimePending(0.25,2);`);
  assert.equal(run('nodes.length'), 3);
  assert.equal(run('nodes[1].stopTime'), undefined);
  assert.equal(run('nodes[2].startTime'), 0.75);
  assert.ok(run('nodes[0].stopTime') > 0.1);
  run('SoundGateway.cancelPending();');
  assert.equal(run('nodes[2].stopTime'), undefined);
});

test('video count-in and recorded cues convert between video seconds and wall seconds', () => {
  const run = load(['Domain','SpeedService','VideoSync']);
  run(`let videoRate=0.5, target=null, frame=null, args=null;
    const group={reps:1,repCues:[null]};
    const Store={findGroup:()=>group};
    const VideoGateway={armed:()=>true,rate:()=>videoRate,time:()=>10,ready:()=>true,
      seekTo:t=>{target=t;},play(){},stateCode:()=>1};
    const ClockGateway={now:()=>4,perf:()=>0,frame:fn=>{frame=fn;}};
    const Transport={soloTarget:()=>group,countInFor:()=>({dur:4}),clearArm(){},beginPlayback:(kind,o)=>{args=o;}};
    VideoSync.init({view:{status(){},videoMsg(){},stampCueView(){}}});
    VideoSync.startAtCue('solo',12);`);
  assert.ok(Math.abs(run('target') - 9.87) < 1e-9);
  run('frame();');
  assert.equal(run('args.countIn'), true);
  assert.equal(run('args.adjust'), -0.05);
  run('VideoSync.stampCue("g",0,3);');
  assert.equal(run('group.cue'), 9.5);
});

test('whole-sequence playback scales every group without clamping or altering saved BPM', () => {
  const run = load(['Domain','Store','SpeedService','PlaybackService','PlaybackScheduler','Yaml','SequenceMapper','SequenceIO']);
  run(`const clicks=[];
    const VideoGateway={armed:()=>false,url:()=>''};
    const Transport={running:()=>false};
    const SoundGateway={click:(level,time)=>clicks.push(time)};
    Store.apply({bpm:50,groups:[Domain.makeGroup({bpm:50,reps:1,rhythms:[{num:2,den:4}]}),
      Domain.makeGroup({bpm:250,reps:1,rhythms:[{num:2,den:4}]})]});
    const before=Yaml.stringify(SequenceMapper.toDto(SequenceIO.currentSequence()));
    SpeedService.setPercent(50); PlaybackService.update('all',null); PlaybackScheduler.prime(0); PlaybackScheduler.pump(10);`);
  assert.equal(run('JSON.stringify(PlaybackScheduler.queue.map(e=>e.bpm))'), '[25,25,125,125]');
  run('SpeedService.setPercent(150); PlaybackScheduler.prime(0); PlaybackScheduler.pump(10);');
  assert.equal(run('JSON.stringify(PlaybackScheduler.queue.map(e=>e.bpm))'), '[75,75,375,375]');
  assert.equal(run('Yaml.stringify(SequenceMapper.toDto(SequenceIO.currentSequence()))===before'), true);
});

test('new groups capture the current BPM and retain it after global tempo changes and saving', () => {
  const run = load(['Domain', 'Store', 'SequenceService', 'Yaml', 'SequenceMapper']);
  run(`const HistoryService={commit(){}};
    SequenceService.setTempo(179); SequenceService.addGroup();
    const first=Store.findGroup(Store.getState().activeId);
    SequenceService.setTempo(185.5); SequenceService.addGroup();
    const second=Store.findGroup(Store.getState().activeId);
    const restored=SequenceMapper.toEntity(Yaml.parse(Yaml.stringify(SequenceMapper.toDto(
      Domain.makeSequence({tempo:185.5,groups:[first,second]})
    )))).sequence;
  `);
  assert.equal(run('first.bpm'), 179);
  assert.equal(run('Domain.effectiveBpm(first,185.5)'), 179);
  assert.equal(run('second.bpm'), 185.5);
  assert.equal(run('restored.groups[0].bpm'), 179);
  assert.equal(run('restored.groups[1].bpm'), 185.5);
});
