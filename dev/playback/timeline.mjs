// Stage 1: cue-driven Timeline builder (pure). D2 core.
// 各拍に songPos(基準テンポ累積) / vt(動画位置・cue駆動) / anchor(rep頭の生cue) を持たせる。

// rhythmSeconds: 分母を音価として ♩=bpm から1拍の秒。/8=倍速, /16=4倍速… (index.html Domain と同義)
export function rhythmSeconds(den, bpm){ return (60 / bpm) * (4 / den); }
const effBpm = (g, base) => (g.bpm != null ? g.bpm : base);

// groups: [{ rhythms:[{num,den}], reps, bpm|null, cue|null, repCues:[..]|null, id }]
export function buildTimeline(groups, baseBpm){
  // 1) 生ビート列＋基準テンポの拍長 dur / songPos / rep頭cue(anchor)
  const beats = [];
  let songPos = 0;
  for(const g of groups){
    const rc = Array.isArray(g.repCues) ? g.repCues : null;
    const ebpm = effBpm(g, baseBpm);
    for(let rep = 0; rep < g.reps; rep++){
      const rawCue = (rc && rc[rep] != null) ? rc[rep] : (rep === 0 && g.cue != null ? g.cue : null);
      const rhythms = g.rhythms;
      for(let bar = 0; bar < rhythms.length; bar++){
        const m = rhythms[bar];
        const dur = rhythmSeconds(m.den, ebpm);
        for(let beat = 0; beat < m.num; beat++){
          const isHead = (bar === 0 && beat === 0);
          beats.push({ gid:g.id, rep, bar, beat, meter:m, accent:(beat===0),
                       dur, songPos, anchor: isHead ? rawCue : null, vt: 0 });
          songPos += dur;
        }
      }
    }
  }
  // 2) アンカー(rep頭で生cueを持つ拍)を集め、単調な「実効cue」に整える。
  //    逆順・非増加の記録cueは基準テンポ外挿へフォールバック（vt が後退しないことを保証）。
  const raw = [];
  for(let i = 0; i < beats.length; i++) if(beats[i].anchor != null) raw.push({ idx:i, cue:beats[i].anchor });

  if(raw.length === 0){
    for(const b of beats) b.vt = b.songPos;         // cue 皆無：純粋 BPM（動画0起点の best effort）
    return finalize(beats);
  }
  const anchors = [];                                // 実効cueに正規化した {idx, cue}
  {
    let prevIdx = raw[0].idx, prevEff = raw[0].cue;
    beats[prevIdx].anchor = prevEff;
    anchors.push({ idx: prevIdx, cue: prevEff });
    for(let k = 1; k < raw.length; k++){
      const { idx, cue } = raw[k];
      const bpmDur = beats[idx].songPos - beats[prevIdx].songPos;   // 前アンカーからの基準テンポ経過
      const eff = (cue > prevEff) ? cue : (prevEff + bpmDur);       // 前進しない記録cueは基準テンポで前へ
      beats[idx].anchor = eff;
      anchors.push({ idx, cue: eff });
      prevIdx = idx; prevEff = eff;
    }
  }

  // 3) vt を敷く
  // 3a) 先頭アンカーより前：先頭cueから基準テンポで逆算（通常は先頭拍=アンカーなので空）
  {
    const a0 = anchors[0];
    for(let i = 0; i < a0.idx; i++) beats[i].vt = a0.cue - (beats[a0.idx].songPos - beats[i].songPos);
  }
  // 3b) アンカー間：区間 [Ca,Cb] の実時間を、拍の音価(dur)比で配分（＝cue駆動テンポ）
  for(let k = 0; k < anchors.length - 1; k++){
    const a = anchors[k], b = anchors[k+1];
    const span = b.cue - a.cue;
    const totalDur = beats[b.idx].songPos - beats[a.idx].songPos;   // 区間の基準テンポ総拍長
    const forward = span > 0 && totalDur > 0;
    let acc = 0;
    for(let i = a.idx; i < b.idx; i++){
      beats[i].vt = forward ? (a.cue + span * (acc / totalDur)) : (a.cue + (beats[i].songPos - beats[a.idx].songPos));
      acc += beats[i].dur;
    }
  }
  // 3c) 末尾アンカー以降：次cueが無いので基準テンポで外挿（フォールバック）
  {
    const aN = anchors[anchors.length - 1];
    for(let i = aN.idx; i < beats.length; i++) beats[i].vt = aN.cue + (beats[i].songPos - beats[aN.idx].songPos);
  }
  return finalize(beats);
}

function finalize(beats){
  // segment 選択用の index はそのまま配列添字。dur は保持(テンポ源)。read-only 化は省略。
  const dur = beats.length ? beats[beats.length-1].songPos + beats[beats.length-1].dur : 0;
  return { beats, dur };
}

// segment: 区間 [start,end) の抽出（グループ再生=そのグループ範囲 / 全体=全体）
export function segmentOf(timeline, predicate){
  const idx = timeline.beats.map((b,i)=>({b,i})).filter(x=>predicate(x.b)).map(x=>x.i);
  return idx.length ? { start: idx[0], end: idx[idx.length-1] + 1 } : { start:0, end:0 };
}
