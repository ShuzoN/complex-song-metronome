/* 置いた音・範囲・小節の並び（くり返しのまとめ）・連符の区間・スウィングの編集と、取り消し */
const { test, expect, groupOf, groupHits } = require("./support/app");

const drumsOf = async (app, name) => groupOf(await app.exportFromDrums(), name).drums;
// グループの頭からの拍位置で、各楽器がどこで鳴るか（02-basic-beat の Aメロは 4/4 ×4＝16拍）
const hitsOf = async (app, name) => groupHits(groupOf(await app.exportFromDrums(), name));
const before = (ps, end) => ps.filter(p => p < end);
const from = (ps, start) => ps.filter(p => p >= start);
const note = (app, inst, b, k) => app.hitRects(`[data-inst="${inst}"][data-b="${b}"][data-k="${k}"]`).first();

test.describe("1音の編集", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });

  test("音をタップして選び、格子1つぶんずつ動かして、消せる（直すのはその小節だけ）", async ({app, page}) => {
    await note(app, "snare", 1, 0).click();
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    await app.click("drSelRight");
    await app.click("drSelRight");
    expect((await hitsOf(app, "Aメロ")).snare).toEqual([1.5, 3, 5, 7, 9, 11, 13, 15]);
    await note(app, "snare", 3, 0).click();
    await app.click("drSelLeft");
    await app.click("drSelDel");
    expect((await hitsOf(app, "Aメロ")).snare).toEqual([1.5, 5, 7, 9, 11, 13, 15]);
  });

  test("選んだ音をもう一度タップすると選択が外れる", async ({app, page}) => {
    await note(app, "kick", 0, 0).click();
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    await note(app, "kick", 0, 0).click();
    await expect(page.locator("#drSelbar")).not.toHaveClass(/\bshow\b/);
  });

  test("「消す」はいまのグループの打点をすべて消す", async ({app}) => {
    await app.click("drClear");
    expect(await drumsOf(app, "Aメロ")).toBeUndefined();
  });
});

test.describe("自動補正", () => {
  test("ずれた打点の数を示し、押すと拍ごとの格子に吸着させる", async ({app, page}) => {
    await app.loadFixture("08-offgrid");
    await app.openDrums();
    await expect(page.locator("#drAutofix")).toHaveText("自動補正 2");      // グループの2小節ぶん
    await app.click("drAutofix");
    await expect(page.locator("#drAutofix")).toHaveText("自動補正");
    expect(await drumsOf(app, "ずれ")).toEqual([{span: 1, repeat: 2, hits: {hh_close: [0, 0.5, 1.5, 2.25, 3.5], snare: [1, 3], kick: [0, 2, 2.5]}}]);
  });
});

