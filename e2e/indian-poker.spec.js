/* インディアンポーカー（indian-poker.html）：同じ合言葉の端末どうしで数字を配り、自分の数字だけ隠し、答え合わせで全員に開く。
   本物の Trystero（WebRTC＋公開リレー）の代わりに、同じブラウザ内のタブどうしを BroadcastChannel でつなぐ偽物を配る。
   joinRoom / selfId / makeAction(send・onMessage) / onPeerJoin / onPeerLeave / leave だけを真似る。 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const PAGE = fs.readFileSync(path.join(__dirname, "..", "indian-poker.html"));
const ORIGIN = "http://app.test/";
const TRYSTERO = "https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm";

const FAKE_TRYSTERO = `
export const selfId = Math.random().toString(36).slice(2, 12);
export function joinRoom(config, roomId){
  const bc = new BroadcastChannel("fake:" + config.appId + ":" + config.password + ":" + roomId);
  (window.__fakeChannels ||= []).push(bc);
  const known = new Set(), handlers = {};
  const post = m => bc.postMessage({...m, from: selfId});
  const room = {
    onPeerJoin: null, onPeerLeave: null,
    makeAction(ns){
      const a = {onMessage: null, send(data, opt = {}){ post({t: "msg", ns, data, to: opt.target}); return Promise.resolve(); }};
      handlers[ns] = a;
      return a;
    },
    leave(){ try{ post({t: "bye"}); bc.close(); }catch(_){} return Promise.resolve(); }
  };
  const meet = id => { if(!known.has(id)){ known.add(id); room.onPeerJoin && room.onPeerJoin(id); } };
  bc.onmessage = ({data: m}) => {
    if(m.to && m.to !== selfId) return;
    if(m.t === "hello"){ meet(m.from); post({t: "ack", to: m.from}); }
    else if(m.t === "ack") meet(m.from);
    else if(m.t === "bye"){ if(known.delete(m.from)) room.onPeerLeave && room.onPeerLeave(m.from); }
    else if(m.t === "msg"){ meet(m.from); handlers[m.ns]?.onMessage?.(m.data, {peerId: m.from}); }
  };
  setTimeout(() => post({t: "hello"}), 0);
  return room;
}
`;

async function openPlayer(context, name, key = "さくら"){
  const page = await context.newPage();
  await page.goto(ORIGIN);
  await page.fill("#nameInput", name);
  await page.fill("#keyInput", key);
  await page.click("#joinBtn");
  await expect(page.locator("#table")).toBeVisible();
  return page;
}
const card = (page, name) => page.locator(`#cards > li[data-player="${name}"]`);
const num = (page, name) => card(page, name).locator("[data-num]");

test.beforeEach(async ({context}) => {
  await context.route("**/*", route => {
    const url = route.request().url();
    if(url === ORIGIN) return route.fulfill({status: 200, contentType: "text/html; charset=utf-8", body: PAGE});
    if(url === TRYSTERO) return route.fulfill({status: 200, contentType: "text/javascript", body: FAKE_TRYSTERO});
    return route.abort();
  });
});

test("自分の数字だけ見えず、答え合わせで全員の数字が全員に開く", async ({context}) => {
  const names = ["あき", "はる", "なつ"];
  const pages = [];
  for(const n of names) pages.push(await openPlayer(context, n));
  for(const p of pages){
    await expect(p.locator("#members > li")).toHaveCount(3);
    await expect(p.locator("#dealBtn")).toBeEnabled();
  }

  await pages[1].click("#dealBtn");

  // 誰の画面でも、自分のカードは「?」で数字の要素が無く、他人のカードは数字が見える
  const seen = {};
  for(const [i, p] of pages.entries()){
    await expect(p.locator("#cards > li")).toHaveCount(3);
    await expect(num(p, names[i])).toHaveCount(0);
    await expect(card(p, names[i])).toContainText("?");
    for(const other of names.filter(n => n !== names[i])){
      const n = Number(await num(p, other).textContent());
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(100);
      if(other in seen) expect(n).toBe(seen[other]);   // 全員が同じ配り方を見ている
      seen[other] = n;
    }
  }
  expect(new Set(Object.values(seen)).size).toBe(3);   // 重ならない

  // 答え合わせは2回押しで開く
  await pages[0].click("#revealBtn");
  await expect(pages[2].locator("#revealBtn")).toHaveText("答え合わせ");
  await pages[0].click("#revealBtn");

  for(const p of pages){
    await expect(p.locator("#revealBtn")).toBeHidden();
    for(const n of names) await expect(num(p, n)).toHaveText(String(seen[n]));
    await expect(p.locator("#dealBtn")).toHaveText("次のラウンドを配る");
  }
});

