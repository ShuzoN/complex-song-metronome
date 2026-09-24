/* テストからアプリを操作するための薄い道具箱。
   触るのは画面（DOM の id・ボタン・パッド）と、ブラウザの境目（ファイルの読み込み・ダウンロード・Web Audio）だけ。
   アプリ内部の関数や状態には触らない＝内部を作り替えても、ふるまいが同じならテストは通る。 */
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const base = require("@playwright/test");

const ROOT = path.join(__dirname, "..", "..");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"));
const SPY = path.join(__dirname, "audio-spy.js");
const FIXTURES = path.join(__dirname, "..", "fixtures");
const GOLDEN = path.join(__dirname, "..", "golden");
const ORIGIN = "http://app.test/";

const fixture = name => fs.readFileSync(path.join(FIXTURES, name + ".yml"), "utf8");
const fixtureNames = () => fs.readdirSync(FIXTURES).filter(f => f.endsWith(".yml")).map(f => f.replace(/\.yml$/, "")).sort();

class App {
  constructor(page){ this.page = page; }

  async goto(){
    const page = this.page;
    // 外部（フォント・YouTube・WebAudioFont）への通信は遮断し、アプリは index.html だけを配る
    await page.context().route("**/*", route => {
      const url = route.request().url();
      if(url === ORIGIN || url === ORIGIN + "index.html") return route.fulfill({status: 200, contentType: "text/html; charset=utf-8", body: INDEX});
      return route.abort();
    });
    await page.addInitScript({path: SPY});
    await page.addInitScript(() => {
      // 保存・読み込みのダイアログ API を消して、ダウンロードと <input type=file> の経路に固定する
      delete window.showSaveFilePicker; delete window.showOpenFilePicker;
      try{
        if(!sessionStorage.getItem("__e2e_init")){
          sessionStorage.setItem("__e2e_init", "1");
          localStorage.clear();
          localStorage.setItem("csm:drums.kit", "");        // 音源は内蔵の合成音に固定
          localStorage.setItem("csm:drums.offset", "0");    // タップ補正 0ms
        }
      }catch(_){}
    });
    await page.goto(ORIGIN);
    await base.expect(page.locator("#groups")).toBeVisible();
  }

  // ---- ファイル ----
  async loadYaml(text, name = "fixture.metronome.yml"){
    await this.page.setInputFiles("#ioFile", {name, mimeType: "text/yaml", buffer: Buffer.from(text)});
    await base.expect(this.page.locator("#ioMsg")).toContainText("読み込みました");
  }
  async loadFixture(name){ await this.loadYaml(fixture(name), name + ".metronome.yml"); }
  async exportText(){
    const [dl] = await Promise.all([this.page.waitForEvent("download"), this.page.click("#saveBtn")]);
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }
  async exportDoc(){ return YAML.parse(await this.exportText()); }
  // 書き出し（メトロノーム画面に戻ってから保存する。ドラム画面は開いたままでも保存ボタンは押せない位置にあるため）
  async exportFromDrums(){
    await this.closeDrums();
    const doc = await this.exportDoc();
    await this.openDrums();
    return doc;
  }

  // ---- 画面 ----
  async openDrums(){
    await this.page.click("#drEnter");
    await base.expect(this.page.locator("#drum")).toBeVisible();
  }
  async closeDrums(){
    await this.page.click("#drClose");
    await base.expect(this.page.locator("#drum")).toBeHidden();
  }
  groupChip(name){ return this.page.locator("#drGroups .dr-chip[data-gid]", {hasText: name}); }
  partChip(i){ return this.page.locator(`#drParts .dr-chip[data-pi="${i}"]`); }
  async selectGroup(name){ await this.groupChip(name).click(); await base.expect(this.groupChip(name)).toHaveClass(/\bcur\b/); }
  async selectPart(i){ await this.partChip(i).click(); await base.expect(this.partChip(i)).toHaveClass(/\bcur\b/); }
  async currentGroupName(){ return (await this.page.locator("#drGroups .dr-chip.cur").innerText()).replace(/×\d+$/, "").trim(); }
  async currentPart(){ return Number(await this.page.locator("#drParts .dr-chip.cur").getAttribute("data-pi")); }
  async click(id){ await this.page.click("#" + id); }
  async setStepSize(label){ await this.page.selectOption("#drStepSize", {label}); }
  async stepSizeOptions(){ return this.page.locator("#drStepSize option").allInnerTexts(); }

