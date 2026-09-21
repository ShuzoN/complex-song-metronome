const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');

function load() {
  const context = vm.createContext({});
  for (const name of ['Domain', 'Yaml', 'SequenceMapper', 'PatternService', 'SoundGateway']) {
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
