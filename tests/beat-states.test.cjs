const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');

function load(names = ['Domain', 'Yaml', 'SequenceMapper', 'PatternService', 'SoundGateway']) {
  const context = vm.createContext({});
  // Domain.makeGroup がドラムの打点を正規化するため、DrumDomain は常に先に読む
  if (!names.includes('DrumDomain')) names = ['DrumDomain', ...names];
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
    const group=Domain.makeGroup({rhythms:[{num:7,den:8,accents:[0,4],muted:[1,6],tuplet:3,
      tupletAccent:[[0],[1],[2],[0,1],[0],[0],[2]]}]});
    Store.apply({groups:[group]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    PatternService.setMeter(group.id,0,3,4);
  `);
  // 拍数が減れば連符アクセント位置もその拍数まで切り詰める（増えれば拍の頭で埋める）
  assert.equal(run('JSON.stringify(Store.findGroup(group.id).pattern.rhythms[0])'),
    '{"num":3,"den":4,"muted":[1],"accents":[0],"tuplet":3,"tupletAccent":[[0],[1],[2]]}');
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
  assert.equal(run('JSON.stringify(saved.tupletAccent)'), '[[0],[1],[2],[0],[0]]');
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

test('tuplet accent position moves the beat click inside the tuplet', () => {
  const run = load();
  run(`const rhythm = Domain.makeRhythm(4, 4, [0], 3, [], 1);`);      // 全拍とも三連符の2つ目（○●○）
  assert.equal(run('JSON.stringify(rhythm.tupletAccent)'), '[[1],[1],[1],[1]]');
  assert.equal(run('Domain.clickLevel(rhythm, 0, 0)'), 'sub');
  assert.equal(run('Domain.clickLevel(rhythm, 0, 1)'), 'accent');
  assert.equal(run('Domain.clickLevel(rhythm, 0, 2)'), 'sub');
  assert.equal(run('Domain.clickLevel(rhythm, 1, 1)'), 'beat');        // アクセントの無い拍でも拍の音はここ
  assert.equal(run('Domain.clickLevel(rhythm, 1, 0)'), 'sub');
  run('const silent = Domain.makeRhythm(4, 4, [0], 3, [1], 2);');      // ミュートは拍全体に効いたまま
  for (const sub of [0, 1, 2]) {
    assert.equal(run(`Domain.clickLevel(silent, 1, ${sub})`), 'mute');
  }
  assert.equal(run('Domain.clickLevel(silent, 2, 2)'), 'beat');
});

test('one beat can carry several accent positions', () => {
  const run = load();
  // 6連符で 1拍目 ●●○○○○ ／ 2拍目 ●●○○●● ／ 3拍目 裏拍だけ ／ 4拍目 既定
  run('const rhythm = Domain.makeRhythm(4, 4, [0, 1], 6, [], [[0, 1], [0, 1, 4, 5], [], undefined]);');
  assert.equal(run('JSON.stringify(rhythm.tupletAccent)'), '[[0,1],[0,1,4,5],[],[0]]');
  assert.equal(run('JSON.stringify([0,1,2,3,4,5].map(s => Domain.clickLevel(rhythm, 0, s)))'), JSON.stringify(["accent", "accent", "sub", "sub", "sub", "sub"]));
  assert.equal(run('JSON.stringify([0,1,2,3,4,5].map(s => Domain.clickLevel(rhythm, 1, s)))'), JSON.stringify(["accent", "accent", "sub", "sub", "accent", "accent"]));
  assert.equal(run('JSON.stringify([0,1,2,3,4,5].map(s => Domain.clickLevel(rhythm, 2, s)))'),   // 拍の音を置かない拍
    JSON.stringify(["sub", "sub", "sub", "sub", "sub", "sub"]));
  assert.equal(run('JSON.stringify([0,1,2,3,4,5].map(s => Domain.clickLevel(rhythm, 3, s)))'), JSON.stringify(["beat", "sub", "sub", "sub", "sub", "sub"]));
  // 重複・順不同・範囲外はそろえて落とす
  assert.equal(run('JSON.stringify(Domain.makeRhythm(1, 4, [0], 6, [], [[5, 0, 5, 9, -1]]).tupletAccent)'), '[[0,5]]');
});

test('tuplet accent position is kept per beat', () => {
  const run = load();
  // 1拍目 ○○● ／ 2拍目 ●○○ ／ 3・4拍目 ○●○ を1つの拍子に混ぜる（拍ごと1つだった頃の形）
  run('const rhythm = Domain.makeRhythm(4, 4, [0], 3, [], [2, 0, 1, 1]);');
  assert.equal(run('JSON.stringify(rhythm.tupletAccent)'), '[[2],[0],[1],[1]]');
  assert.equal(run('Domain.clickLevel(rhythm, 0, 2)'), 'accent');      // 1拍目だけアクセント指定
  assert.equal(run('Domain.clickLevel(rhythm, 0, 0)'), 'sub');
  assert.equal(run('Domain.clickLevel(rhythm, 1, 0)'), 'beat');
  assert.equal(run('Domain.clickLevel(rhythm, 1, 1)'), 'sub');
  assert.equal(run('Domain.clickLevel(rhythm, 2, 1)'), 'beat');
  assert.equal(run('Domain.uniformTupletAccent(rhythm)'), null);       // 数値へは畳めない
  assert.equal(run('JSON.stringify(Domain.tupletAccentDto(rhythm))'), '[2,0,1,1]');   // 数値の配列へは畳める
  assert.equal(run('Domain.uniformTupletAccent(Domain.makeRhythm(4, 4, [0], 3, [], 1))'), 1);
  assert.equal(run('Domain.singleTupletAccents(Domain.makeRhythm(2, 4, [0], 3, [], [[0, 1], [0]]))'), null);
  // 拍数に対して過不足のある配列は 0 埋め／切り詰め
  assert.equal(run('JSON.stringify(Domain.makeRhythm(4, 4, [0], 3, [], [2, 1]).tupletAccent)'), '[[2],[1],[0],[0]]');
  assert.equal(run('JSON.stringify(Domain.makeRhythm(2, 4, [0], 3, [], [2, 1, 0, 2]).tupletAccent)'), '[[2],[1]]');
});

test('tuplet accent position normalizes to the current division', () => {
  const run = load();
  assert.equal(run('JSON.stringify(Domain.makeRhythm(2, 4, [0], 3, [], 9).tupletAccent)'), '[[0],[0]]');   // 範囲外は落とす
  assert.equal(run('JSON.stringify(Domain.makeRhythm(2, 4, [0], 3, [], [-1, 2]).tupletAccent)'), '[[0],[2]]');
  assert.equal(run('JSON.stringify(Domain.makeRhythm(2, 4, [0], 1, [], [[1, 2], 2]).tupletAccent)'), '[[0],[0]]');  // 分割なしは常に拍の頭
  for (const value of ['undefined', 'null', '"bad"', '[null, "x"]']) {
    assert.equal(run(`JSON.stringify(Domain.makeRhythm(2, 4, [0], 3, [], ${value}).tupletAccent)`), '[[0],[0]]');
  }
  run('const legacy = SequenceMapper.toEntity({groups: [{pattern: [{meter: "4/4", tuplet: 3}]}]}).sequence.groups[0].pattern.rhythms[0];');
  assert.equal(run('JSON.stringify(legacy.tupletAccent)'), '[[0],[0],[0],[0]]');   // 旧データは従来どおり拍の頭
  assert.equal(run('Domain.clickLevel(legacy, 0, 0)'), 'accent');
  assert.equal(run('Domain.isTupletHead(legacy, 0, 0)'), true);
});

test('tuplet accent position survives YAML round-trip in every shape', () => {
  const run = load();
  const roundTrip = expr => {
    const out = run(`(() => {
      const group = Domain.makeGroup({rhythms: [${expr}]});
      const yaml = Yaml.stringify(SequenceMapper.toDto(Domain.makeSequence({groups: [group]})));
      const restored = SequenceMapper.toEntity(Yaml.parse(yaml)).sequence.groups[0].pattern.rhythms[0];
      return {yaml, same: JSON.stringify(restored) === JSON.stringify(group.pattern.rhythms[0])};
    })()`);
    assert.equal(out.same, true, '読み書きで形が変わった: ' + out.yaml);
    return out.yaml;
  };
  // 既定（全拍とも拍の頭）… キーごと書かない＝従来のファイルと同じ見た目のまま
  assert.equal(roundTrip('{num: 4, den: 4, tuplet: 3}').includes('tupletAccent'), false);
  // 全拍そろっていれば数値1つ、全拍とも位置1つなら数値の配列、複数置いた拍があれば配列の配列
  assert.match(roundTrip('{num: 4, den: 4, tuplet: 3, tupletAccent: 1}'), /tupletAccent: 1\n/);
  assert.match(roundTrip('{num: 4, den: 4, tuplet: 3, tupletAccent: [2, 0, 1, 1]}'), /tupletAccent: \[2, 0, 1, 1\]/);
  assert.match(roundTrip('{num: 2, den: 4, tuplet: 6, tupletAccent: [[0, 1], [0, 1, 4, 5]]}'),
    /tupletAccent: \[\[0, 1\], \[0, 1, 4, 5\]\]/);
  assert.match(roundTrip('{num: 2, den: 4, tuplet: 6, tupletAccent: [[0, 1], []]}'), /tupletAccent: \[\[0, 1\], \[\]\]/);
  // 複製は元と配列を共有しない
  run(`
    const src = Domain.makeGroup({rhythms: [{num: 2, den: 4, tuplet: 6, tupletAccent: [[0, 1], [2]]}]});
    const copy = Domain.cloneGroup(src);
    copy.pattern.rhythms[0].tupletAccent[0].push(5);
  `);
  assert.equal(run('JSON.stringify(src.pattern.rhythms[0].tupletAccent)'), '[[0,1],[2]]');
});

test('editing the tuplet accent keeps the playback reference and follows the division', () => {
  const run = load();
  run(`
    const group = Domain.makeGroup({rhythms: [{num: 4, den: 4, tuplet: 6}]});
    const rhythm = group.pattern.rhythms[0];
    const history = [];
    const HistoryService = {commit() { history.push(JSON.stringify(rhythm)); }};
    const Store = {findGroup: () => group, apply: fn => fn()};
    PatternService.toggleTupletAccent(group.id, 0, 0, 1);
    PatternService.toggleTupletAccent(group.id, 0, 1, 4);
  `);
  assert.equal(run('group.pattern.rhythms[0] === rhythm'), true);      // 再生中の timeline が持つ参照を保つ
  assert.equal(run('JSON.stringify(rhythm.tupletAccent)'), '[[0,1],[0,4],[0],[0]]');   // 押した拍だけ動く
  assert.equal(run('Domain.clickLevel(rhythm, 0, 1)'), 'accent');
  assert.equal(run('Domain.clickLevel(rhythm, 1, 4)'), 'beat');
  assert.equal(run('history.length'), 2);
  run('PatternService.toggleTupletAccent(group.id, 0, 0, 1);');        // もう一度押すと外れる
  assert.equal(run('JSON.stringify(rhythm.tupletAccent[0])'), '[0]');
  run('PatternService.toggleTupletAccent(group.id, 0, 0, 0);');        // 全部外した拍は裏拍だけになる
  assert.equal(run('JSON.stringify(rhythm.tupletAccent[0])'), '[]');
  assert.equal(run('Domain.clickLevel(rhythm, 0, 0)'), 'sub');
  run('PatternService.toggleTupletAccent(group.id, 0, 9, 1);');        // 拍数・分割数の外は無視する
  run('PatternService.toggleTupletAccent(group.id, 0, 1, 6);');
  assert.equal(run('JSON.stringify(rhythm.tupletAccent)'), '[[],[0,4],[0],[0]]');
  assert.equal(run('history.length'), 4);
  run('PatternService.cycleTuplet(group.id, 0);');                     // 6連符 → 7連符：位置はそのまま
  assert.equal(run('rhythm.tuplet'), 7);
  assert.equal(run('JSON.stringify(rhythm.tupletAccent)'), '[[],[0,4],[0],[0]]');
  for (let i = 0; i < 3; i++) run('PatternService.cycleTuplet(group.id, 0);');   // 8・9連符を経て分割なしへ一周
  assert.equal(run('rhythm.tuplet'), 1);
  assert.equal(run('JSON.stringify(rhythm.tupletAccent)'), '[[0],[0],[0],[0]]');   // 分割が無くなれば拍の頭へ戻る
  assert.equal(run('Domain.clickLevel(rhythm, 0, 0)'), 'accent');
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
  const run = load(['Domain', 'SpeedService', 'LatencyService', 'PlaybackService', 'PlaybackScheduler', 'Transport']);
  run(`
    const group = Domain.makeGroup({reps:2, rhythms:[{num:1, den:4}]});
    const state = {groups:[group], activeId:group.id, bpm:120};
    const Store = {getState:()=>state, findGroup:id=>state.groups.find(g=>g.id===id),
      apply: patch => Object.assign(state, patch)};
    const clearTimeout = () => {};
    let now = 0, videoTime = 12, videoState = 1, videoRate = 1, requestedRate = null;
    const clicks = [], seeks = [];
    const shifts = [];
    const SoundGateway = {ensure(){}, retimePending(){}, cancelPending(){}, shiftPending:(at,delta)=>shifts.push({at,delta}), ready:true, click:(level,time)=>clicks.push({level,time})};
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

test('video speed steps by 5% and falls back to the next supported rate when the player ignores it', () => {
  const run = playbackHarness(true);
  run('var timers=[]; var setTimeout=f=>timers.push(f);');
  run('SpeedService.requestVideoPercent(105);');
  assert.equal(run('requestedRate'), 1.05);
  run('timers.shift()();');                                   // プレイヤが 1.05 を無視 → 上方向の次の対応速度
  assert.equal(run('requestedRate'), 1.25);
  run('videoRate=1.05; requestedRate=null; SpeedService.requestVideoPercent(100); videoRate=1; timers.shift()();');
  assert.equal(run('requestedRate'), 1);                      // 反映されたら差し替えない
  run('requestedRate=null; SpeedService.requestVideoPercent(33);');
  assert.equal(run('requestedRate'), 0.5);                    // 5% 単位に丸め、対応範囲で頭打ち
  assert.equal(run('SpeedService.shown()'), 100);
  assert.equal(run('JSON.stringify(SpeedService.bounds())'), '[50,200]');
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
  const run = load(['Domain','SpeedService','LatencyService','VideoSync']);
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

test('earphone latency is clamped per device and notifies the previous and next value', () => {
  const run = load(['LatencyService']);
  run('var seen=[]; LatencyService.onChange((a,b)=>seen.push([a,b]));');
  assert.equal(run('LatencyService.ms()'), 0);
  run('LatencyService.nudge(10); LatencyService.nudge(10); LatencyService.set(9999); LatencyService.set(-9999); LatencyService.set(-200);');
  assert.equal(run('JSON.stringify(seen)'), '[[0,10],[10,20],[20,600],[600,-200]]');
  assert.equal(run('LatencyService.seconds()'), -0.2);
});

test('earphone latency moves the video aim earlier in video seconds', () => {
  const run = load(['Domain','SpeedService','LatencyService','VideoSync']);
  run(`let target=null;
    const group={reps:1,repCues:[null]};
    const VideoGateway={armed:()=>true,rate:()=>0.5,time:()=>10,ready:()=>true,seekTo:t=>{target=t;},play(){},stateCode:()=>1};
    const ClockGateway={now:()=>4,perf:()=>0,frame(){}};
    const Transport={soloTarget:()=>group,countInFor:()=>({dur:4}),clearArm(){},beginPlayback(){}};
    VideoSync.init({view:{status(){},videoMsg(){},stampCueView(){}}});
    LatencyService.set(100);
    VideoSync.startAtCue('solo',12);`);
  // 12 − (0.26 + 0.10) × 0.5 − 4 × 0.5
  assert.ok(Math.abs(run('target') - 9.82) < 1e-9);
});

test('a live latency nudge shifts queued beats and scheduled clicks uniformly', () => {
  const run = playbackHarness(true);
  run(`Transport.start('solo'); now=0; Transport.beginPlayback('solo',{skipWait:true}); PlaybackScheduler.pump(2); now=0.25;
    var before=PlaybackScheduler.queue.map(e=>e.time);
    Transport.shiftAudio(-0.1);`);
  assert.equal(run('JSON.stringify(shifts)'), '[{"at":0.25,"delta":-0.1}]');
  assert.equal(run('PlaybackScheduler.queue.every((e,i)=>before[i] <= now ? e.time===before[i] : Math.abs(e.time-(before[i]-0.1))<1e-9)'), true);
  run('Transport.stop(false); Transport.shiftAudio(-0.1);');
  assert.equal(run('shifts.length'), 1);
});

test('shifted audio nodes are rescheduled and ones pushed into the past are dropped', () => {
  const run = load(['SoundGateway']);
  run(`const nodes=[];
    const window={AudioContext:class {
      currentTime=0.25;
      createOscillator(){ const n={frequency:{}, connect(){return {connect(){}};}, start(t){this.startTime=t;},
        stop(t){this.stopTime=t;}, disconnect(){}}; nodes.push(n); return n; }
      createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},disconnect(){}};}
    }};
    SoundGateway.ensure(); SoundGateway.click('beat',0.1,0.5); SoundGateway.click('beat',0.3,0.5); SoundGateway.click('beat',0.5,0.5);
    SoundGateway.shiftPending(0.25,-0.1);`);
  assert.equal(run('nodes.length'), 4);
  assert.equal(run('nodes[0].stopTime > 0.1'), true);
  assert.ok(Math.abs(run('nodes[3].startTime') - 0.4) < 1e-9);
});

/* ---------- ドラム入力 ---------- */

test('drum parts round-trip through YAML with hits grouped per part', () => {
  const run = load(['Domain', 'Yaml', 'SequenceMapper']);
  run(`const g = Domain.makeGroup({reps:5, rhythms:[{num:4,den:4}], drums:[
      {span:2, repeat:2, hits:{kick:[0, 4, 9], snare:[1, 3, 5, 7.5], cowbell:[2]}},
      {span:1, hits:{snare:[0, 1, 2, 3, 3.5]}},
      {span:1}]});
    var text = Yaml.stringify(SequenceMapper.toDto(Domain.makeSequence({groups:[g, Domain.makeGroup({})]})));
    var back = SequenceMapper.toEntity(Yaml.parse(text)).sequence.groups;`);
  // 2小節（8拍）のパートでは 9 は外、cowbell は未知の楽器なので落とす。repeat 1 と空の hits は書かない
  assert.ok(run('text').includes(
    '    drums:\n' +
    '      - span: 2\n        repeat: 2\n        hits:\n          snare: [1, 3, 5, 7.5]\n          kick: [0, 4]\n' +
    '      - span: 1\n        hits:\n          snare: [0, 1, 2, 3, 3.5]\n' +
    '      - span: 1\n'));
  assert.equal(run('JSON.stringify(back[0].drums)'), run('JSON.stringify(g.drums)'));
  assert.equal(run('back[0].drums.length'), 3);
  // パートの無いグループは drums キーごと出さない（後方互換）
  assert.equal(run('text.split("drums:").length'), 2);
  assert.equal(run('back[1].drums.length'), 0);
  // drums を知らない古いファイル・下書きもそのまま読める
  assert.equal(run('SequenceMapper.toEntity({groups:[{pattern:["4/4"]}]}).sequence.groups[0].drums.length'), 0);
});

test('the previous flat drums format loads as a single part', () => {
  const run = load(['Domain', 'Yaml', 'SequenceMapper']);
  run(`var old = Yaml.parse('groups:\\n  - repeat: 8\\n    pattern: [4/4]\\n    drumSpan: 2\\n    drums:\\n      snare: [1, 3, 5, 7.5]\\n      kick: [0, 4]\\n' +
      '  - repeat: 2\\n    pattern: [7/8, 3/4]\\n    drums:\\n      kick: [0, 7]\\n');
    var gs = SequenceMapper.toEntity(old).sequence.groups;`);
  assert.equal(run('JSON.stringify(gs[0].drums.map(p=>[p.span,p.repeat,p.hits.length]))'), '[[2,1,6]]');
  assert.equal(run('JSON.stringify(gs[1].drums.map(p=>[p.span,p.repeat,p.hits.length]))'), '[[1,1,2]]');   // drumSpan なし＝自動
});

test('quantize picks a grid per beat from the bar denominator and detects triplets', () => {
  const run = load(['DrumDomain']);
  run(`var rs=[{num:2,den:4},{num:2,den:8}];
    var q = DrumDomain.quantize(rs, [
      {p:0,inst:'kick'},{p:0.25,inst:'hh_close'},{p:0.5,inst:'hh_close'},        // 16分
      {p:1,inst:'snare'},{p:1.34,inst:'snare'},{p:1.66,inst:'snare'},            // 3連
      {p:2.5,inst:'hh_close'},                                                   // 8分の拍の裏＝16分
      {p:3.96,inst:'kick'}]);                                                    // パート末ぎりぎり → 頭へ`);
  assert.equal(run('JSON.stringify(q.beats.map(b=>b.base))'), '[4,4,2,2]');
  assert.equal(run('JSON.stringify(q.beats.map(b=>b.sub))'), '[4,3,2,2]');
  assert.equal(run('q.beats[0].slots[0].get("kick").n'), 2);
  assert.equal(run('JSON.stringify(DrumDomain.playSlots(q)[1])'), '[{"f":0,"inst":"snare"},{"f":0.3333333333333333,"inst":"snare"},{"f":0.6666666666666666,"inst":"snare"}]');
});

test('meter edits keep drum hits attached to their bar and beat in every part', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'PatternService']);
  run(`const Transport={running:()=>false};
    const group=Domain.makeGroup({rhythms:[{num:4,den:4},{num:3,den:4}], drums:[
      {span:1, hits:{kick:[0, 4], snare:[3.5], hh_close:[6.5]}},
      {span:2, hits:{kick:[7, 11]}}]});
    Store.apply({groups:[group]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    const hits = i => JSON.stringify(Store.findGroup(group.id).drums[i].hits.map(h=>h.inst+'@'+h.p));`);
  run('PatternService.moveRhythm(group.id, 0, 1);');           // [3/4, 4/4]：小節ごと入れ替わる
  assert.equal(run('hits(0)'), '["kick@0","hh_close@2.5","kick@3","snare@6.5"]');
  assert.equal(run('hits(1)'), '["kick@7","kick@10"]');        // 2回目の 3/4 の頭／2回目の 4/4 の頭
  run('PatternService.setMeter(group.id, 1, 3, 4);');           // 4/4 → 3/4：4拍目の打点は消える
  assert.equal(run('hits(0)'), '["kick@0","hh_close@2.5","kick@3"]');
  run('PatternService.removeRhythm(group.id, 0);');             // 先頭の小節ごと消える
  assert.equal(run('hits(0)'), '["kick@0"]');
  assert.equal(run('hits(1)'), '["kick@3"]');
  run('HistoryService.undo(); HistoryService.undo(); HistoryService.undo();');
  assert.equal(run('hits(0)'), '["kick@0","snare@3.5","kick@4","hh_close@6.5"]');
});

test('parts play in order across the group repeats and taps map back to the right part', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'SpeedService', 'PlaybackService', 'PlaybackScheduler', 'DrumService', 'DrumPlayback']);
  run(`const clicks=[], drums=[];
    const SoundGateway={click:(level,time)=>clicks.push(time), drum:(inst,time)=>drums.push(inst+'@'+Math.round(time*1e6)/1e6)};
    const VideoGateway={armed:()=>false};
    const Transport={running:()=>true, isSolo:()=>false};
    // 2/4 ×5（1回＝2拍＝1秒）。A＝2回ぶん（4拍）を ×2、B＝1回ぶん（2拍）→ ちょうど5回
    const group=Domain.makeGroup({reps:5, rhythms:[{num:2,den:4,tuplet:3}], drums:[
      {span:2, repeat:2, hits:{kick:[0], snare:[3.5]}},
      {span:1, hits:{crash:[0], snare:[1, 1.5]}}]});
    Store.apply({groups:[group], bpm:120});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    PlaybackScheduler.setBeatHook(DrumPlayback.hook);
    PlaybackService.update('all', null); PlaybackScheduler.prime(0); PlaybackScheduler.pump(10);`);
  assert.equal(run('clicks.length'), 30);
  assert.equal(run('JSON.stringify(drums)'), JSON.stringify(['kick@0','snare@1.75','kick@2','snare@3.75','crash@4','snare@4.5','snare@4.75']));
  // 叩いた時刻 → {パート, 拍位置}。2回目の A の2小節目の頭（t=3）と、B の頭の少し手前（t=3.95＝B の頭として）
  run('var l = DrumPlayback.locate(3.25);');
  assert.equal(run('JSON.stringify([l.gid === group.id, l.pi, Math.round(l.p*1000)/1000])'), '[true,0,2.5]');
  assert.equal(run('JSON.stringify([DrumPlayback.locate(3.95).pi, Math.round(DrumPlayback.locate(3.95).p*100)/100])'), '[1,1.9]');
  assert.equal(run('DrumPlayback.locate(4.25).pi'), 1);
  assert.equal(run('DrumPlayback.locate(50)'), null);
  // 追記は1手の履歴にまとめられる（commit:false の2打目以降は積まない）
  run(`DrumService.add(group.id, 1, 0.5, 'hh_close'); DrumService.add(group.id, 1, 1, 'hh_close', {commit:false});`);
  assert.equal(run('Store.findGroup(group.id).drums[1].hits.length'), 5);
  run('HistoryService.undo();');
  assert.equal(run('Store.findGroup(group.id).drums[1].hits.length'), 3);
});

