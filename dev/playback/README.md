# dev/playback — 再生系 再実装の検証用モジュール（issue #36）

`docs/playback-redesign.md` の再設計を段階実装するための、**純関数＋ユニットテスト**の作業場。
アプリ本体は `index.html` 単一ファイルのままで、各 stage が固まったらここで検証したロジックを
`index.html` にインライン移植する（本体はこれらを読み込まない）。

- `timeline.mjs` … Stage 1：cue駆動 Timeline ビルダ（D2）。各拍に songPos/vt/anchor を敷く。
- `timeline.test.mjs` … その仕様テスト。`node dev/playback/timeline.test.mjs`

## Stage 進捗
- [x] Stage 1：cue駆動 Timeline（テスト 13/13）
- [ ] Stage 2：Clock（AudioClock）＋ Follower Scheduler（音のみ等価）
- [ ] Stage 3：seekAndArrive 統合
- [ ] Stage 4：VideoClock 平滑化＋follow（observePin）
- [ ] Stage 5：Record レーン分離／UI 一本化／旧モジュール撤去