test("次のラウンドは配り直され、途中から来た人は観戦してから参加する", async ({context}) => {
  const a = await openPlayer(context, "あき");
  const b = await openPlayer(context, "はる");
  await expect(a.locator("#dealBtn")).toBeEnabled();
  await a.click("#dealBtn");
  await expect(b.locator("#roundLabel")).toHaveText("第1ラウンド");

  const c = await openPlayer(context, "なつ");
  await expect(c.locator("#roundLabel")).toHaveText("第1ラウンド");
  await expect(c.locator("#spectator")).toBeVisible();
  await expect(num(c, "あき")).toHaveCount(1);
  await expect(num(c, "はる")).toHaveCount(1);
  await expect(b.locator("#waitingList")).toContainText("なつ");

  await b.click("#revealBtn");
  await b.click("#revealBtn");
  await expect(c.locator("#dealBtn")).toBeEnabled();
  await c.click("#dealBtn");
  for(const p of [a, b, c]){
    await expect(p.locator("#roundLabel")).toHaveText("第2ラウンド");
    await expect(p.locator("#cards > li")).toHaveCount(3);
  }
  await expect(c.locator("#spectator")).toBeHidden();
  await expect(num(c, "なつ")).toHaveCount(0);
});

test("合言葉が違う人とは同じテーブルにならない", async ({context}) => {
  const a = await openPlayer(context, "あき", "さくら");
  const b = await openPlayer(context, "はる", "もみじ");
  await expect(a.locator("#members > li")).toHaveCount(1);
  await expect(b.locator("#members > li")).toHaveCount(1);
  await expect(a.locator("#dealBtn")).toBeDisabled();
});

test("退室した人のカードは切断と表示され、1人では配れない", async ({context}) => {
  const a = await openPlayer(context, "あき");
  const b = await openPlayer(context, "はる");
  await expect(a.locator("#dealBtn")).toBeEnabled();
  await a.click("#dealBtn");
  await expect(b.locator("#cards > li")).toHaveCount(2);
  await b.click("#leaveBtn");
  await expect(card(a, "はる")).toContainText("切断");
  await expect(a.locator("#peerCount")).toHaveText("1人");
});

test("再接続すると、配られた数字はそのままでテーブルに戻る", async ({context}) => {
  const a = await openPlayer(context, "あき");
  const b = await openPlayer(context, "はる");
  await expect(a.locator("#dealBtn")).toBeEnabled();
  await a.click("#dealBtn");
  const aNum = await num(b, "あき").textContent();

  await b.click("#reconnectBtn");
  await expect(b.locator("#peerCount")).toHaveText("2人");
  await expect(card(a, "はる")).not.toContainText("切断");
  await expect(b.locator("#roundLabel")).toHaveText("第1ラウンド");
  await expect(num(b, "あき")).toHaveText(aNum);
  await expect(num(b, "はる")).toHaveCount(0);

  // 再接続後も答え合わせが全員に届く
  await b.click("#revealBtn");
  await b.click("#revealBtn");
  await expect(num(a, "あき")).toHaveText(aNum);
});

test("切れている間に配り直されても、再接続すると新しいラウンドに追いつく", async ({context}) => {
  const a = await openPlayer(context, "あき");
  const b = await openPlayer(context, "はる");
  const c = await openPlayer(context, "なつ");
  await expect(a.locator("#dealBtn")).toBeEnabled();
  await a.click("#dealBtn");
  await expect(c.locator("#roundLabel")).toHaveText("第1ラウンド");

  // なつの通信だけ黙って止める（相手には退室が届かない＝実機でスリープしたときに近い）
  await c.evaluate(() => { for(const bc of window.__fakeChannels) bc.close(); });
  await a.click("#revealBtn");
  await a.click("#revealBtn");
  await a.click("#dealBtn");
  await expect(b.locator("#roundLabel")).toHaveText("第2ラウンド");
  await expect(c.locator("#roundLabel")).toHaveText("第1ラウンド");

  await c.click("#reconnectBtn");
  await expect(c.locator("#roundLabel")).toHaveText("第2ラウンド");
  await expect(num(c, "なつ")).toHaveCount(0);
  await expect(num(c, "あき")).toHaveText(await num(b, "あき").textContent());
});