test('parts are created on first edit and can be resized, repeated, duplicated and removed', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'PatternService', 'DrumService']);
  run(`const Transport={running:()=>false};
    const g44=Domain.makeGroup({reps:5, rhythms:[{num:4,den:4}]});
    Store.apply({groups:[g44]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    const parts = () => JSON.stringify(Store.findGroup(g44.id).drums.map(p=>[p.span,p.repeat,p.hits.map(h=>h.inst+'@'+h.p).join(' ')]));`);
  // 未作成のグループは既定のパート（4/4 なら2小節）に見え、最初の編集で実体化する
  assert.equal(run('g44.drums.length'), 0);
  assert.equal(run('JSON.stringify(DrumDomain.partsOf(g44).map(p=>p.span))'), '[2]');
  run(`DrumService.add(g44.id, 0, 0, 'kick'); DrumService.add(g44.id, 0, 6, 'snare');`);
  assert.equal(run('parts()'), '[[2,1,"kick@0 snare@6"]]');
  // 2小節 ×2 → 複製して 1小節 に縮めればフィルの叩き台（計 5 小節）
  run(`DrumService.setRepeat(g44.id, 0, 2); var b = DrumService.duplicatePart(g44.id, 0); DrumService.setSpan(g44.id, b, 1);`);
  assert.equal(run('parts()'), '[[2,2,"kick@0 snare@6"],[1,1,"kick@0"]]');
  assert.equal(run('DrumDomain.totalPasses(Store.findGroup(g44.id).drums)'), 5);
  // 伸ばすと今のパターンを敷き詰める
  run(`DrumService.setSpan(g44.id, 1, 2);`);
  assert.equal(run('parts()'), '[[2,2,"kick@0 snare@6"],[2,1,"kick@0 kick@4"]]');
  run('HistoryService.undo();');
  // 追加・削除（最後の1つは消せない）
  run(`var c = DrumService.addPart(g44.id);`);
  assert.equal(run('c'), 2);
  run(`DrumService.removePart(g44.id, 2); DrumService.removePart(g44.id, 1); DrumService.removePart(g44.id, 0);`);
  assert.equal(run('parts()'), '[[2,2,"kick@0 snare@6"]]');
});

