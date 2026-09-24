/* 再生：区間ループ・範囲ループ・クリックの切り替え・メトロノーム画面での鳴らし分け・重ね録り・再生位置への追従 */
const { test, expect, groupOf } = require("./support/app");

const live = evs => evs.filter(e => !e.cancelled);
const drumsIn = evs => live(evs).filter(e => e.kind === "drum");
const clicksIn = evs => live(evs).filter(e => e.kind === "click");
// 最初の小節頭のクリックからの相対（拍）に直す
function beatsFrom(evs, t0, beatSec){ return evs.map(e => Math.round((e.time - t0) / beatSec * 1000) / 1000); }

test.describe("区間ループ", () => {
  test("▶ はそのグループをくり返し、打点は拍の位置で鳴る（パートが足りない小節は空きで、頭から回さない）", async ({app}) => {
    await app.loadFixture("09-quick-parts");
    await app.openDrums();
    await app.selectGroup("速い");
    await app.click("drPlay");
    await app.waitPlayed(4.3);                            // 240BPM：1小節1秒。グループ4小節＋1周目の頭
    await app.click("drStop");
    const evs = await app.audio(), t0 = clicksIn(evs)[0].time;
    const drums = drumsIn(evs).filter(e => e.time - t0 < 4.2);
    expect(drums.map(e => e.inst + "@" + beatsFrom([e], t0, 0.25)[0])).toEqual([
      "kick@0", "kick@2", "snare@5", "snare@7", "kick@16"   // 3〜4小節目は空き、5小節目でグループの頭に戻る
    ]);
  });

  test("「クリック」を切るとクリックだけ鳴らなくなる", async ({app}) => {
    await app.loadFixture("02-basic-beat");
    await app.openDrums();
    await app.click("drClick");
    await app.click("drPlay");
    await app.waitPlayed(1.2);
    await app.click("drStop");
    const evs = await app.audio();
    expect(clicksIn(evs)).toEqual([]);
    expect(drumsIn(evs).length).toBeGreaterThan(5);
  });

  test("スウィングは組の後ろの音だけを遅らせ、連符の拍と小節末で欠けた組はストレートのまま", async ({app}) => {
    await app.loadFixture("05-swing-tuplets");
    await app.openDrums();
    await app.selectGroup("16分ハネ");                     // 7/8・16分・60%：8分の拍の後半を 0.6 へ
    await app.click("drPlay");
    await app.waitPlayed(2.6);
    await app.click("drStop");
    const evs = await app.audio(), c = clicksIn(evs), t0 = c[0].time, beat = c[1].time - c[0].time;
    const hh = beatsFrom(drumsIn(evs).filter(e => e.inst === "hh_close" && e.time - t0 < 7 * beat - 1e-6), t0, beat);
    expect(hh).toEqual([0, 0.6, 1, 1.6, 2, 2.6, 3, 3.6, 4, 4.6, 5, 5.6, 6, 6.6]);
  });

  test("停止すると、先に予約していた音は取り消される", async ({app}) => {
    await app.loadFixture("02-basic-beat");
    await app.openDrums();
    await app.click("drPlay");
    await app.waitPlayed(0.6);
    await app.click("drStop");
    const stopAt = await app.audioNow();
    const after = (await app.audio()).filter(e => e.time > stopAt + 0.01);
    expect(after.every(e => e.cancelled)).toBe(true);
  });
});

test.describe("範囲ループ", () => {
  test("選んだ範囲だけをくり返し鳴らし、その間にパッドを叩いても記録しない（現状の仕様）", async ({app, page}) => {
    await app.loadFixture("02-basic-beat");
    await app.openDrums();
    await app.click("drStepFwd"); await app.click("drStepFwd");        // 1拍目（0 起点）
    await app.click("drRange");
    await app.click("drStepFwd"); await app.click("drStepFwd");
    await app.click("drRout");                                          // 1〜2拍
    await expect(page.locator("#drPlay")).toHaveAttribute("aria-label", "選択した範囲をくり返し再生");
    await app.click("drPlay");
    await expect(page.locator("#drStatus")).toHaveText("選択を再生中");
    await app.waitPlayed(1.4);
    await app.pad("crash");
    await app.click("drPlay");                                          // もう一度押すと止まる
    const evs = await app.audio(), t0 = clicksIn(evs)[0].time;
    // 叩いた crash はその場で鳴るだけ（予約された音には入らない）
    const drums = drumsIn(evs).filter(e => e.inst !== "crash" && e.time >= t0 && e.time - t0 < 1.45).map(e => e.inst + "@" + Math.round((e.time - t0) * 1000));
    expect(drums).toEqual(["hh_close@0", "snare@0", "hh_close@250", "hh_close@500", "snare@500", "hh_close@750", "hh_close@1000", "snare@1000", "hh_close@1250"]);
    expect(groupOf(await app.exportFromDrums(), "Aメロ").drums[0].hits.crash).toBeUndefined();
  });
});