test.describe("範囲", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });

  // カーソルから範囲を始め、Out をカーソルで決める（歩幅は既定の8分）
  async function selectRange(app, fromSteps, toSteps){
    for(let i = 0; i < fromSteps; i++) await app.click("drStepFwd");
    await app.click("drRange");
    for(let i = fromSteps; i < toSteps; i++) await app.click("drStepFwd");
   
  }

  test("範囲を切り取ると、その中の打点が消えてクリップボードに残り、別の位置に貼れる", async ({app, page}) => {
    await selectRange(app, 0, 2);                       // 1拍目（hh 0・0.5、kick 0）
    await app.click("drRcut");
    await expect(page.locator("#drRangebar")).not.toHaveClass(/\bshow\b/);
    await expect(page.locator("#drPaste")).toHaveText("貼り付け 3音");
    let h = await hitsOf(app, "Aメロ");
    expect(h.hh_close.slice(0, 2)).toEqual([1, 1.5]);
    expect(h.kick).toEqual([2.5, 4, 6.5, 8, 10.5, 12, 14.5]);   // 切り取ったのは1小節目だけ
    for(let i = 0; i < 16; i++) await app.click("drStepFwd"); // 3小節目の頭（8拍目）へ
    await app.click("drPaste");
    h = await hitsOf(app, "Aメロ");
    expect(h.kick).toEqual([2.5, 4, 6.5, 8, 10.5, 12, 14.5]);   // 貼る先の音は置き換える（kick が重ならない）
    expect(h.hh_close.filter(p => p === 8 || p === 8.5)).toEqual([8, 8.5]);
  });

  test("五線の外をダブルタップすると、範囲も音符の選択も外れる", async ({app, page}) => {
    await selectRange(app, 0, 4);
    await note(app, "snare", 1, 0).click();
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    const box = await page.locator("#drScore").boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + 12);   // 譜面の上の空白
    await expect(page.locator("#drSelbar")).not.toHaveClass(/\bshow\b/);
    await expect(page.locator("#drRangebar")).not.toHaveClass(/\bshow\b/);
  });

  test("元に戻す・やり直すは範囲や音符を選んでいる間も出ている", async ({app, page}) => {
    await selectRange(app, 0, 2);
    await expect(page.locator("#drUndo")).toBeVisible();
    await expect(page.locator("#drRedo")).toBeVisible();
    await expect(page.locator("#drAutofix")).toBeHidden();
  });

  test("範囲を選んだまま元に戻せる", async ({app, page}) => {
    await selectRange(app, 0, 2);
    await app.click("drRdel");
    expect(before((await hitsOf(app, "Aメロ")).kick, 8)).toEqual([2.5, 4, 6.5]);
    await expect(page.locator("#drRangebar")).toHaveClass(/\bshow\b/);
    await app.click("drUndo");
    expect((await drumsOf(app, "Aメロ"))[0].hits.kick).toEqual([0, 2.5, 4, 6.5]);
  });

  test("範囲を選んだまま音符を選んで動かせ、選択を外すと範囲の操作に戻る", async ({app, page}) => {
    await selectRange(app, 0, 4);                       // 1〜2拍目
    await note(app, "snare", 1, 0).click();
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    await expect(page.locator("#drRangebar")).not.toHaveClass(/\bshow\b/);
    await app.click("drSelRight");                      // 格子（16分）1つぶん後ろへ
    expect((await hitsOf(app, "Aメロ")).snare).toEqual([1.25, 3, 5, 7, 9, 11, 13, 15]);
    await app.click("drSelClr");
    await expect(page.locator("#drRangebar")).toHaveClass(/\bshow\b/);
  });

  test("範囲を削除すると、その中の打点だけが消える", async ({app}) => {
    await selectRange(app, 8, 16);                      // 3〜4拍目の頭から2小節目の頭まで（4拍〜8拍）
    await app.click("drRdel");
    const h = await hitsOf(app, "Aメロ");
    expect(before(h.hh_close, 8)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(before(h.snare, 8)).toEqual([1, 3]);
    expect(before(h.kick, 8)).toEqual([0, 2.5]);
    expect(from(h.kick, 8)).toEqual([8, 10.5, 12, 14.5]);   // 3〜4小節目はそのまま
  });

  test("貼り付けはカーソルから続けて貼れ、グループの終わりではみ出したぶんは捨てる", async ({app}) => {
    await selectRange(app, 2, 6);                       // 1拍目〜3拍目の頭（snare 1、hh 1〜2.5、kick 2.5）
    await app.click("drRcopy");
    await app.click("drPaste");                         // カーソルは Out（3拍目）→ 3〜5拍目を置き換える
    await app.click("drPaste");                         // 続けて 5拍目から
    let h = await hitsOf(app, "Aメロ");
    expect(before(h.snare, 8)).toEqual([1, 3, 5, 7]);
    expect(before(h.kick, 8)).toEqual([0, 2.5, 4.5, 6.5]);
    for(let i = 0; i < 16; i++) await app.click("drStepFwd");   // カーソルは7拍目 → 最後の拍（15拍目）へ
    await app.click("drPaste");                         // 16拍でグループが終わるので半分だけ（15拍目の kick 16.5 は捨てる）
    h = await hitsOf(app, "Aメロ");
    expect(from(h.snare, 8)).toEqual([9, 11, 13, 15]);
    expect(from(h.kick, 8)).toEqual([8, 10.5, 12, 14.5]);
    expect(from(h.hh_close, 15)).toEqual([15, 15.5]);
  });
});