test('drum audio is cancelled and retimed together with clicks', () => {
  const run = load(['SoundGateway']);
  run(`const disconnected=[];
    const window={AudioContext:class {
      currentTime=0.25; sampleRate=100;
      createOscillator(){ return {frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}}, connect(){return {connect(){}};}, start(){}, stop(){}, disconnect(){}}; }
      createGain(){ const g={gain:{value:1,setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){disconnected.push(g);}}; return g; }
      createBuffer(){ return {getChannelData:()=>new Float32Array(200)}; }
      createBufferSource(){ return {connect(){}, start(){}, stop(){}}; }
      createBiquadFilter(){ return {frequency:{}, Q:{}, connect(){}}; }
      get destination(){ return {}; }
    }};
    SoundGateway.ensure(); SoundGateway.drum('kick', 0.5); SoundGateway.drum('snare', 0.1);
    SoundGateway.cancelPending();`);
  assert.equal(run('disconnected.length'), 1);   // 未来の kick だけ取り消す（過ぎた snare はそのまま）
});

test('snapping near the end of a beat moves to the next beat head instead of the last slot', () => {
  const run = load(['DrumDomain']);
  run(`var q = DrumDomain.quantize([{num:2,den:4}], []);`);
  assert.equal(run('JSON.stringify(DrumDomain.snap(q, 0.9))'), JSON.stringify({b:1, k:0, sub:4, p:1}));
  assert.equal(run('DrumDomain.snap(q, 0.88).p'), 1);       // 0.88 × 4 = 3.52 → 4 番目＝次の拍の頭（以前は 0.75 に留まった）
  assert.equal(run('DrumDomain.snap(q, 0.8).p'), 0.75);
  assert.equal(run('DrumDomain.snap(q, 1.9).p'), 2);        // パート末
  assert.equal(run('DrumDomain.snap(q, -0.2).p'), 0);
});

