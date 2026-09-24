/* 画面をまたぐ流れ：編集対象の保持と寄せ直し、拍子の変更への追随、グループのカードの表示、端末ごとの設定 */
const { test, expect, groupOf } = require("./support/app");

const card = (page, i) => page.locator("#groups > .group").nth(i);
async function expandCard(page, i){
  const c = card(page, i);
  if(!/\bselected\b/.test(await c.getAttribute("class"))) await c.locator(".g-sub").click();
  await expect(c).toHaveClass(/\bselected\b/);
  return c;
}

test.describe("編集対象", () => {
  test("閉じて開き直すと、前に編集していたグループとカーソルの位置のまま", async ({app, page}) => {
    await app.loadFixture("03-parts");
    await app.openDrums();
    await app.selectGroup("イントロ");
    for(let i = 0; i < 3; i++) await app.click("drStepFwd");      // 7/8 の既定の歩幅（16分＝半拍）で3歩
    await page.keyboard.press("Escape");
    await expect(page.locator("#drum")).toBeHidden();
    await app.openDrums();
    await expect(app.groupChip("イントロ")).toHaveClass(/\bcur\b/);
    await app.pad("crash");                                        // 1.5拍目に置かれる
    expect(groupOf(await app.exportFromDrums(), "イントロ").drums[0].hits.crash).toEqual([1.5]);
  });

  test("編集していたグループが消えたら、別のグループへ移る", async ({app, page}) => {
    await app.loadFixture("03-parts");
    await app.openDrums();
    await app.selectGroup("イントロ");
    await app.closeDrums();
    const c = await expandCard(page, 2);
    await c.locator('button[aria-label="このリズムグループを削除"]').click();
    await expect(page.locator("#groups > .group")).toHaveCount(2);
    await app.openDrums();
    await expect(page.locator("#drGroups .dr-chip[data-gid]")).toHaveCount(2);
    expect(await app.currentGroupName()).not.toBe("イントロ");
  });

  test("ドラム画面でグループを追加して取り消すと、残っているグループへ戻る", async ({app, page}) => {
    await app.loadFixture("02-basic-beat");
    await app.openDrums();
    await page.click("#drGroupAdd");
    await expect(page.locator("#drGroups .dr-chip[data-gid]")).toHaveCount(2);
    expect(await app.currentGroupName()).not.toBe("Aメロ");
    await app.click("drUndo");
    await expect(page.locator("#drGroups .dr-chip[data-gid]")).toHaveCount(1);
    expect(await app.currentGroupName()).toBe("Aメロ");
  });
});

test.describe("拍子の変更への追随", () => {
  test("拍子を変えると、打点は「何小節目の何拍目」に付いたまま移り、はみ出した拍の打点は消える", async ({app, page}) => {
    await app.loadFixture("02-basic-beat");
    const c = await expandCard(page, 0);
    await c.locator('select[aria-label="1番目の拍子の分子"]').selectOption("3");
    const g = groupOf(await app.exportDoc(), "Aメロ");
    expect(g.pattern).toEqual(["3/4"]);
    expect(g.drums).toEqual([{span: 2, hits: {
      hh_close: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5], snare: [1, 4], kick: [0, 2.5, 3, 5.5]
    }}]);
    await page.click("#undoBtn");
    expect(groupOf(await app.exportDoc(), "Aメロ").drums[0].hits.snare).toEqual([1, 3, 5, 7]);
  });

  test("拍子を消すと、残った拍子の打点が前へ詰まる", async ({app, page}) => {
    await app.loadFixture("03-parts");
    const c = await expandCard(page, 2);
    await c.locator(".bar").first().locator('button[aria-label="削除"]').click();
    const g = groupOf(await app.exportDoc(), "イントロ");
    expect(g.pattern).toEqual(["3/4"]);
    expect(g.drums).toEqual([{span: 1, hits: {snare: [1], kick: [0, 0.5]}}]);
  });

  test("拍子を並べ替えると、打点も小節ごと入れ替わる", async ({app, page}) => {
    await app.loadFixture("03-parts");
    const c = await expandCard(page, 2);
    await c.locator(".bar").first().locator('button[aria-label="下へ移動"]').click();
    const g = groupOf(await app.exportDoc(), "イントロ");
    expect(g.pattern).toEqual(["3/4", "7/8"]);
    expect(g.drums).toEqual([{span: 1, hits: {snare: [1, 5, 8], kick: [0, 0.5, 3, 6]}}]);
  });
});

test.describe("メトロノーム画面との行き来", () => {
  test("ドラムのあるグループのカードに、ドラムの構成が出る", async ({app, page}) => {
    await app.loadFixture("03-parts");
    await expect(card(page, 0).locator(".chip.drm")).toHaveText("ドラム 2小節×2 + 1小節");
    await expect(card(page, 1).locator(".chip.drm")).toHaveCount(0);
  });

  test("ドラム画面で置くと、閉じたあとのカードにも出る（空いている小節は休み）", async ({app, page}) => {
    await app.loadFixture("01-plain");
    await app.openDrums();
    await app.pad("kick");
    await app.closeDrums();
    await expect(card(page, 0).locator(".chip.drm")).toHaveText("ドラム 1小節 + 休み3小節");
  });
});

test.describe("端末ごとの設定", () => {
  test("音源の選択は端末に残り、取得できないときは合成音で鳴らすと知らせる", async ({app, page}) => {
    await app.openDrums();
    await app.click("drCfgOpen");
    await page.selectOption("#drKit", {label: "FluidR3 #1"});
    await expect(page.locator("#drKitStat")).toHaveText("音源を取得できず、合成音で鳴らしています");
    await page.reload();
    await app.openDrums();
    await expect(page.locator("#drKit")).toHaveValue("FluidR3_GM_sf2_file:1");
    const exported = await (async () => { await app.closeDrums(); return app.exportText(); })();
    expect(exported).not.toContain("FluidR3");                   // 曲ファイルには書かない
  });
});
