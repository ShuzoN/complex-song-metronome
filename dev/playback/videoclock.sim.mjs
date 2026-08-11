// Stage 4: VideoClock（平滑動画クロック）＋ follow の検証シミュレーション（#36 C1）。
// index.html の VideoClock と同じ「新しいサンプルのときだけ低ゲイン補正」ロジックを、
// 250ms サンプルホールドの getCurrentTime＋0.3%レート差＋0.8s stall に対して回す。
// 実行：node dev/playback/videoclock.sim.mjs
const CUE_LATENCY = 0.26, compensate = c => Math.max(0, c - CUE_LATENCY);
function makeClock(gain){ let a0=0,v0=0,rate=1,ready=false,lastV=null;
  return { reset(a,v){a0=a;v0=v;rate=1;ready=true;lastV=v;}, positionAt(a){return v0+rate*(a-a0);},
    audioTimeFor(vp){return a0+(vp-v0)/rate;},
    observe(a,v){ if(!ready){this.reset(a,v);return;} if(lastV!=null && Math.abs(v-lastV)<1e-4) return;
      lastV=v; const err=v-this.positionAt(a); v0=this.positionAt(a)+err*gain; a0=a; }, isReady(){return ready;} }; }
const headV=1.0, startVideo=compensate(headV);
const trueVideo = (a,stall)=>{ let v=startVideo+a*1.003; if(stall && a>4.0) v-=0.8; return v; };
function run(gain, stall){
  const gct=a=>{const s=0.25; return trueVideo(s*Math.floor(a/s), stall);};
  const vts=[]; for(let x=headV;x<=60.0+1e-9;x+=0.5) vts.push(+x.toFixed(3));
  const clk=makeClock(gain); clk.reset(0,startVideo);
  let a=0,ni=0; const rows=[]; const AHEAD=0.12,TICK=0.025;
  while(ni<vts.length && a<40){ clk.observe(a,gct(a)); const target=clk.audioTimeFor(compensate(vts[ni]));
    if(target<a+AHEAD){ const at=Math.max(target,a+0.005); rows.push({at,err:trueVideo(at,stall)-compensate(vts[ni])}); ni++; } else a+=TICK; }
  return rows;
}
const stat=rows=>{ const e=rows.map(r=>Math.abs(r.err)); return {mx:Math.max(...e),rms:Math.sqrt(e.reduce((s,x)=>s+x*x,0)/e.length)}; };
const steady=stat(run(0.2,false));
const open=(()=>{ const vts=[]; for(let x=headV;x<=60;x+=0.5) vts.push(x); return stat(vts.map(vt=>({err:trueVideo((compensate(vt)-startVideo),false)-compensate(vt)}))); })();
console.log(`follow steady-state: max=${steady.mx.toFixed(4)}s rms=${steady.rms.toFixed(4)}s`);
console.log(`open-loop（参考）  : rms=${open.rms.toFixed(4)}s`);
const okSteady = steady.mx < 0.05;
console.log(okSteady ? 'OK: 平滑クロックは定常で ±数十ms に収める' : 'NG');
// stall はバッファ中 getCurrentTime が止まり follow が先走る過渡（~stall長）。BUFFERING検知でのpauseは今後の課題。
process.exit(okSteady ? 0 : 1);