test('score occurrences write repeated patterns as simile and restart notes after another part', () => {
  const run = load(['DrumDomain']);
  const occ = spec => run(`JSON.stringify(DrumDomain.occurrences(${spec}).map(o => o.mode === 'rest' ? '-' + o.passes : (o.mode === 'simile' ? '%' : '') + String.fromCharCode(65 + o.pi) + o.passes + (o.mode === 'simile' ? '<' + o.src : '')))`);
  const g = (reps, parts) => `{reps:${reps}, pattern:{rhythms:[{num:4,den:4}]}, drums:${JSON.stringify(parts)}}`;
  // 4/4 ×8、既定（パートなし）＝2小節パターン：音符 → 2小節シミレ ×3
  assert.equal(occ(g(8, [])), '["A2","%A2<0","%A2<0","%A2<0"]');
  // A 2小節 ×2 → B 1小節（計5）を ×10 に：パートが2つ以上なら頭から回さず、残り5小節は空き
  assert.equal(occ(g(10, [{span:2, repeat:2, hits:[]}, {span:1, repeat:1, hits:[]}])), '["A2","%A2<0","B1","-5"]');
  // 空きの小節はどのパートでもない（鳴らさない・編集対象にしない）
  const loc = rep => run(`JSON.stringify(DrumDomain.locatePass(${g(10, [{span:2, repeat:2, hits:[]}, {span:1, repeat:1, hits:[]}])}, ${rep}, 0).pi)`);
  assert.deepEqual([0, 3, 4, 5, 9].map(loc), ['0', '0', '1', '-1', '-1']);
  // 割り切れない最後は音符（パターンの頭ぶんだけ）
  assert.equal(occ(g(5, [{span:2, repeat:1, hits:[]}])), '["A2","%A2<0","A1"]');
  // 1小節パート ×3 → 1小節シミレを小節ぶん
  assert.equal(occ(g(3, [{span:1, repeat:3, hits:[]}])), '["A1","%A1<0","%A1<0"]');
});

