# dev/playback — 再生系 再実装の検証用モジュール（issue #36）

`docs/playback-redesign.md` の再設計を段階実装するための、**純関数＋ユニットテスト**の作業場。
アプリ本体は `index.html` 単一ファイルのままで、各 stage が固まったらここで検証したロジックを
`index.html` にインライン移植する（本体はこれらを読み込まない）。

- `timeline.mjs` … Stage 1：cue駆動 Timeline ビルダ（D2）。各拍に songPos/vt/anchor を敷く。
- `timeline.test.mjs` … その仕様テスト。`node dev/playback/timeline.test.mjs`

## Stage 進捗
- [x] **Stage 1**：cue駆動 Timeline（純関数・テスト 13/13）
- [x] **Stage 2**：cue駆動 Timeline を `index.html` の `PlaybackService.build` に統合（vt が cue駆動に）。
      イベント shape は不変・音のみ再生は等価（ヘッドレス検証）。vt 単調性は維持し `indexAtVideo` も保たれる。
- [ ] **Stage 3**：`seekAndArrive` 統合（`startAtHead/startAtCue/startAtIndex` → 1本、I2/I8）
- [ ] **Stage 4**：Clock 抽象（VideoClock 平滑化）＋ Follower の follow を導入し、全体/グループ共通で
      各境界を `observePin`（I1/I3/I4/I5）。※Clock/Follower の構造分離は、VideoClock が要る本段でまとめて行う
      （音のみ段で先に層だけ足すと冗長になるため統合）。
- [ ] **Stage 5**：Record レーン分離／UI 駆動を `songPosition()` に一本化／旧モジュール撤去（I7/I12）