test.describe("メトロノーム画面", () => {
  test("「ドラム入力で置いた打点も鳴らす」を外すとクリックだけになり、その設定は再読み込み後も残る", async ({app, page}) => {
    await app.loadFixture("02-basic-beat");
    await page.click("#pbPlay");
    await app.waitPlayed(0.8);
    await page.click("#pbPlay");
    expect(drumsIn(await app.audio()).length).toBeGreaterThan(0);
    await page.locator("#drumsOn").uncheck();
    await page.reload();
    await expect(page.locator("#drumsOn")).not.toBeChecked();
    await app.loadFixture("02-basic-beat");
    await page.click("#pbPlay");
    await app.waitPlayed(0.8);
    await page.click("#pbPlay");
    const evs = await app.audio();
    expect(clicksIn(evs).length).toBeGreaterThan(0);
    expect(drumsIn(evs)).toEqual([]);
  });

  test("ドラム画面を開いている間は、その設定を外していてもドラムを鳴らす", async ({app, page}) => {
    await app.loadFixture("02-basic-beat");
    await page.locator("#drumsOn").uncheck();
    await app.openDrums();
    await app.click("drPlay");
    await app.waitPlayed(0.8);
    await app.click("drStop");
    expect(drumsIn(await app.audio()).length).toBeGreaterThan(0);
  });
});

test.describe("重ね録り", () => {
  // 録音を始め、最初の小節頭のクリック時刻と拍の長さを返す
  async function startRec(app){
    await app.click("drRec");
    await app.page.waitForFunction(() => window.__audioSpy.events().filter(e => e.kind === "click" && !e.cancelled).length >= 2);
    const c = clicksIn(await app.audio());
    return {t0: c[0].time, beat: c[1].time - c[0].time};
  }

  test("鳴っている拍に合わせて叩いた位置に打点を積み、1回の録音は取り消し1手", async ({app, page}) => {
    await app.loadFixture("01-plain");
    await app.openDrums();
    const {t0, beat} = await startRec(app);
    await app.padsAt([
      {inst: "kick", t: t0 + 4 * beat + 0.01},           // 2小節目の頭（少し遅れて叩く）
      {inst: "snare", t: t0 + 5 * beat - 0.01},          // 2拍目（少し早く叩く）
      {inst: "snare", t: t0 + 5 * beat + 0.005},         // 同じ楽器を 50ms 以内にもう一度 → 1発とみなす
      {inst: "hh_close", t: t0 + 5.5 * beat}
    ]);
    await app.click("drStop");
    let hits = groupOf(await app.exportFromDrums(), "A").drums[0].hits;
    expect(Object.keys(hits).sort()).toEqual(["hh_close", "kick", "snare"]);
    // 叩いたままの位置で残る（格子への吸着は表示と再生のとき）。許容は 0.12 拍
    expect(Math.abs(hits.kick[0] - 4)).toBeLessThan(0.12);
    expect(hits.snare).toHaveLength(1);
    expect(Math.abs(hits.snare[0] - 5)).toBeLessThan(0.12);
    expect(Math.abs(hits.hh_close[0] - 5.5)).toBeLessThan(0.12);
    await app.click("drAutofix");
    hits = groupOf(await app.exportFromDrums(), "A").drums[0].hits;
    expect(hits).toEqual({hh_close: [5.5], snare: [5], kick: [4]});
    await app.click("drUndo"); await app.click("drUndo");  // 自動補正と、録音1回ぶん
    expect(groupOf(await app.exportFromDrums(), "A").drums).toBeUndefined();
  });

  test("ハネている区間で叩いた音は、ストレートの位置に戻して記録する", async ({app}) => {
    await app.loadFixture("05-swing-tuplets");
    await app.openDrums();
    await app.selectGroup("シャッフル");
    await app.click("drClear");
    const {t0, beat} = await startRec(app);
    await app.padAt("rim", t0 + 1.67 * beat);             // 8分・67%：裏は 0.67 拍目で鳴る
    await app.click("drStop");
    const hits = groupOf(await app.exportFromDrums(), "シャッフル").drums[0].hits;
    expect(Math.abs(hits.rim[0] - 1.5)).toBeLessThan(0.08);   // そのままなら 1.67 付近
  });

  test("停止中は録音にならず、叩いた音はステップ入力になる", async ({app, page}) => {
    await app.loadFixture("01-plain");
    await app.openDrums();
    await app.click("drStep");                            // STEP を切る
    await app.pad("kick");
    expect(groupOf(await app.exportFromDrums(), "A").drums).toBeUndefined();
    await app.click("drStep");
    await app.pad("kick");
    expect(groupOf(await app.exportFromDrums(), "A").drums[0].hits).toEqual({kick: [0]});
  });
});

test.describe("再生位置への追従", () => {
  test("再生中は、鳴っているグループ・パートが編集対象になる", async ({app, page}) => {
    await app.loadFixture("09-quick-parts");
    await app.openDrums();
    await app.selectGroup("前");
    await app.click("drSong");
    await expect(app.groupChip("速い")).toHaveClass(/\bcur\b/, {timeout: 5000});
    await expect(app.partChip(0)).toHaveClass(/\bcur\b/, {timeout: 5000});
    await expect(app.partChip(1)).toHaveClass(/\bcur\b/, {timeout: 5000});
    await app.click("drStop");
  });

  test("再生中は、鳴っているフレーズのチップに印が付き、止めると消える", async ({app, page}) => {
    await app.loadFixture("09-quick-parts");
    await app.openDrums();
    await app.selectGroup("速い");
    await app.click("drPlay");
    await expect(app.partChip(1)).toHaveClass(/\bplay\b/, {timeout: 5000});
    await expect(app.partChip(0)).not.toHaveClass(/\bplay\b/);
    await expect(app.partChip(0)).toHaveClass(/\bplay\b/, {timeout: 5000});
    await app.click("drStop");
    await expect(page.locator("#drParts .dr-chip.play")).toHaveCount(0);
  });
});
