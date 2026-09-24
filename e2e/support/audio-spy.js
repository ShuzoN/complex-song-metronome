/* Web Audio の境目で「何時刻に何を鳴らす予約をしたか」を記録する（テスト専用。addInitScript で読み込む）。
   アプリの内部には触らず、ブラウザ API（AudioNode の connect / start / stop / disconnect）だけを包む。
   - クリック：square のオシレータ → ゲイン → 出力。周波数で強さ（accent / beat / sub）を見分ける
   - ドラム（内蔵の合成音）：1打ごとのゲインにまとまる音源の組を、楽器ごとの目印（下の MARK）で見分ける
   予約の取り消し（停止・speed 変更の打ち直し）は、発音時刻より前の stop() / disconnect() で判定する。 */
(() => {
  const out = new Map();          // node → 接続先
  const f0 = new WeakMap();       // オシレータ → 最初に予約した周波数
  const owner = new WeakMap();    // frequency の AudioParam → オシレータ
  const cut = new WeakMap();      // node → disconnect した時刻
  const halted = new WeakMap();   // 音源 → 発音前に止めた
  const starts = [];              // {src, when}
  let ctx = null;

  const Orig = window.AudioContext;
  class Spied extends Orig { constructor(...a){ super(...a); ctx = this; } }
  window.AudioContext = Spied;
  window.webkitAudioContext = Spied;

  const createOsc = BaseAudioContext.prototype.createOscillator;
  BaseAudioContext.prototype.createOscillator = function(){ const o = createOsc.call(this); owner.set(o.frequency, o); return o; };
  const setAt = AudioParam.prototype.setValueAtTime;
  AudioParam.prototype.setValueAtTime = function(v, t){
    const o = owner.get(this);
    if(o && !f0.has(o)) f0.set(o, v);
    return setAt.call(this, v, t);
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(dest, ...rest){
    if(dest instanceof AudioNode) out.set(this, dest);
    return connect.call(this, dest, ...rest);
  };
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function(...a){
    if(ctx && !cut.has(this)) cut.set(this, ctx.currentTime);
    return disconnect.apply(this, a);
  };
  // AudioBufferSourceNode は start / stop を自分の prototype で上書きしているので、両方を包む
  function wrap(proto){
    const start = proto.start, stop = proto.stop;
    proto.start = function(when, ...rest){
      starts.push({src: this, when: when || (ctx ? ctx.currentTime : 0), freq: this.frequency ? this.frequency.value : null});
      return start.call(this, when, ...rest);
    };
    proto.stop = function(when){
      const rec = starts.find(s => s.src === this);
      const at = when == null ? (ctx ? ctx.currentTime : 0) : when;
      if(rec && at <= rec.when + 1e-9) halted.set(this, true);
      return stop.call(this, when);
    };
  }
  wrap(AudioScheduledSourceNode.prototype);
  if(Object.prototype.hasOwnProperty.call(AudioBufferSourceNode.prototype, "start")) wrap(AudioBufferSourceNode.prototype);

  const CLICK = {1760: "accent", 880: "beat", 587: "sub"};
  // 内蔵の合成音の目印（楽器ごとに1つだけ持つ音源の特徴）
  const MARK = {
    "sine160": "kick", "highpass1800": "snare", "highpass2200": "ghost", "square900": "rim",
    "highpass7000": "hh_close", "highpass6000": "hh_open", "bandpass5000": "crash", "bandpass3200": "effect",
    "highpass8000": "ride", "sine300": "tom_hi", "sine220": "tom_low", "sine140": "floor"
  };
  function chain(src){
    const c = [src]; let n = src;
    while(out.has(n) && c.length < 12){ n = out.get(n); c.push(n); }
    return c;
  }
  function events(){
    const clicks = [], hits = new Map();
    for(const s of starts){
      const c = chain(s.src);
      if(!ctx || c[c.length - 1] !== ctx.destination) continue;
      const cutAt = c.map(n => cut.get(n)).filter(v => v != null);
      const cancelled = halted.has(s.src) || cutAt.some(t => t < s.when - 1e-9);
      if(c.length === 3 && s.src instanceof OscillatorNode && s.src.type === "square" && CLICK[Math.round(s.freq)]){
        clicks.push({kind: "click", level: CLICK[Math.round(s.freq)], time: s.when, cancelled});
        continue;
      }
      const hit = c[c.length - 3];
      let token = null;
      if(s.src instanceof OscillatorNode) token = s.src.type + Math.round(f0.get(s.src) || s.freq);
      else if(c[1] instanceof BiquadFilterNode) token = c[1].type + Math.round(c[1].frequency.value);
      const e = hits.get(hit) || {kind: "drum", inst: null, time: s.when, cancelled: false};
      if(token && MARK[token]) e.inst = MARK[token];
      e.cancelled = e.cancelled || cancelled;
      hits.set(hit, e);
    }
    return clicks.concat([...hits.values()].filter(e => e.inst)).sort((a, b) => a.time - b.time);
  }
  window.__audioSpy = {
    events,
    now: () => ctx ? ctx.currentTime : 0,
    reset(){ starts.length = 0; }
  };
})();
