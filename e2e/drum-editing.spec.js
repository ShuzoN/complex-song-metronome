/* 置いた音・範囲・パート・連符の区間・スウィングの編集と、取り消し */
const { test, expect, groupOf } = require("./support/app");

const drumsOf = async (app, name) => groupOf(await app.exportFromDrums(), name).drums;
const note = (app, inst, b, k) => app.hitRects(`[data-inst="${inst}"][data-b="${b}"][data-k="${k}"]`).first();

test.describe("1音の編集", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });

  test("音をタップして選び、格子1つぶんずつ動かして、消せる", async ({app, page}) => {
    await note(app, "snare", 1, 0).click();
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    await app.click("drSelRight");
    await app.click("drSelRight");
    expect((await drumsOf(app, "Aメロ"))[0].hits.snare).toEqual([1.5, 3, 5, 7]);
    await note(app, "snare", 3, 0).click();
    await app.click("drSelLeft");
    await app.click("drSelDel");
    expect((await drumsOf(app, "Aメロ"))[0].hits.snare).toEqual([1.5, 5, 7]);
  });

  test("選んだ音をもう一度タップすると選択が外れる", async ({app, page}) => {
    await note(app, "kick", 0, 0).click();
    await expect(page.locator("#drSelbar")).toHaveClass(/\bshow\b/);
    await note(app, "kick", 0, 0).click();
    await expect(page.locator("#drSelbar")).not.toHaveClass(/\bshow\b/);
  });

  test("「消す」はいまのパートの打点をすべて消す", async ({app}) => {
    await app.click("drClear");
    expect(await drumsOf(app, "Aメロ")).toEqual([{span: 2}]);
  });
});

test.describe("自動補正", () => {
  test("ずれた打点の数を示し、押すと拍ごとの格子に吸着させる", async ({app, page}) => {
    await app.loadFixture("08-offgrid");
    await app.openDrums();
    await expect(page.locator("#drAutofix")).toHaveText("自動補正 1");
    await app.click("drAutofix");
    await expect(page.locator("#drAutofix")).toHaveText("自動補正");
    expect((await drumsOf(app, "ずれ"))[0].hits).toEqual({hh_close: [0, 0.5, 1.5, 2.25, 3.5], snare: [1, 3], kick: [0, 2, 2.5]});
  });
});

test.describe("範囲", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });

  // カーソルから範囲を始め、Out をカーソルで決める（歩幅は既定の8分）
  async function selectRange(app, fromSteps, toSteps){
    for(let i = 0; i < fromSteps; i++) await app.click("drStepFwd");
    await app.click("drRange");
    for(let i = fromSteps; i < toSteps; i++) await app.click("drStepFwd");
    await app.click("drRout");
  }

  test("範囲を削除すると、その中の打点だけが消える", async ({app}) => {
    await selectRange(app, 8, 16);                      // 3〜4拍目の頭から2小節目の頭まで（4拍〜8拍）
    await app.click("drRdel");
    expect((await drumsOf(app, "Aメロ"))[0].hits).toEqual({hh_close: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], snare: [1, 3], kick: [0, 2.5]});
  });

  test("コピーした範囲を、新しいパートに貼り付けられる", async ({app, page}) => {
    await selectRange(app, 0, 8);                       // 1小節目
    await app.click("drRcopy");
    await expect(page.locator("#drPaste")).toHaveText("貼り付け 12音");
    await page.click("#drPartAdd");
    expect(await app.currentPart()).toBe(1);
    await app.click("drPaste");
    const drums = await drumsOf(app, "Aメロ");
    expect(drums[1]).toEqual({span: 1, hits: {hh_close: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], snare: [1, 3], kick: [0, 2.5]}});
  });

  test("貼り付けはカーソルから続けて貼れ、パートの終わりではみ出したぶんは捨てる", async ({app, page}) => {
    await selectRange(app, 2, 6);                       // 1拍目〜3拍目の頭（snare 1、hh 1〜2.5）
    await app.click("drRcopy");
    await app.click("drPaste");                         // カーソルは Out（3拍目）
    await app.click("drPaste");                         // 続けて 5拍目から
    await app.click("drPaste");                         // 7拍目から（8拍でパートが終わるので半分だけ）
    const hits = (await drumsOf(app, "Aメロ"))[0].hits;
    expect(hits.snare).toEqual([1, 3, 3, 5, 5, 7, 7]);
    expect(hits.hh_close.filter(p => p >= 7)).toEqual([7, 7, 7.5, 7.5]);
  });
});

test.describe("パート", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("02-basic-beat"); await app.openDrums(); });

  test("追加・複製・削除と、長さ・回数の変更", async ({app, page}) => {
    await page.click("#drPartAdd");                     // B：空の1小節
    await app.selectPart(0);
    await app.click("drPartDup");                       // A の直後に A の複製（回数は1）
    expect(await app.currentPart()).toBe(1);
    await page.selectOption("#drRepeat", "3");
    await app.selectPart(0);
    await page.selectOption("#drSpan", "1");            // 2小節 → 1小節：はみ出した打点を消す
    let drums = await drumsOf(app, "Aメロ");
    expect(drums.map(d => [d.span, d.repeat || 1])).toEqual([[1, 1], [2, 3], [1, 1]]);
    expect(drums[0].hits).toEqual({hh_close: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], snare: [1, 3], kick: [0, 2.5]});
    expect(drums[2].hits).toBeUndefined();
    await page.selectOption("#drSpan", "3");            // 1小節 → 3小節：今のパターンを敷き詰める
    drums = await drumsOf(app, "Aメロ");
    expect(drums[0].span).toBe(3);
    expect(drums[0].hits.snare).toEqual([1, 3, 5, 7, 9, 11]);
    await expect(page.locator("#drPartSum")).toHaveText("計 10 / 4小節");
    await app.selectPart(2);
    await app.click("drPartDel");
    // 現状の仕様：最後のパートを消すと、1つ前ではなく先頭のパートが選ばれる
    expect(await app.currentPart()).toBe(0);
    expect((await drumsOf(app, "Aメロ")).length).toBe(2);
  });

  test("最後の1つのパートは消せない", async ({app, page}) => {
    await expect(page.locator("#drPartDel")).toBeDisabled();
  });

  test("パートの合計とグループの長さを並べて示す", async ({app, page}) => {
    await expect(page.locator("#drPartSum")).toHaveText("計 2 / 4小節");
    await expect(page.locator("#drParts .dr-chip[data-pi]")).toHaveText(["A2小節"]);
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
    const drums = await drumsOf(app, "連符の区間");
    expect(drums[0].tuplets).toEqual([[4, 2, 3], [7, 1, 6]]);
    expect(drums[0].hits.snare).toEqual([0, 0.8, 1.6, 2.4, 3.2]);
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
