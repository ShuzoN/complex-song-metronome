/* ステップ入力：止まっているときにパッドを叩くと、カーソルの位置に置いて1歩進む */
const { test, expect, groupOf } = require("./support/app");

const drumsOf = async (app, name) => groupOf(await app.exportFromDrums(), name).drums;

test.describe("ステップ入力", () => {
  test.beforeEach(async ({app}) => { await app.loadFixture("01-plain"); await app.openDrums(); });

  test("既定は8分で置いて進み、同時押しは同じ位置に置く。拍子1つのグループは2小節のパートになる", async ({app}) => {
    await app.chord(["kick", "hh_close"]);
    await app.pad("hh_close");
    await app.pad("snare");
    await app.click("drStepFwd");            // 休符
    await app.pad("kick");
    const drums = await drumsOf(app, "A");
    expect(drums).toEqual([{span: 2, hits: {hh_close: [0, 0.5], snare: [1], kick: [0, 2]}}]);
  });

  test("歩幅の候補は拍子の分母で決まり、粗い順にスライダーに並ぶ。16分の歩幅で細かく置ける", async ({app}) => {
    expect(await app.stepSizeOptions()).toEqual(["4拍3連", "拍", "4拍5連", "2拍3連", "4拍7連", "8分", "2拍5連", "3連", "16分", "5連", "6連", "7連", "32分", "9連"]);
    expect(await app.stepSize()).toBe("8分");
    await app.setStepSize("16分");
    for(const i of ["kick", "hh_close", "hh_close", "snare"]) await app.pad(i);
    const drums = await drumsOf(app, "A");
    expect(drums[0].hits).toEqual({hh_close: [0.25, 0.5], snare: [0.75], kick: [0]});
  });

  test("1拍に収まる連符の歩幅で置くとその拍が連符の区間になり、8分で置き直すと区間が外れる", async ({app}) => {
    await app.setStepSize("3連");
    for(const i of ["snare", "snare", "snare"]) await app.pad(i);
    let drums = await drumsOf(app, "A");
    expect(drums[0].tuplets).toEqual([[0, 1, 3]]);
    expect(drums[0].hits.snare).toEqual([0, 0.333, 0.667]);
    await expect(app.page.locator("#drTupOff")).toBeHidden();       // カーソルは次の拍（区間の外）
    await app.click("drStepBack");
    await expect(app.page.locator("#drTupOff")).toHaveText("3連を外す");
    await app.click("drStepBack"); await app.click("drStepBack");   // 拍の頭へ
    await app.setStepSize("8分");
    await app.pad("kick");
    drums = await drumsOf(app, "A");
    expect(drums[0].tuplets).toBeUndefined();
    expect(drums[0].hits).toEqual({snare: [0, 0.333, 0.667], kick: [0]});
  });

  test("複数の拍にまたがる連符（2拍3連）は拍の頭から区間を作り、区間の中を等分に進む", async ({app}) => {
    await app.setStepSize("2拍3連");
    for(const i of ["tom_hi", "tom_low", "floor", "kick"]) await app.pad(i);
    const drums = await drumsOf(app, "A");
    expect(drums[0].tuplets).toEqual([[0, 2, 3], [2, 2, 3]]);
    expect(drums[0].hits).toEqual({tom_hi: [0], tom_low: [0.667], floor: [1.333], kick: [2]});
  });

  test("歩幅のスライダーは目盛りの名前をタップしても、なぞっても選べる", async ({app}) => {
    const rng = app.page.locator("#drStepSize"), box = await rng.boundingBox();
    const tick = await app.page.locator('#drStepTicks span[data-name="3連"]').boundingBox();
    await app.page.mouse.click(tick.x + tick.width / 2, tick.y + tick.height / 2);
    expect(await app.stepSize()).toBe("3連");
    await app.page.mouse.move(box.x + 4, box.y + 8);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + box.width - 4, box.y + 8, {steps: 8});
    await app.page.mouse.up();
    expect(await app.stepSize()).toBe("9連");
    await app.page.keyboard.press("ArrowLeft");
    expect(await app.stepSize()).toBe("32分");
  });

  test("「拍」の歩幅は1拍ずつ進む", async ({app}) => {
    await app.setStepSize("拍");
    for(const i of ["kick", "snare", "kick", "snare"]) await app.pad(i);
    expect((await drumsOf(app, "A"))[0].hits).toEqual({snare: [1, 3], kick: [0, 2]});
  });
});

test.describe("ステップ入力とパートの境目", () => {
  test("パートの終わりを越えると次のパートの頭へ移り、戻ると前のパートの最後の歩へ戻る", async ({app}) => {
    await app.loadFixture("03-parts");
    await app.openDrums();
    await app.selectGroup("Aメロ");
    await app.setStepSize("拍");
    for(let i = 0; i < 7; i++) await app.click("drStepFwd");      // パートA（2小節＝8拍）の最後の拍
    expect(await app.currentPart()).toBe(0);
    await app.click("drStepFwd");                                   // 終わりを越える
    expect(await app.currentPart()).toBe(1);
    await app.pad("kick");                                          // Bの頭に置く
    await app.click("drStepBack"); await app.click("drStepBack");
    expect(await app.currentPart()).toBe(0);
    await app.pad("crash");                                         // Aの最後の拍（7拍目）に置く
    const drums = groupOf(await app.exportFromDrums(), "Aメロ").drums;
    expect(drums[0].hits.crash).toEqual([7]);
    expect(drums[1].hits.kick).toEqual([0]);
  });

  test("最後のパートの終わりより先には置けない", async ({app}) => {
    await app.loadFixture("02-basic-beat");
    await app.openDrums();
    await app.setStepSize("拍");
    for(let i = 0; i < 8; i++) await app.click("drStepFwd");
    await app.pad("crash");
    const drums = groupOf(await app.exportFromDrums(), "Aメロ").drums;
    expect(drums[0].hits.crash).toBeUndefined();
  });
});