/* ---------- ドラムのスウィング ---------- */

test('swing delays the back half of each pair and leaves tuplet beats and broken pairs straight', () => {
  const run = load(['DrumDomain']);
  const r = v => Math.round(v * 1000) / 1000;
  // 正規化：8 / 16 は既定 67%、割合は 50〜75 にクランプ、50（ストレート）や不正な値は null
  assert.equal(run('JSON.stringify(DrumDomain.normSwing(8))'), '{"unit":8,"amount":67}');
  assert.equal(run('JSON.stringify(DrumDomain.normSwing({unit:16, amount:90}))'), '{"unit":16,"amount":75}');
  assert.equal(run('JSON.stringify([DrumDomain.normSwing({unit:8, amount:50}), DrumDomain.normSwing(12), DrumDomain.normSwing(null)])'), '[null,null,null]');
  run(`var rs44=[{num:4,den:4}], s8={unit:8,amount:67}, s16={unit:16,amount:60};`);
  // 4/4 の8分スウィング：裏の8分が 0.67 へ。拍の頭は動かない。16分は組の中で比例して動く
  assert.deepEqual([0, 0.5, 1, 1.5, 0.25].map(p => r(run(`DrumDomain.swingPos(rs44, ${p}, s8)`))), [0, 0.67, 1, 1.67, 0.335]);
  // 16分スウィング：組は半拍。8分の裏はそのまま、16分の裏だけ遅れる
  assert.deepEqual([0.25, 0.5, 0.75].map(p => r(run(`DrumDomain.swingPos(rs44, ${p}, s16)`))), [0.3, 0.5, 0.8]);
  // 逆変換で元に戻る（重ね録り）
  assert.equal(r(run('DrumDomain.swingPos(rs44, DrumDomain.swingPos(rs44, 2.5, s8), s8, true)')), 2.5);
  // 7/8 の8分スウィング：2拍で1組。7拍目は組が欠けるのでストレート
  run('var rs78=[{num:7,den:8}];');
  assert.deepEqual([1, 5, 6, 6.5].map(p => r(run(`DrumDomain.swingPos(rs78, ${p}, s8)`))), [1.34, 5.34, 6, 6.5]);
  // 3連と判定した拍はハネさせない
  run(`var q = DrumDomain.quantize(rs44, [{p:0,inst:'hh_close'},{p:0.5,inst:'hh_close'},
      {p:1,inst:'snare'},{p:1.333,inst:'snare'},{p:1.667,inst:'snare'}]);
    var ps = DrumDomain.playSlots(q, rs44, s8);`);
  assert.deepEqual(run('JSON.stringify(ps[0].map(h=>Math.round(h.f*1000)/1000))'), '[0,0.67]');
  assert.deepEqual(run('JSON.stringify(ps[1].map(h=>Math.round(h.f*1000)/1000))'), '[0,0.333,0.667]');
});

