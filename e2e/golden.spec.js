/* フィクスチャ（e2e/fixtures/*.yml）ごとに、同じ観点を毎回確かめる。
   - 読み込んで書き出した YAML
   - ドラム画面で各グループを見て回ったあとでも、書き出しが変わらないこと（見るだけではパートを作り直さない）
   - 譜面に出る音符と文字
   - 通し再生で鳴る音（最初の数秒）
   期待値は e2e/golden/ にある。 */
const { test, expect, fixtureNames, golden, audioDigest } = require("./support/app");

const PLAY_WINDOW = 5;   // 通し再生で比べる秒数

for(const name of fixtureNames()){
  test.describe(name, () => {
    test("読み込んで書き出した YAML", async ({app}) => {
      await app.loadFixture(name);
      golden(name + ".export.yml", await app.exportText());
    });

    test("ドラム画面で見て回っても保存内容は変わらず、譜面はゴールデンどおり", async ({app, page}) => {
      await app.loadFixture(name);
      await app.openDrums();
      const chips = page.locator("#drGroups .dr-chip[data-gid]:not([aria-disabled])");
      const n = await chips.count();
      for(let i = 0; i < n; i++) await chips.nth(i).click();
      await chips.first().click();
      golden(name + ".score.json", await app.scoreDigest());
      await app.closeDrums();
      golden(name + ".export.yml", await app.exportText());
    });

    test("通し再生で鳴る音", async ({app}) => {
      await app.loadFixture(name);
      await app.openDrums();
      await app.click("drSong");
      await app.waitPlayed(PLAY_WINDOW + 0.3);
      await app.click("drStop");
      golden(name + ".audio.json", audioDigest(await app.audio(), PLAY_WINDOW));
    });
  });
}