  // パッド：指1本で叩いて離す（ステップ入力なら置いて1歩進む）
  async pad(inst){
    const p = this.page.locator(`.dr-pad[data-inst="${inst}"]`).first();
    await p.dispatchEvent("pointerdown", {pointerId: 1, isPrimary: true});
    await p.dispatchEvent("pointerup", {pointerId: 1, isPrimary: true});
  }
  // 和音：複数の指で同時に押してから離す
  async chord(insts){
    const ps = insts.map(i => this.page.locator(`.dr-pad[data-inst="${i}"]`).first());
    for(let k = 0; k < ps.length; k++) await ps[k].dispatchEvent("pointerdown", {pointerId: k + 1});
    for(let k = 0; k < ps.length; k++) await ps[k].dispatchEvent("pointerup", {pointerId: k + 1});
  }
  // 譜面上の音符（いま見えている出現のうち n 番目）をタップして選ぶ
  hitRects(sel = ""){ return this.page.locator("#drScore rect.hit" + sel); }

  // ---- 音 ----
  async audio(){ return this.page.evaluate(() => window.__audioSpy.events()); }
  async audioNow(){ return this.page.evaluate(() => window.__audioSpy.now()); }
  async resetAudio(){ await this.page.evaluate(() => window.__audioSpy.reset()); }
  // オーディオの時計が各 t（秒）になった瞬間にパッドを叩く（重ね録り用）。
  // 往復の遅れを入れないよう、並べた打鍵はまとめてブラウザの中で順に実行する
  async padsAt(taps){
    await this.page.evaluate(async taps => {
      for(const {inst, t} of taps){
        const pad = document.querySelector(`.dr-pad[data-inst="${inst}"]`);
        while(window.__audioSpy.now() < t) await new Promise(r => setTimeout(r, 1));
        const ev = type => pad.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 7}));
        ev("pointerdown"); ev("pointerup");
      }
    }, taps);
  }
  async padAt(inst, t){ await this.padsAt([{inst, t}]); }
  // 最初の音が鳴ってから sec 秒ぶん鳴り終わるまで待つ（開始までの空白・準備の長さに左右されない）
  async waitPlayed(sec){
    await this.page.waitForFunction(x => {
      const ev = window.__audioSpy.events().filter(e => !e.cancelled);
      return ev.length > 0 && window.__audioSpy.now() >= ev[0].time + x;
    }, sec, {timeout: (sec + 15) * 1000, polling: 50});
  }
  async waitAudio(sec){ const t = await this.audioNow(); await this.page.waitForFunction(x => window.__audioSpy.now() >= x, t + sec, {timeout: (sec + 10) * 1000}); }
}

function groupOf(doc, name){ const g = doc.groups.find(x => x.name === name); if(!g) throw new Error("no group " + name); return g; }

const test = base.test.extend({
  app: async ({page}, use) => { const app = new App(page); await app.goto(); await use(app); }
});

module.exports = { test, expect: base.expect, App, fixture, fixtureNames, GOLDEN, groupOf, YAML };

// ---- ゴールデン（フィクスチャごとの期待値ファイル）----
// UPDATE_GOLDEN=1 のときは書き出す。リファクタリングの PR ではゴールデンを書き換えない（変わったらふるまいが変わった合図）
function golden(file, actual){
  const p = path.join(GOLDEN, file);
  const text = typeof actual === "string" ? actual : JSON.stringify(actual, null, 1) + "\n";
  if(process.env.UPDATE_GOLDEN){ fs.mkdirSync(GOLDEN, {recursive: true}); fs.writeFileSync(p, text); return; }
  if(!fs.existsSync(p)) throw new Error("ゴールデンがありません: " + file + "（pnpm test:e2e:update で作成）");
  base.expect(text, file).toBe(fs.readFileSync(p, "utf8"));
}

// 譜面の要約：音符（どの出現の何拍目のどの格子にどの楽器）と、譜面上の文字（グループ名・パート名・拍子・連符・シミレの数など）
App.prototype.scoreDigest = async function(){
  return this.page.evaluate(() => {
    const names = {};
    document.querySelectorAll("#drGroups .dr-chip[data-gid]").forEach(c => { names[c.dataset.gid] = c.firstChild.textContent; });
    const svg = document.querySelector("#drScore svg");
    const notes = [...svg.querySelectorAll("rect.hit")].map(r =>
      [names[r.dataset.gid], "part" + r.dataset.pi, "occ" + r.dataset.occ, r.dataset.b + "." + r.dataset.k, r.dataset.inst].join(" "));
    const texts = [...svg.querySelectorAll("text")].map(t => t.textContent.trim()).filter(Boolean);
    return {notes, texts};
  });
};

// 鳴った音の要約：最初の音からの相対時刻（ms）で、取り消されなかったものだけ
function audioDigest(events, windowSec){
  const live = events.filter(e => !e.cancelled);
  if(!live.length) return [];
  const t0 = live[0].time;
  return live.filter(e => e.time - t0 <= windowSec + 1e-9)
    .map(e => Math.round((e.time - t0) * 1000) + " " + (e.kind === "click" ? "click:" + e.level : e.inst))
    .sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
}

module.exports.golden = golden;
module.exports.audioDigest = audioDigest;
