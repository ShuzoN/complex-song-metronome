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
- [x] **Stage 3**：`seekAndArrive` に頭出しを統合（`startAtHead/startAtCue/startAtIndex` → 単一プリミティブ＋
      単一 `pollCue`、I2/I8）。音のみ等価・ヘッドレス検証。
- [x] **Stage 4**：`VideoClock`（平滑動画クロック・#36 C1）＋ Follower の follow を導入（I1/I3/I4/I5）。
      各拍を「その拍の vt へ動画が達する音声時刻」へ寄せる連続追従。全体/グループ共通・録音時は無効。
      検証：`videoclock.sim.mjs` で定常 rms ~21ms（対 open-loop ~102ms/60s）。動画は seek せず音の連続性を維持。
      残課題：バッファ中は getCurrentTime が停止し follow が先走る過渡（BUFFERING検知でのpauseは今後）。
- [ ] **Stage 5**：Record レーン分離／UI 駆動を `songPosition()` に一本化／旧モジュール撤去（I7/I12）