test.describe("小節の並び", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });

  test("グループの長さを示す", async ({app}) => {
    expect(await app.groupLength()).toBe("全 4小節");
  });

  test("空いた小節にコピーして貼ると、同じ内容の小節は1つのくり返しにまとまる", async ({app, page}) => {
    await app.click("drClear");
    await expect(page.locator("#drHint")).toBeVisible();
    for(const i of ["kick", "hh_close", "snare", "hh_close"]) await app.pad(i);   // 8分で 0〜1.5
    await app.click("drStepBack"); await app.click("drStepBack"); await app.click("drStepBack"); await app.click("drStepBack");
    await app.click("drRange"); for(let i = 0; i < 8; i++) await app.click("drStepFwd");   // 1小節目
    await app.click("drRcopy");                          // カーソルは2小節目の頭
    let drums = await drumsOf(app, "Aメロ");
    expect(drums).toEqual([{span: 1, hits: {hh_close: [0.5, 1.5], snare: [1], kick: [0]}}, {span: 1, repeat: 3}]);
    for(let i = 0; i < 3; i++) await app.click("drPaste");
    drums = await drumsOf(app, "Aメロ");
    expect(drums).toEqual([{span: 1, repeat: 4, hits: {hh_close: [0.5, 1.5], snare: [1], kick: [0]}}]);
    // 譜面は1小節目だけ音符で書き、残りはシミレ
    expect(await app.hitRects().evaluateAll(rs => [...new Set(rs.map(r => Math.floor(r.dataset.b / 4)))])).toEqual([0]);
  });

  test("シミレの小節にカーソルを入れると音符で開き、その小節だけを直せる", async ({app}) => {
    // 2小節のパターン ×2：3〜4小節目（8〜15拍）はシミレ
    expect(await app.hitRects().evaluateAll(rs => rs.some(r => Number(r.dataset.b) >= 8))).toBe(false);
    for(let i = 0; i < 16; i++) await app.click("drStepFwd");   // 3小節目の頭へ
    await note(app, "snare", 9, 0).click();
    await app.click("drSelDel");
    const h = await hitsOf(app, "Aメロ");
    expect(h.snare).toEqual([1, 3, 5, 7, 11, 13, 15]);
    // 1〜2小節目（同じ内容）は1小節 ×2 のくり返し、直した3小節目と4小節目は別のパート
    expect((await drumsOf(app, "Aメロ")).map(d => [d.span, d.repeat || 1])).toEqual([[1, 2], [2, 1]]);
  });
});

test.describe("連符の区間", () => {
  test("カーソルが区間の中にあるときだけ外すボタンが出て、外しても打点は残る", async ({app, page}) => {
    await app.loadFixture("05-swing-tuplets");
    await app.openDrums();
    await app.selectGroup("連符の区間");
    await expect(page.locator("#drTupOff")).toHaveText("4分5連を外す");
    await app.click("drTupOff");
    await expect(page.locator("#drTupOff")).toBeHidden();
    // 外れるのはカーソルのある1回目だけ（2回目の区間は残る）
    const drums = await drumsOf(app, "連符の区間");
    expect(drums[0].tuplets).toEqual([[4, 2, 3], [7, 1, 6], [8, 4, 5], [12, 2, 3], [15, 1, 6]]);
    expect(groupHits(groupOf(await app.exportFromDrums(), "連符の区間")).snare).toEqual([0, 0.8, 1.6, 2.4, 3.2, 8, 8.8, 9.6, 10.4, 11.2]);
  });
});

