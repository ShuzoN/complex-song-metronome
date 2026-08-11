import { buildTimeline, segmentOf, rhythmSeconds } from './timeline.mjs';
let pass=0, fail=0;
const approx=(a,b,e=1e-6)=>Math.abs(a-b)<e;
function ok(name, cond, extra=''){ if(cond){pass++; /*console.log('  ok',name)*/} else {fail++; console.log('  FAIL',name,extra);} }

// ---- Case 1: cue駆動テンポ。1グループ 4/4 ×2rep、cue=[1.0, 3.6]（実gap2.6s、BPM予測は2.0s）----
// bpm=120 → ♩=0.5s。1rep=4拍=2.0s。cue駆動なら rep0 の4拍は [1.0,3.6] を音価比(均等)で埋める＝0.65s/拍。
{
  const g=[{id:'g',rhythms:[{num:4,den:4}],reps:2,bpm:120,cue:1.0,repCues:[1.0,3.6]}];
  const {beats}=buildTimeline(g,120);
  // rep0 downbeat vt=1.0
  ok('C1 rep0 head vt', approx(beats[0].vt,1.0), beats[0].vt);
  // rep0 の拍間隔 = 2.6/4 = 0.65
  ok('C1 cue-driven spacing', approx(beats[1].vt-beats[0].vt,0.65), beats[1].vt-beats[0].vt);
  // rep1 downbeat(index4) vt=3.6
  ok('C1 rep1 head vt', approx(beats[4].vt,3.6), beats[4].vt);
  // 末尾アンカー以降は基準テンポ外挿：index5 vt=3.6+0.5=4.1
  ok('C1 tail extrapolate', approx(beats[5].vt,4.1), beats[5].vt);
}

// ---- Case 2: 音価比配分。混在拍子 [3/4(♩3拍), 1/8(倍速1拍)] 1rep、cue=[0.0, next 2.0] ----
// bpm=120: 3/4の各拍0.5s(×3=1.5s), 1/8の1拍0.25s。基準総=1.75s。実gap=2.0s → 係数=2.0/1.75。
{
  const g=[{id:'g',rhythms:[{num:3,den:4},{num:1,den:8}],reps:2,bpm:120,cue:0.0,repCues:[0.0,2.0]}];
  const {beats}=buildTimeline(g,120);
  const f=2.0/1.75;
  // 拍: [0]4分,[1]4分,[2]4分,[3]8分 → vt増分は dur*f
  ok('C2 beat1', approx(beats[1].vt, 0 + 0.5*f), beats[1].vt);
  ok('C2 beat3(8th)', approx(beats[3].vt, (0.5*3)*f), beats[3].vt);   // 3拍ぶん進んだ位置
  // rep1 head(index4) = 2.0
  ok('C2 rep1 head', approx(beats[4].vt,2.0), beats[4].vt);
  // 区間は音価比で満ちる：最後の8分の直後(=rep1頭)がちょうど2.0
}

// ---- Case 3: cue皆無 → vt=songPos（純粋BPM） ----
{
  const g=[{id:'g',rhythms:[{num:4,den:4}],reps:2,bpm:120,cue:null,repCues:null}];
  const {beats}=buildTimeline(g,120);
  ok('C3 no-cue vt=songPos', approx(beats[3].vt, beats[3].songPos) && approx(beats[0].vt,0), beats[3].vt);
}

// ---- Case 4: 逆順cueガード → 基準テンポにフォールバック（単調・後退しない） ----
{
  const g=[{id:'g',rhythms:[{num:4,den:4}],reps:2,bpm:120,cue:2.0,repCues:[2.0,1.0]}];
  const {beats}=buildTimeline(g,120);
  // rep0..rep1間は forward=false → 基準テンポ。vt は Ca=2.0 から前進、後退しない
  let mono=true; for(let i=1;i<beats.length;i++) if(beats[i].vt < beats[i-1].vt-1e-9) mono=false;
  ok('C4 backward-cue monotonic', mono);
  ok('C4 rep0 head still Ca', approx(beats[0].vt,2.0), beats[0].vt);
}

// ---- Case 5: 2グループ跨ぎ。G0(cue0.0), G1(cue5.0)。境界間もcue駆動で満ちる ----
{
  const g=[{id:'a',rhythms:[{num:4,den:4}],reps:1,bpm:120,cue:0.0,repCues:[0.0]},
           {id:'b',rhythms:[{num:4,den:4}],reps:1,bpm:120,cue:5.0,repCues:[5.0]}];
  const {beats}=buildTimeline(g,120);
  // G0 4拍で [0.0,5.0] を満たす → 1.25s/拍
  ok('C5 cross-group spacing', approx(beats[1].vt-beats[0].vt,1.25), beats[1].vt-beats[0].vt);
  ok('C5 G1 head', approx(beats[4].vt,5.0), beats[4].vt);
  // segment: G1 だけ [start,end)
  const seg=segmentOf({beats}, b=>b.gid==='b');
  ok('C5 segment G1', seg.start===4 && seg.end===8, JSON.stringify(seg));
}

console.log(`\nTimeline tests: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