test('swing round-trips through YAML and is omitted for straight groups', () => {
  const run = load(['Domain', 'Yaml', 'SequenceMapper']);
  run(`var g = Domain.makeGroup({rhythms:[{num:4,den:4}], swing:{unit:16, amount:58}});
    var text = Yaml.stringify(SequenceMapper.toDto(Domain.makeSequence({groups:[g, Domain.makeGroup({})]})));
    var back = SequenceMapper.toEntity(Yaml.parse(text)).sequence.groups;`);
  assert.ok(run('text').includes('    swing:\n      unit: 16\n      amount: 58\n'));
  assert.equal(run('text.split("swing:").length'), 2);
  assert.equal(run('JSON.stringify(back.map(x=>x.swing))'), '[{"unit":16,"amount":58},null]');
  // 短い書き方（swing: 8）は 8分 67%。複製にも引き継ぐ
  assert.equal(run(`JSON.stringify(SequenceMapper.toEntity(Yaml.parse('groups:\\n  - pattern: [4/4]\\n    swing: 8\\n')).sequence.groups[0].swing)`), '{"unit":8,"amount":67}');
  assert.equal(run('JSON.stringify(Domain.cloneGroup(g).swing)'), '{"unit":16,"amount":58}');
});

test('swung playback delays the off-beats and taps are stored back on the straight grid', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'SpeedService', 'PlaybackService', 'PlaybackScheduler', 'DrumService', 'DrumPlayback']);
  run(`const drums=[];
    const SoundGateway={click:()=>{}, drum:(inst,time)=>drums.push(inst+'@'+Math.round(time*1e6)/1e6)};
    const VideoGateway={armed:()=>false};
    const Transport={running:()=>true, isSolo:()=>false};
    // 4/4 ×1、♩=120（1拍＝0.5秒）
    const group=Domain.makeGroup({reps:1, rhythms:[{num:4,den:4}], drums:[{span:1, hits:{hh_close:[0, 0.5, 1, 1.5]}}]});
    Store.apply({groups:[group], bpm:120});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    PlaybackScheduler.setBeatHook(DrumPlayback.hook);
    DrumService.setSwing(group.id, {unit:8, amount:67});
    PlaybackService.update('all', null); PlaybackScheduler.prime(0); PlaybackScheduler.pump(10);`);
  assert.equal(run('JSON.stringify(drums)'), JSON.stringify(['hh_close@0', 'hh_close@0.335', 'hh_close@0.5', 'hh_close@0.835']));
  // ハネた裏（0.835 秒）を叩くと、ストレートの 1.5 拍目として記録する
  assert.equal(run('Math.round(DrumPlayback.locate(0.835).p*1000)/1000'), 1.5);
  // スウィングの変更は1手の履歴。パートは増やさない
  run('HistoryService.undo();');
  assert.equal(run('Store.findGroup(group.id).swing'), null);
});