test.describe("スウィング", () => {
  test("音価と割合を選べ、ストレートに戻しても割合を覚えている", async ({app, page}) => {
    await app.loadFixture("02-basic-beat");
    await app.openDrums();
    await expect(page.locator("#drSwingAmt")).toBeDisabled();
    await page.selectOption("#drSwingUnit", "8");
    expect(groupOf(await app.exportFromDrums(), "Aメロ").swing).toEqual({unit: 8, amount: 67});
    await page.locator("#drSwingAmt").fill("60");
    await expect(page.locator("#drSwingVal")).toHaveText("60%");
    expect(groupOf(await app.exportFromDrums(), "Aメロ").swing).toEqual({unit: 8, amount: 60});
    await page.selectOption("#drSwingUnit", "0");
    expect(groupOf(await app.exportFromDrums(), "Aメロ").swing).toBeUndefined();
    await page.selectOption("#drSwingUnit", "16");
    expect(groupOf(await app.exportFromDrums(), "Aメロ").swing).toEqual({unit: 16, amount: 60});
    await expect(page.locator("#drMeter")).toContainText("Swing");
  });
});

test.describe("取り消し", () => {
  test("ドラム画面の操作は1手ずつ取り消し・やり直しでき、メトロノーム画面と履歴を共有する", async ({app, page}) => {
    await app.loadFixture("01-plain");
    await app.openDrums();
    for(const i of ["kick", "snare", "kick"]) await app.pad(i);
    await app.click("drUndo");
    expect(groupOf(await app.exportFromDrums(), "A").drums[0].hits).toEqual({snare: [0.5], kick: [0]});
    await app.click("drRedo");
    await app.click("drUndo"); await app.click("drUndo"); await app.click("drUndo");
    expect(groupOf(await app.exportFromDrums(), "A").drums).toBeUndefined();
    await app.click("drRedo");
    await app.closeDrums();
    await page.click("#redoBtn");                        // メトロノーム画面の ↷ でも続きをやり直せる
    expect(groupOf(await app.exportDoc(), "A").drums[0].hits).toEqual({snare: [0.5], kick: [0]});
  });
});

/* 範囲・音符を選んだまま歩幅のボタンを押すと、その部分の音をその歩幅（連符）の格子に置き直す */
test.describe("選んだ部分を連符に置き直す", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });
  async function selectRange(app, fromSteps, toSteps){
    for(let i = 0; i < fromSteps; i++) await app.click("drStepFwd");
    await app.click("drRange");
    for(let i = fromSteps; i < toSteps; i++) await app.click("drStepFwd");
   
  }
  const stepBtn = (app, name) => app.page.click(`#drStepSize button[data-name="${name}"]`);

  test("範囲を選んで8分3連を押すと、拍の中の音が並び順のまま3連の格子に乗り、1手で戻せる", async ({app}) => {
    await selectRange(app, 0, 2);                         // 1拍目（hh 0・0.5、kick 0）
    await stepBtn(app, "8分3連");
    let d = (await drumsOf(app, "Aメロ"))[0];
    expect(d.tuplets).toEqual([[0, 1, 3]]);
    expect(d.hits.hh_close.slice(0, 3)).toEqual([0, 0.667, 1]);
    expect((await hitsOf(app, "Aメロ")).kick).toEqual([0, 2.5, 4, 6.5, 8, 10.5, 12, 14.5]);
    if(await app.page.locator("#drRangebar").evaluate(e => e.classList.contains("show"))) await app.click("drRclr");   // 範囲中は ↶ が隠れる
    await app.click("drUndo");
    d = (await drumsOf(app, "Aメロ"))[0];
    expect(d.tuplets).toBeUndefined();
    expect(d.hits.hh_close.slice(0, 3)).toEqual([0, 0.5, 1]);
  });

  test("複数拍の連符は範囲をその拍数の区切りにそろえ、区切りごとに1つの区間にする", async ({app}) => {
    await selectRange(app, 0, 8);                         // 1〜4拍目：hh 8分8つ
    await stepBtn(app, "8分7連");                         // 2拍7連 ×2：4つずつの音を7つの格子へ
    const d = (await drumsOf(app, "Aメロ"))[0];
    expect(d.tuplets).toEqual([[0, 2, 7], [2, 2, 7]]);
    expect(d.hits.hh_close.slice(0, 8).every((p, i, a) => i === 0 || p > a[i - 1])).toBe(true);   // 並び順はそのまま
    expect(before((await hitsOf(app, "Aメロ")).hh_close, 8).length).toBe(16);
  });

  test("格子より音が多いときは何も変えず、理由を出す", async ({app, page}) => {
    await selectRange(app, 0, 2);                         // 1拍目 → 4分3連なら2拍（hh 4つ＋snare）に広がる
    await stepBtn(app, "4分3連");
    await expect(page.locator("#drToast")).toHaveText(/入りません/);
    const d = (await drumsOf(app, "Aメロ"))[0];
    expect(d.tuplets).toBeUndefined();
    expect(d.hits.hh_close.slice(0, 4)).toEqual([0, 0.5, 1, 1.5]);
  });

  test("音符を1つ選んで押すと、その音の拍を置き直し、選択はその音のまま", async ({app, page}) => {
    await note(app, "snare", 1, 0).click();
    await stepBtn(app, "8分3連");
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    await app.click("drSelDel");                          // 選び直した音（スネア）が消える＝選択が付いてきている
    const d = (await drumsOf(app, "Aメロ"))[0];
    expect(d.tuplets).toEqual([[1, 1, 3]]);
    expect(d.hits.hh_close.slice(2, 4)).toEqual([1, 1.667]);
    expect((await hitsOf(app, "Aメロ")).snare).toEqual([3, 5, 7, 9, 11, 13, 15]);
  });
});