test.describe("お題モード", () => {
  const WORDS = JSON.parse("[" + PAGE.toString().match(/const WORDS = \[([\s\S]*?)\];/)[1] + "]");
  const word = (page, name) => card(page, name).locator("[data-word]");

  test("名詞は重なりなく300個", () => {
    expect(WORDS).toHaveLength(300);
    expect(new Set(WORDS).size).toBe(300);
    for(const w of ["うさぎ", "飛行機", "工具"]) expect(WORDS).toContain(w);
  });

  test("お題を選んで配ると、自分のお題だけ見えず、答え合わせで全員に開く", async ({context}) => {
    const names = ["あき", "はる", "なつ"];
    const pages = [];
    for(const n of names) pages.push(await openPlayer(context, n));
    await expect(pages[0].locator("#dealBtn")).toBeEnabled();
    await pages[0].click('[data-mode="word"]');
    await expect(pages[0].locator('[data-mode="word"]')).toHaveAttribute("aria-checked", "true");
    await expect(pages[0].locator("#dealBtn")).toHaveText("お題を配る");
    await pages[0].click("#dealBtn");

    const seen = {};
    for(const [i, p] of pages.entries()){
      await expect(p.locator("#rangeLabel")).toHaveText("お題（名詞）");
      await expect(word(p, names[i])).toHaveCount(0);
      await expect(card(p, names[i])).toContainText("?");
      await expect(p.locator("[data-num]")).toHaveCount(0);
      for(const other of names.filter(n => n !== names[i])){
        const w = await word(p, other).textContent();
        expect(WORDS).toContain(w);
        if(other in seen) expect(w).toBe(seen[other]);
        seen[other] = w;
      }
    }
    expect(new Set(Object.values(seen)).size).toBe(3);

    await pages[1].click("#revealBtn");
    await expect(pages[1].locator("#revealBtn")).toHaveText("もう一度押すと全員のお題を開きます");
    await pages[1].click("#revealBtn");
    for(const p of pages){
      for(const n of names) await expect(word(p, n)).toHaveText(seen[n]);
      await expect(p.locator("#cards")).not.toContainText("位");
    }

    // 数字に戻して配り直せる
    await pages[2].click('[data-mode="num"]');
    await pages[2].click("#dealBtn");
    await expect(pages[0].locator("#roundLabel")).toHaveText("第2ラウンド");
    await expect(num(pages[0], "はる")).toHaveCount(1);
    await expect(pages[0].locator("[data-word]")).toHaveCount(0);
  });
});

test.describe("チェーン店モード", () => {
  const CHAINS = JSON.parse("[" + PAGE.toString().match(/const CHAINS = \[([\s\S]*?)\];/)[1] + "]");
  const word = (page, name) => card(page, name).locator("[data-word]");

  test("全国チェーンは重なりなく60個で、ブランドごとに分かれている", () => {
    expect(CHAINS).toHaveLength(60);
    expect(new Set(CHAINS).size).toBe(60);
    for(const w of ["ガスト", "バーミヤン", "吉野家", "GEO", "ダイソー", "業務スーパー", "コストコ"]) expect(CHAINS).toContain(w);
    expect(CHAINS).not.toContain("スカイラーク");
  });

  test("チェーン店を選んで配ると、自分の分だけ見えず、答え合わせで開く", async ({context}) => {
    const a = await openPlayer(context, "あき");
    const b = await openPlayer(context, "はる");
    await expect(a.locator("#dealBtn")).toBeEnabled();
    await a.click('[data-mode="chain"]');
    await expect(a.locator("#dealBtn")).toHaveText("チェーン店を配る");
    await a.click("#dealBtn");

    await expect(b.locator("#rangeLabel")).toHaveText("全国チェーン店");
    await expect(word(a, "あき")).toHaveCount(0);
    await expect(word(b, "はる")).toHaveCount(0);
    const aChain = await word(b, "あき").textContent();
    const bChain = await word(a, "はる").textContent();
    expect(CHAINS).toContain(aChain);
    expect(CHAINS).toContain(bChain);
    expect(aChain).not.toBe(bChain);

    await b.click("#revealBtn");
    await expect(b.locator("#revealBtn")).toHaveText("もう一度押すと全員のチェーン店を開きます");
    await b.click("#revealBtn");
    await expect(word(a, "あき")).toHaveText(aChain);
    await expect(word(b, "はる")).toHaveText(bChain);
    await expect(a.locator("#dealBtn")).toHaveText("次のラウンドを配る");
  });
});