/* ---------- ドラムの連符 ---------- */

test('a meter tuplet becomes the drum base grid and straight 16ths are still detected', () => {
  const run = load(['DrumDomain']);
  run(`var rs=[{num:4,den:4,tuplet:3}];
    var q = DrumDomain.quantize(rs, [
      {p:0,inst:'hh_close'},{p:0.333,inst:'hh_close'},{p:0.667,inst:'hh_close'},   // 3連（基本）
      {p:1.667,inst:'snare'},                                                      // 3連の3つ目だけ
      {p:2,inst:'kick'},{p:2.25,inst:'kick'},{p:2.5,inst:'kick'},{p:2.75,inst:'kick'}]);   // 16分`);
  assert.equal(run('JSON.stringify(q.beats.map(b=>b.base))'), '[3,3,3,3]');
  assert.equal(run('JSON.stringify(q.beats.map(b=>b.sub))'), '[3,3,4,3]');
  assert.equal(run('DrumDomain.baseAt([{num:7,den:8}], 3)'), 2);
});

test('tuplet ranges fix the grid of their beats, including tuplets across several beats', () => {
  const run = load(['DrumDomain']);
  const r = v => Math.round(v * 1000) / 1000;
  run(`var rs=[{num:4,den:4}];
    var hits=[{p:0,inst:'snare'},{p:0.8,inst:'snare'},{p:1.6,inst:'snare'},{p:2.4,inst:'snare'},{p:3.2,inst:'snare'}];`);
  // 区間なし：拍に1発ずつでは5連と判定できず16分に吸われる
  assert.equal(run('JSON.stringify(DrumDomain.quantize(rs, hits).beats.map(b=>b.sub))'), '[4,4,4,4]');
  // 4拍5連の区間：各拍5分割に固定され、書いた位置で鳴る
  run('var q = DrumDomain.quantize(rs, hits, [[0, 4, 5]]), ps = DrumDomain.playSlots(q);');
  assert.equal(run('JSON.stringify(q.beats.map(b=>[b.sub, b.tup]))'), '[[5,0],[5,0],[5,0],[5,0]]');
  assert.deepEqual(run('JSON.stringify(ps.map((x, b)=>x.map(h=>Math.round((b+h.f)*1000)/1000)))'), '[[0,0.8],[1.6],[2.4],[3.2]]');
  // 2拍3連は各拍3分割。区間の外は推定のまま
  run('var q2 = DrumDomain.quantize(rs, [{p:0,inst:"kick"},{p:0.667,inst:"kick"},{p:1.333,inst:"kick"}], [{at:0, beats:2, n:3}]);');
  assert.equal(run('JSON.stringify(q2.beats.map(b=>b.sub))'), '[3,3,4,4]');
  // 区間の正規化：重なり・パートの外・範囲外の分割数は落とす
  assert.equal(run('JSON.stringify(DrumDomain.normTuplets([[0,2,3],[1,1,5],[3,2,3],[2,1,12],[2,1,5]], 4))'), '[{"at":0,"beats":2,"n":3},{"at":2,"beats":1,"n":5}]');
  // 連符の拍にはスウィングをかけない
  run('var sw = DrumDomain.playSlots(DrumDomain.quantize(rs, [{p:0.5,inst:"hh_close"},{p:1.333,inst:"hh_close"}], [[1,1,3]]), rs, {unit:8, amount:67});');
  assert.deepEqual([r(run('sw[0][0].f')), r(run('sw[1][0].f'))], [0.67, 0.333]);
});

