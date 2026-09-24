// E2E／インテグレーションテスト（アプリは index.html 1枚。外部への通信はテストの中で遮断する）
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  retries: 0,                       // 不安定さを再試行で隠さない
  workers: 1,                       // 音の時刻を見るテストがあるので、CPU を取り合わせない
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    viewport: { width: 1280, height: 800 },
    locale: "ja-JP",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"],
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
    }
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }]
});
