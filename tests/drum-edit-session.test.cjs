/* DrumEditSession が「編集セッションの複数のサブサービスにまたがる書き換え」の唯一の入口であることを、
   ソースの文字列だけで確かめる（実行はしない）。DrumView がこれらの書き込みメソッドを直接呼んでいたら、
   協調ロジックがまた画面側に染み出してきた合図なので、ここで気づけるようにする。
   カーソル単体（DrumCursor）は他のサブサービスと連動しない操作なら画面から直接呼んでよいので対象外。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');

function extractModule(name, endMarker) {
  const start = html.indexOf(`  const ${name} = (() => {`);
  assert.ok(start >= 0, `${name} exists`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end >= 0, `${name} の終わりが見つからない`);
  return html.slice(start, end);
}

const drumView = extractModule('DrumView', '\n  /* ========================================================================\n     bootstrap');
const drumEditSession = extractModule('DrumEditSession', '\n  /* ---------- SequenceMapper');

test('DrumView は DrumTarget / DrumSelection / DrumRange / DrumClipboard を直接書き換えない', () => {
  const forbidden = [
    /DrumTarget\.set\(/,
    /DrumSelection\.(set|clear|toggle)\(/,
    /DrumRange\.(open|span|setIn|setOut|clear|normalize)\(/,
    /DrumClipboard\.set\(/
  ];
  for (const re of forbidden) {
    const hits = drumView.match(new RegExp(re.source, 'g')) || [];
    assert.equal(hits.length, 0, `DrumView が ${re} を直接呼んでいる（DrumEditSession を通すこと）`);
  }
});

test('DrumEditSession は具体の計算（DrumDomain・DOM）を持たない中継役のまま', () => {
  for (const banned of ['DrumDomain.', 'document.', 'render(']) {
    assert.ok(!drumEditSession.includes(banned), `DrumEditSession に ${banned} が入り込んでいる`);
  }
});

test('DrumEditSession が公開する操作の一覧', () => {
  const expected = [
    'selectTarget', 'selectOccurrence', 'followPlayhead', 'guardRangeTap', 'toggleHit',
    'setSelection', 'clearSelection', 'seekTo',
    'beginRangeDrag', 'dragRangeTo', 'spanRange', 'normalizeRange', 'openRangeAt', 'setRangeOut', 'closeRange',
    'commitCopy', 'clearEdit', 'retreatPart'
  ];
  for (const name of expected) {
    assert.ok(new RegExp(`function ${name}\\(`).test(drumEditSession), `DrumEditSession.${name} が見つからない`);
  }
});