test('tuplet ranges round-trip through YAML and follow part length and meter edits', () => {
  const run = load(['Domain', 'Yaml', 'SequenceMapper', 'Store', 'HistoryService', 'PatternService']);
  run(`var g = Domain.makeGroup({rhythms:[{num:4,den:4},{num:3,den:4}], drums:[{span:1, hits:{snare:[0.8]}, tuplets:[[0,4,5],[5,2,3]]}]});
    var text = Yaml.stringify(SequenceMapper.toDto(Domain.makeSequence({groups:[g]})));
    var back = SequenceMapper.toEntity(Yaml.parse(text)).sequence.groups[0];`);
  assert.ok(run('text').includes('      - span: 1\n        tuplets: [[0, 4, 5], [5, 2, 3]]\n        hits:\n'));
  assert.equal(run('JSON.stringify(back.drums[0].tuplets)'), '[{"at":0,"beats":4,"n":5},{"at":5,"beats":2,"n":3}]');
  assert.equal(run('JSON.stringify(Domain.cloneGroup(g).drums[0].tuplets.length)'), '2');
  // 区間の無いパートは tuplets を書かない
  assert.equal(run(`Yaml.stringify(SequenceMapper.toDto(Domain.makeSequence({groups:[Domain.makeGroup({drums:[{span:1, hits:{kick:[0]}}]})]}))).includes('tuplets')`), false);
  // 拍子の入れ替え：区間も小節ごと移る。3/4 → 2/4 で 2拍3連（5・6拍目＝3/4 の2・3拍目）ははみ出して消える
  run(`const Transport={running:()=>false};
    Store.apply({groups:[g]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    const tups = () => JSON.stringify(Store.findGroup(g.id).drums[0].tuplets.map(t=>[t.at,t.beats,t.n]));`);
  run('PatternService.moveRhythm(g.id, 0, 1);');
  assert.equal(run('tups()'), '[[1,2,3],[3,4,5]]');
  run('PatternService.setMeter(g.id, 0, 2, 4);');
  assert.equal(run('tups()'), '[[2,4,5]]');
  run('HistoryService.undo(); HistoryService.undo();');
  assert.equal(run('tups()'), '[[0,4,5],[5,2,3]]');
  // パートを伸ばすと区間も敷き詰める
  assert.equal(run('JSON.stringify(DrumDomain.respanTuplets([{at:0,beats:4,n:5},{at:5,beats:2,n:3}], 7, 1, 2).map(t=>t.at))'), '[0,5,7,12]');
});

test('step input with tuplet steps creates, keeps and removes tuplet ranges in one undo step', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'PatternService', 'DrumService']);
  run(`const g=Domain.makeGroup({rhythms:[{num:4,den:4}], drums:[{span:1}]});
    Store.apply({groups:[g]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    const tups = () => JSON.stringify(DrumService.tuplets(g.id, 0).map(t=>[t.at,t.beats,t.n]));`);
  run(`DrumService.add(g.id, 0, 0, 'snare', {tuplet:{at:0, beats:2, n:3}});`);
  assert.equal(run('tups()'), '[[0,2,3]]');
  assert.equal(run('JSON.stringify(DrumService.grid(g.id, 0).beats.map(b=>b.sub))'), '[3,3,4,4]');
  // 重なる区間を置くと古い区間は外れる。Undo は打点と区間をまとめて戻す
  run(`DrumService.add(g.id, 0, 1, 'kick', {tuplet:{at:1, beats:1, n:5}});`);
  assert.equal(run('tups()'), '[[1,1,5]]');
  run('HistoryService.undo();');
  assert.equal(run('tups()'), '[[0,2,3]]');
  assert.equal(run('DrumService.hits(g.id, 0).length'), 1);
  // 範囲のコピーは丸ごと入る区間も運ぶ
  run('var clip = DrumService.copy(g.id, 0, 0, 2); DrumService.paste(g.id, 0, 2, clip);');
  assert.equal(run('tups()'), '[[0,2,3],[2,2,3]]');
  run('DrumService.removeTuplet(g.id, 0, 3);');
  assert.equal(run('tups()'), '[[0,2,3]]');
  run('DrumService.clear(g.id, 0);');
  assert.equal(run('tups()'), '[]');
});
