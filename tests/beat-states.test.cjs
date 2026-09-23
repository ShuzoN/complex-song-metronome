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

test('drum hits round-trip through YAML as per-instrument beat positions', () => {
  const run = load(['Domain', 'Yaml', 'SequenceMapper']);
  run(`const g = Domain.makeGroup({reps:4, rhythms:[{num:7,den:8},{num:3,den:4}],
      drums:[{p:0,inst:'kick'},{p:3.5,inst:'snare'},{p:7,inst:'kick'},{p:9.333,inst:'hh_close'},{p:10,inst:'kick'},{p:2,inst:'cowbell'}]});
    var text = Yaml.stringify(SequenceMapper.toDto(Domain.makeSequence({groups:[g, Domain.makeGroup({})]})));
    var back = SequenceMapper.toEntity(Yaml.parse(text)).sequence.groups;`);
  // 周は 7 + 3 = 10 拍。p=10 は周の外、cowbell は未知の楽器なので落とす
  assert.match(run('text'), /    drums:\n      hh_close: \[9\.333\]\n      snare: \[3\.5\]\n      kick: \[0, 7\]\n/);
  assert.equal(run('JSON.stringify(back[0].drums)'), '[{"p":0,"inst":"kick"},{"p":3.5,"inst":"snare"},{"p":7,"inst":"kick"},{"p":9.333,"inst":"hh_close"}]');
  // 打点の無いグループは drums キーごと出さない（後方互換）
  assert.equal(run('text.split("drums:").length'), 2);
  assert.equal(run('back[1].drums.length'), 0);
  // drums を知らない古いファイル・下書きもそのまま読める
  assert.equal(run('SequenceMapper.toEntity({groups:[{pattern:["4/4"]}]}).sequence.groups[0].drums.length'), 0);
});

test('quantize picks a grid per beat from the bar denominator and detects triplets', () => {
  const run = load(['DrumDomain']);
  run(`var rs=[{num:2,den:4},{num:2,den:8}];
    var q = DrumDomain.quantize(rs, [
      {p:0,inst:'kick'},{p:0.25,inst:'hh_close'},{p:0.5,inst:'hh_close'},        // 16分
      {p:1,inst:'snare'},{p:1.34,inst:'snare'},{p:1.66,inst:'snare'},            // 3連
      {p:2.5,inst:'hh_close'},                                                   // 8分の拍の裏＝16分
      {p:3.96,inst:'kick'}]);                                                    // 周末ぎりぎり → 周頭へ`);
  assert.equal(run('JSON.stringify(q.beats.map(b=>b.base))'), '[4,4,2,2]');
  assert.equal(run('JSON.stringify(q.beats.map(b=>b.sub))'), '[4,3,2,2]');
  assert.equal(run('q.beats[0].slots[0].get("kick").n'), 2);
  assert.equal(run('JSON.stringify(DrumDomain.playSlots(q)[1])'), '[{"f":0,"inst":"snare"},{"f":0.3333333333333333,"inst":"snare"},{"f":0.6666666666666666,"inst":"snare"}]');
});

test('meter edits keep drum hits attached to their bar and beat', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'PatternService']);
  run(`const Transport={running:()=>false};
    const group=Domain.makeGroup({rhythms:[{num:4,den:4},{num:3,den:4}],
      drums:[{p:0,inst:'kick'},{p:3.5,inst:'snare'},{p:4,inst:'kick'},{p:6.5,inst:'hh_close'}]});
    Store.apply({groups:[group]});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    const hits = () => JSON.stringify(Store.findGroup(group.id).drums.map(h=>h.inst+'@'+h.p));`);
  run('PatternService.moveRhythm(group.id, 0, 1);');           // [3/4, 4/4]：小節ごと入れ替わる
  assert.equal(run('hits()'), '["kick@0","hh_close@2.5","kick@3","snare@6.5"]');
  run('PatternService.setMeter(group.id, 1, 3, 4);');           // 4/4 → 3/4：4拍目の打点は消える
  assert.equal(run('hits()'), '["kick@0","hh_close@2.5","kick@3"]');
  run('PatternService.removeRhythm(group.id, 0);');             // 先頭の小節ごと消える
  assert.equal(run('hits()'), '["kick@0"]');
  run('HistoryService.undo(); HistoryService.undo(); HistoryService.undo();');
  assert.equal(run('hits()'), '["kick@0","snare@3.5","kick@4","hh_close@6.5"]');
});

test('drum hits are scheduled on the metronome clock and taps map back to beat positions', () => {
  const run = load(['Domain', 'Store', 'HistoryService', 'SpeedService', 'PlaybackService', 'PlaybackScheduler', 'DrumService', 'DrumPlayback']);
  run(`const clicks=[], drums=[];
    const SoundGateway={click:(level,time)=>clicks.push(time), drum:(inst,time)=>drums.push(inst+'@'+Math.round(time*1e6)/1e6)};
    const VideoGateway={armed:()=>false};
    const Transport={running:()=>true, isSolo:()=>false};
    const group=Domain.makeGroup({reps:2, rhythms:[{num:2,den:4,tuplet:3}], drums:[{p:0,inst:'kick'},{p:1.5,inst:'snare'}]});
    Store.apply({groups:[group], bpm:120});
    HistoryService.init({capture:()=>Store.snapshot(),apply:s=>Store.restore(s)});
    PlaybackScheduler.setBeatHook(DrumPlayback.hook);
    PlaybackService.update('all', null); PlaybackScheduler.prime(0); PlaybackScheduler.pump(10);`);
  // 120BPM の4分＝0.5秒。連符（3分割）のクリックとは別に、打点は拍の頭から拍長の割合で置かれる
  assert.equal(run('clicks.length'), 12);
  assert.equal(run('JSON.stringify(drums)'), '["kick@0","snare@0.75","kick@1","snare@1.75"]');
  // 叩いた時刻 → 周の拍位置（2周目の 1拍目の 1/4 ＝ p=0.25）。最初の拍の少し手前は周末（→周頭へ回る）
  assert.equal(run('JSON.stringify(DrumPlayback.locate(1.125))'), JSON.stringify({gid: run('group.id'), p: 0.25}));
  assert.equal(run('DrumPlayback.locate(-0.05).p'), 1.9);
  assert.equal(run('DrumPlayback.locate(50)'), null);
  // 追記は1手の履歴にまとめられる（commit:false の2打目以降は積まない）
  run(`DrumService.add(group.id, 0.5, 'hh_close'); DrumService.add(group.id, 1, 'hh_close', {commit:false});`);
  assert.equal(run('Store.findGroup(group.id).drums.length'), 4);
  run('HistoryService.undo();');
  assert.equal(run('Store.findGroup(group.id).drums.length'), 2);
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