test.describe("連符の置き直しの解除", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });
  const stepBtn = (app, name) => app.page.click(`#drStepSize button[data-name="${name}"]`);

  test("もう8分3連になっている範囲でもう一度8分3連を押すと、8分に置き直して歩幅も8分になる", async ({app, page}) => {
    await app.click("drRange"); for(let i = 0; i < 2; i++) await app.click("drStepFwd");
    await stepBtn(app, "8分3連");
    await stepBtn(app, "8分3連");                         // 解除
    await expect(page.locator("#drStepSize button.on")).toHaveAttribute("data-name", "8分");
    const d = (await drumsOf(app, "Aメロ"))[0];
    expect(d.tuplets).toBeUndefined();
    expect(d.hits.hh_close.slice(0, 3)).toEqual([0, 0.5, 1]);
  });

  test("置き直すのは選んだ中の音だけで、音のない拍には連符を張らない", async ({app}) => {
    await app.closeDrums();
    await app.loadFixture("01-plain");
    await app.openDrums();
    for(const i of ["kick", "snare"]) await app.pad(i);   // 8分で 0・0.5
    await app.click("drStepBack"); await app.click("drStepBack");
    await app.click("drRange"); for(let i = 0; i < 4; i++) await app.click("drStepFwd");   // 1〜2拍目（2拍目は空）
    await stepBtn(app, "8分3連");
    const d = (await drumsOf(app, "A"))[0];
    expect(d.tuplets).toEqual([[0, 1, 3]]);
    expect(d.hits).toEqual({snare: [0.667], kick: [0]});
  });

  test("解除は選んだ音で判定する：音のある拍がすべて8分3連なら、空の拍が混じっていても解除になる", async ({app, page}) => {
    await app.closeDrums();
    await app.loadFixture("01-plain");
    await app.openDrums();
    await app.setStepSize("8分3連");
    for(const i of ["kick", "snare"]) await app.pad(i);   // 1拍目だけ 8分3連（0・0.333）
    await app.click("drRange"); for(let i = 0; i < 4; i++) await app.click("drStepFwd");   // 1〜2拍目（2拍目は空）
    await stepBtn(app, "8分3連");
    await expect(page.locator("#drStepSize button.on")).toHaveAttribute("data-name", "8分");
    const d = (await drumsOf(app, "A"))[0];
    expect(d.tuplets).toBeUndefined();
    expect(d.hits).toEqual({snare: [0.5], kick: [0]});
  });

  test("音符を選んでいても、その音の連符の区間が同じ連符なら解除し、選択はその音に付いてくる", async ({app, page}) => {
    await app.closeDrums();
    await app.loadFixture("01-plain");
    await app.openDrums();
    await app.setStepSize("8分3連");
    for(const i of ["kick", "snare"]) await app.pad(i);   // 0・0.333
    await app.hitRects('[data-inst="snare"]').first().click();
    await stepBtn(app, "8分3連");                         // 解除 → 8分
    await expect(page.locator("#drStepSize button.on")).toHaveAttribute("data-name", "8分");
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    await app.click("drSelRight");                        // 選択はスネアに付いてきている（0.5 → その拍の格子＝16分1つぶん後ろへ）
    const d = (await drumsOf(app, "A"))[0];
    expect(d.tuplets).toBeUndefined();
    expect(d.hits).toEqual({snare: [0.75], kick: [0]});
  });

});

test.describe("選んだ音をまるごと1つの連符にする", () => {
  const stepBtn = (app, name) => app.page.click(`#drStepSize button[data-name="${name}"]`);
  test("6つ選んで6連を押すと選んだ拍全体が1つの6連になって均等に並び、もう一度押すとその音符（4分）のストレートに並べ直す", async ({app, page}) => {
    await app.loadFixture("01-plain");
    await app.openDrums();
    // 8分で 0 kick・1 snare・1.5 snare・2 kick・3 snare・3.5 snare（4拍に6つ）
    for(const i of ["kick", null, "snare", "snare", "kick", null, "snare", "snare"]) i ? await app.pad(i) : await app.click("drStepFwd");
    for(let i = 0; i < 8; i++) await app.click("drStepBack");
    await app.click("drRange"); for(let i = 0; i < 8; i++) await app.click("drStepFwd");
    await stepBtn(app, "8分6連");
    let d = (await drumsOf(app, "A"))[0];
    expect(d.tuplets).toEqual([[0, 4, 6]]);
    expect(d.hits).toEqual({snare: [0.667, 1.333, 2.667, 3.333], kick: [0, 2]});
    await expect(page.locator("#drStepSize button.on")).toHaveAttribute("data-name", "4分6連");
    await stepBtn(app, "4分6連");                         // 解除：4分に戻す（4拍に6つは入らないので、後ろへはみ出して6拍ぶん並べる）
    d = (await drumsOf(app, "A"))[0];
    expect(d.tuplets).toBeUndefined();
    expect(d.hits).toEqual({snare: [1, 2, 4, 5], kick: [0, 3]});
    await expect(page.locator("#drStepSize button.on")).toHaveAttribute("data-name", "4分");
  });
});

test.describe("連符からストレートへ戻すとき入り切らない", () => {
  const stepBtn = (app, name) => app.page.click(`#drStepSize button[data-name="${name}"]`);
  test("8分6連（2拍に6つ）を選んで8分を押すと、後ろへはみ出して3拍ぶんの8分に並べ直す", async ({app}) => {
    await app.loadFixture("01-plain");
    await app.openDrums();
    await app.setStepSize("8分6連");
    for(let i = 0; i < 6; i++) await app.pad(i % 2 ? "snare" : "kick");
    for(let i = 0; i < 6; i++) await app.click("drStepBack");
    await app.click("drRange"); for(let i = 0; i < 6; i++) await app.click("drStepFwd");   // 2拍
    await stepBtn(app, "8分");
    const d = (await drumsOf(app, "A"))[0];
    expect(d.tuplets).toBeUndefined();
    expect(d.hits).toEqual({snare: [0.5, 1.5, 2.5], kick: [0, 1, 2]});
  });

  test("はみ出す先に音があるときは何も変えず、理由を出す", async ({app, page}) => {
    await app.loadFixture("01-plain");
    await app.openDrums();
    await app.setStepSize("8分6連");
    for(let i = 0; i < 6; i++) await app.pad("kick");
    await app.setStepSize("4分"); await app.pad("snare");  // 2拍目の頭（6連のすぐ後ろ）
    await app.setStepSize("8分6連");
    for(let i = 0; i < 12; i++) await app.click("drStepBack");   // 先頭まで戻す
    await app.click("drRange"); for(let i = 0; i < 6; i++) await app.click("drStepFwd");
    await stepBtn(app, "8分");
    await expect(page.locator("#drToast")).toHaveText(/音があります/);
    expect((await drumsOf(app, "A"))[0].tuplets).toEqual([[0, 2, 6]]);
  });
});
