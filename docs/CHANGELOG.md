# Changelog

## [Unreleased] — 素材の絞り込み / ルーラー固定 / 動画の音声だけ利用

### 素材パネル

- **フォルダ機能を削除**。作成・改名・削除・素材のドラッグ移動、および `ProjectState.folders` / `Asset.folderId` を撤去 ([MediaLibrary.vue](../src/components/MediaLibrary.vue), [projectStore.ts](../src/stores/projectStore.ts), [types/project.ts](../src/types/project.ts))
- 代わりに**メディア種別 (動画 / 画像 / 音声) での絞り込み**を追加。チップに件数を表示し、絞り込みで 0 件になった場合は「該当なし + 絞り込み解除」を出す (素材が 1 つも無い場合のドロップ案内とは区別)

### タイムライン

- **時刻ルーラーを上端に固定** (`position: sticky`)。トラックが増えても時刻表示とロケーターのクリック移動が常に使える ([TimelinePanel.vue](../src/components/TimelinePanel.vue))
- トラックヘッダー列を縦スクロールに追従させ、行とヘッダーがずれないようにした (横スクロールバー分の余白も確保)

### 動画素材の音声だけを使う

- **動画ファイルを音声トラックにドロップすると音声クリップになる** (映像は使わない)。BGM / 効果音として動画の音だけを流用できる
- タイムライン上のラベルは `♪ ファイル名` で音声のみ利用と分かるようにした
- プレビューは動画素材を音声源にする場合 `<video>` 要素を非表示のまま音声だけ使う (`<audio>` より確実にデコードされるため) ([previewEngine.ts](../src/engine/previewEngine.ts))
- 書き出しの音声ミックス・波形生成は既存の `decodeAudioData` 経路をそのまま通るため変更なし
- ドロップ可否を素材種別 × トラック種別で判定するよう整理 (画像 → 音声トラック / 音声 → 映像トラックは従来どおり不可)

---

## [0.5.0] — 書き出し高速化 (WebCodecs VideoDecoder シーケンシャルデコード)

書き出しのボトルネックだった「毎フレームの `<video>` シーク待ち」を排除し、動画主体のプロジェクトで書き出しを大幅に高速化した。エンコードは従来どおり WebCodecs (HW支援) + mp4-muxer / webm-muxer。**FFmpeg.wasm 非依存は継続** (検討の結果、WASM エンコーダ化はむしろ 5〜20 倍の劣化になるため不採用)。

### デコードパスの刷新

- 新規 [src/engine/frameSource.ts](src/engine/frameSource.ts): クリップごとの `FrameSource` 抽象 (「素材内時刻 → 描画可能フレーム」)
  - **DecoderFrameSource**: mediabunny (純TS demuxer、mp4-muxer と同一作者) + `VideoDecoder`。クリップが必要とする全フレームの素材内時刻を事前列挙し `VideoSampleSink.samplesAtTimestamps()` でシーケンシャルデコード。KF アラインシーク・重複パケット排除・デコード済みキュー上限 (メモリ抑制) はライブラリ側が管理
  - **VideoElementFrameSource**: 従来の非表示 `<video>` + seek。`VideoDecoder` 非対応環境・コーデック非対応・逆再生 (speed ≤ 0)・同時デコーダ上限 (4) 超過時のフォールバック
  - 実行時のデコード失敗 / タイムアウト (2s) は `<video>` に自動で切り替えて書き出しを続行 (書き出し自体は落とさない)
  - 回転メタデータ付き素材 (iPhone .mov 等) は `VideoSample.draw()` で回転を反映
  - MOV rotation / PAR は displayWidth/Height 基準で描画
- 新規 [src/engine/frameTiming.ts](src/engine/frameTiming.ts): フレームスケジュールの純ロジック (`mapClipTimeToSource` / `clipSourceTimestamps` / `selectSourceKind`)。エクスポートループとデコーダの時刻計算を一元化し、smoke-test の対象に
- 新規 [src/engine/mediabunnyLoader.ts](src/engine/mediabunnyLoader.ts): 使用シンボルのみの静的 re-export を動的 import することでツリーシェイク (mediabunny チャンク 670KB → 220KB / gzip 57KB、書き出し時のみロード)
- `<video>` 要素の事前一括生成をやめ、クリップがアクティブになった時に生成・終了したら即解放 (GIF パスも共通化)

### エンコーダまわりの改善

- `hardwareAcceleration: 'prefer-hardware'` + `latencyMode: 'quality'` を `isConfigSupported` で事前検査して採用 (非対応なら段階的フォールバック) ([exportEngine.ts](src/engine/exportEngine.ts))
- `encodeQueueSize > 8` でバックプレッシャ待ちを追加 (長尺書き出しのメモリ膨張防止)
- 出力 `VideoFrame` に `duration` を付与
- **中断時のリーク修正**: エンコーダ・`<video>`・デコーダの解放を try/finally 化 (従来はキャンセル時に `VideoEncoder` と `<video>` がリークしていた)

### 計測

- 新規 [src/engine/exportProfiler.ts](src/engine/exportProfiler.ts): フレーム取得待ち (frameWait) / 描画 (draw) / エンコード待ち (encodeWait/encodeFlush) / 音声 (audioMix/audioEncode) の内訳を書き出し完了時に 1 行でコンソール出力。`localStorage.setItem('export-profile', '1')` で詳細テーブル
- 完了ログにソース種別の実績 (decoder/element) と HW エンコード採用状況を表示

### その他

- smoke-test に frameTiming / profiler のケースを追加、`npm run smoke` スクリプト追加 (devDependency: tsx)
- design.md にデマックス方針を追記

---

## [0.4.0] — こども向けリリース対応 (やさしい日本語 + 表示切替)

日本のこども向けリリース版として、UI 全体をやさしい日本語に書き換え、ふつうの日本語との切替も可能にした。

### やさしい日本語 / ふつうの日本語 切替

- 新規 [src/composables/useLocale.ts](src/composables/useLocale.ts): `mode: 'easy' | 'normal'` のシングルトン ref + `t(easy, normal)` ヘルパ
- 設定は `localStorage('lve.locale.v1')` に永続化、デフォルトは `'easy'`
- TopBar 右上に **「あ / 漢」 トグルボタン** を追加。クリックで切替 + Toast で通知
- localStorage 不可な環境 (Safari プライベート等) でも動作するよう try/catch で囲んでガード
- GitHub Pages の同一 origin (`*.github.io`) で衝突しないよう、キーは `lve.` プレフィックス済み

### UI 全文を 2 モード対応

- TopBar (Undo/Redo / 新規 / 復元 / バックアップ / 各アイコンボタンの title)
- MediaLibrary (パネル名 / 検索プレースホルダ / フォルダ操作 / 空 state / ドロップ表示 / 素材種別ラベル)
- PreviewPanel (再生・先頭ボタンの title)
- TimelinePanel (＋もじ / ＋かたち / トラック追加 / スナップ・リップル・マーカー・In/Out ボタン / トラックヘッダ Solo/Mute / マーカーヒント)
- InspectorPanel (時間 / 表示 / 配置 / もじ / 音声 / エフェクト / トランジション / 再生 / かさねかた / カラーグレード / クロマキー / もじの かざり / もじの うごき / 図形 / EQ / リンク / 削除 ほぼ全セクションヘッダ)
- ExportDialog / ProjectsDialog / RecorderDialog / AudioMixer / ShortcutHelp (タイトル + ボタン + 説明文)
- TutorialOverlay は `STEPS_EASY` / `STEPS_NORMAL` の 2 配列を持ち、computed でモード反応
- ShortcutHelp の sections も computed でモード反応

### こども向け語彙への置換 (前段の整理)

- タイトル `Local Video Editor` → `どうがメーカー`
- 「保存」→「ほぞん」、「復元」→「よみこむ」、「エクスポート」→「どうがで かきだす」
- 「テキスト」→「もじ」、「図形」→「かたち」、「矩形」→「しかく」、「楕円」→「まる」、「三角形」→「さんかく」、「星」→「ほし」、「矢印」→「やじるし」、「線」→「せん」
- 「不透明度」→「すけぐあい」、「スケール」→「おおきさ」、「回転」→「まわり」、「配置」→「いち」
- 「カラーグレード」→「いろあい」、「クロマキー」→「いろを すきとおらせる」
- 「キーフレーム」→「うごきポイント」、「トランジション」→「つなぎかた」
- 「速度 ×」→「はやさ ばい」、「逆再生」→「うしろから ながす」
- 「ミュート」→「おとを けす」、「ソロ」→「ここだけ ならす」
- 「フォーマット」→「かたち」、「解像度」→「がめんの おおきさ」、「品質」→「きれいさ」
- 「キャンセル」→「やめる」、「OK / 開始」→「はじめる」
- エラー: 「失敗しました」→「できなかったよ」、「容量不足」→「ほぞんできる ばしょが いっぱいだよ」
- デフォルト名: 「無題のプロジェクト」→「なまえなしの さくひん」、テキスト初期文 「テキスト」→「もじ」
- ブレンドモード・テキストアニメ・形状などの選択肢も やさしい表現に (例: `fade` → 「じわじわ あらわれる」、`slide-left` → 「みぎから くる」、`typewriter` → 「タイプライター (1もじずつ)」)

### バグ修正

- **図形クリップのアスペクト比**: `width × canvas_w` / `height × canvas_h` で別々に正規化していたため、`width=height=0.3` でも 1920×1080 では 576×324 の長方形になっていた → 短辺 (`Math.min(w, h)`) を共通基準にし、`width=height` で常に正方形に ([previewEngine.ts](src/engine/previewEngine.ts), [exportEngine.ts](src/engine/exportEngine.ts))
- **PreviewPanel の選択ボックスが図形に未対応**: 選択枠が常にキャンバス全域になっていた → `kind === 'shape'` 分岐を追加し、エンジンと同じ短辺基準で正しい枠を描画
- `ShapeClip.scale?` を型に追加し、canvas ドラッグの一様スケールを明示化
- `addShapeClip` で line / arrow のみ横長 (0.4×0.06)、他は 0.3×0.3 の正方形に初期化

### その他

- index.html の `<title>` を「どうがメーカー」に変更
- README.md / CHANGELOG.md を Phase 2/3 状態へ更新

---

## [0.3.1] — 使い方ツアー

- 初回アクセス時に自動表示される **対話型チュートリアル** を追加 ([TutorialOverlay.vue](src/components/TutorialOverlay.vue))
- スポットライト + 吹き出しで主要領域 (素材ライブラリ / プレビュー / タイムライン / インスペクタ / ツールバー) を順に案内
- ← / → / Enter / Esc のキー操作対応、進捗バー、「今後は表示しない」選択可
- 完了状態は `localStorage` (`lve.tutorialDone.v1`) に保存
- TopBar の 🎓 ボタンまたはショートカットダイアログから再生可能
- 対象要素は `data-tour="..."` 属性で指定しており、将来のレイアウト変更でも追いやすい

## [0.3.0] — Phase 3 プロユース拡張

Google Vids / Premiere 相当のプロレベル機能群を追加。

### 編集ワークフロー

- **スナップ**: playhead、他クリップ境界、マーカー、in/out、プロジェクト端にマグネット
- **マーカー**: `M` キーで即追加、ルーラー上にフラグ表示 (ダブルクリックで改名、右クリックで削除、クリックでジャンプ)
- **In / Out ポイント**: `I`/`O` でセット、`Shift+I` で解除。範囲再生 + 範囲エクスポートに連動
- **リップルモード**: `Shift+R` でトグル
- **クリップリンク**: `Cmd/Ctrl+L` で選択クリップをリンク (動画+音声を一緒に移動)、`Shift+Cmd/Ctrl+L` で解除
- **タイムラインツールバー**: スナップ・リップル・マーカー・In/Out・図形追加のワンクリックボタン
- **トラックソロ**: S ボタンで他のトラックをミュート

### 高度なクリップ機能

- **速度 / 時間リマップ**: 0.25x〜4x、映像音声とも `playbackRate` で対応
- **逆再生**: 音声は OfflineAudioContext でバッファ反転、映像はシーク単位で逆送り
- **ブレンドモード**: normal / multiply / screen / overlay / darken / lighten / color-dodge / color-burn / hard-light / soft-light / difference / exclusion / hue / saturation / color / luminosity / add の 17 種
- **図形クリップ** (新 `shape` ClipKind): rect / ellipse / triangle / star / arrow / line (fill, stroke, stroke-width, corner-radius)
- **クリップリンクグループ**: `linkGroup` で同期移動

### 高度なビジュアル

- **カラーグレード** (video / image): Lift / Gamma / Gain (RGB 独立) + 色温度 + ティント。OffscreenCanvas でピクセルパス
- **クロマキー**: 色指定 + 閾値 + 柔らかさ + スピル抑制。キーカラー近傍を透明化
- **テキスト装飾**: ドロップシャドウ (色/ブラー/X/Y)、アウトライン (色/幅)、字間、行間
- **テキストアニメーション**: none / typewriter / fade-words / slide-chars / bounce / scale-pop / wave

### オーディオ

- **オーディオミキサーパネル** (右下ドッキング): マスター + 各音声トラック。リアルタイム VU メーター (peak ベース推定)、ボリュームフェーダ、ソロ/ミュート
- **マスターボリューム**
- **3 バンド EQ** (音声/映像クリップ): 低 (lowshelf 200Hz) / 中 (peaking 1kHz) / 高 (highshelf 5kHz)
- **ミキシング**: オフラインレンダリング時に BiquadFilter チェーン、ゲインオートメーション、トラック/マスターゲインを正確に適用

### メディアキャプチャ

- **RecorderDialog** でワンクリック録画:
  - カメラ + マイク (getUserMedia)
  - 画面 + システム音声 (getDisplayMedia)
  - マイクのみ (ボイスオーバー)
  - **TTS** (SpeechSynthesis + getDisplayMedia でタブ音声キャプチャ)
- 録画した素材は自動で IndexedDB にアップロードされ、ライブラリに追加

### アセット管理

- **フォルダ**: 作成・改名 (ダブルクリック) ・削除 (右クリック)、素材のドラッグ&ドロップでフォルダ移動
- **検索**: ファイル名・種別・タグで即時フィルタリング
- **プロジェクト管理ダイアログ**: プロジェクトの一覧・切替・複製 (素材込み)・削除・新規作成

### エクスポート

- **GIF 出力**: `gifenc` ベースの quantize + applyPalette でパレット GIF エンコード
- **範囲エクスポート**: Full / In-Out / カスタム
- エクスポート時に speed、reversed、ブレンドモード、カラーグレード、クロマキー、テキストアニメ、図形、EQ、ソロ/マスター音量を全て反映

### UI / UX

- **キーボードショートカットダイアログ** (`?` ボタン): 全ショートカット一覧
- **TopBar** に録音・ミキサー・プロジェクト・ヘルプのクイックアクセスボタン

### ショートカット追加

| キー | 動作 |
|------|------|
| M | 現在位置にマーカー追加 |
| I / O | In 点 / Out 点 |
| Shift + I | In/Out 解除 |
| N | スナップ切替 |
| Shift + R | リップル切替 |
| Cmd/Ctrl + L | クリップリンク |
| Cmd/Ctrl + Shift + L | リンク解除 |

### 依存追加

```json
"gifenc": "^1.0.3"
```

### 破壊的でない型拡張

- `Clip.speed`, `Clip.reversed`, `Clip.blendMode`, `Clip.linkGroup`
- `VideoClip/ImageClip.colorGrade`, `VideoClip/ImageClip.chromaKey`
- `VideoClip/AudioClip.eq`
- `TextClip.decor`, `TextClip.anim`
- 新規 `ShapeClip` (kind: 'shape')
- `Track.solo`, `Track.volume`
- `Asset.folderId`, `Asset.tags`
- `ProjectState.folders`, `ProjectState.markers`
- `timeline.inPoint`, `outPoint`, `snapping`, `rippleMode`, `masterVolume`

---

## [0.2.0] — Phase 2 完成

Phase 1 の MVP に対して、プロレベルの編集機能・エクスポート機能を全面追加。

### A. 編集体験

- **Undo/Redo**
  - `src/stores/history.ts`: JSON スナップショットベースのヒストリマネージャ (max 100)
  - `Ctrl/Cmd+Z` で元に戻す / `Ctrl/Cmd+Shift+Z` または `Ctrl+Y` でやり直し
  - ドラッグ等の高頻度更新は `mergeKey` で 1 履歴にまとめる
  - 素材の追加/削除は IndexedDB 副作用のため履歴外
  - TopBar に undo/redo ボタン (disabled 連動)
- **クリップ分割 (Split)**
  - `splitClipAt(clipId, t)` / `splitSelectedAtPlayhead()`
  - `S` キーで playhead 位置のクリップを分割
  - キーフレームも分割境界で適切に二分 + 境界値を補間
- **コピー / 貼り付け / 複製**
  - `Ctrl/Cmd+C` コピー / `Ctrl/Cmd+X` カット / `Ctrl/Cmd+V` 貼り付け / `Ctrl/Cmd+D` 複製
  - 貼り付けは playhead に移動、新 ID を発行
- **マルチ選択 + ラバーバンド**
  - `useSelection`: 複数 ID 保持
  - Shift/Cmd クリックで追加選択
  - タイムライン空白領域をドラッグして矩形選択
- **キーフレーム**
  - 対象プロパティ: `x`, `y`, `scale`, `rotation`, `opacity`, `volume`
  - easing: `linear`, `easeIn`, `easeOut`, `easeInOut`
  - Inspector に ◆ ダイヤモンドボタンで追加/削除、前後 KF ジャンプ、easing 切替
  - タイムライン上のクリップに KF 位置インジケータ
- **プレビュー直接ドラッグ**
  - 選択中クリップ (video/image/text) に bounding box + ハンドル
  - 本体ドラッグで移動、四隅ハンドルで拡縮、上部円ハンドルで回転

### B. 堅牢性 / UX

- **自動保存 + 起動時復元**
  - IndexedDB `projects` ストア (DB_VERSION: 2)
  - `state.value` を deep watch、1.2s debounce で `saveProjectState`
  - 起動時 `loadLatestProjectState()` で最新プロジェクトを自動復元
- **音声波形**
  - `src/engine/waveform.ts`: `AudioContext.decodeAudioData` → peak 配列生成
  - モジュール内キャッシュ、音声/映像クリップの背面に波形描画
- **エラーハンドリング + Toast**
  - `src/composables/useToast.ts` + `src/components/Toast.vue`
  - 素材アップロード、バックアップ保存/復元、自動保存、エクスポートなど全失敗経路を Toast で通知
  - QuotaExceededError を明示的に捕捉
- **WebCodecs 検出**
  - `src/engine/capabilities.ts`: `hasWebCodecs`, `canEncodeVideo`, `canEncodeAudio`
  - 未対応ブラウザではエクスポートボタンを disabled

### C. 表現力

- **トランジション**
  - Clip に `transitionIn` / `transitionOut` (type, duration)
  - サポート種別: fade, slide-left/right/up/down, zoom, wipe
  - Inspector に種別/時間選択 + フェードプリセット
  - 音量も in/out フェードに追従
- **エフェクト (映像/画像)**
  - Clip に `effects` (brightness, contrast, saturation, blur, hueRotate, grayscale, invert, sepia)
  - Canvas `filter` プロパティで合成
  - Inspector のエフェクトセクションにスライダー

### D. エクスポート

- **MP4 / WebM**
  - `mp4-muxer`, `webm-muxer` を導入
  - WebCodecs VideoEncoder (H.264 / VP9) + AudioEncoder (AAC / Opus)
  - 出力解像度 (プロジェクト / 1080p / 720p / 480p)、FPS、ビットレートプリセット選択可
- **フレームレンダリング**
  - OffscreenCanvas (フォールバック: 通常 canvas) で合成
  - 映像は <video> 要素を `seeked` イベントで同期してフレーム毎に描画
  - `VideoFrame(canvas, { timestamp })` でエンコード
- **音声ミックス**
  - OfflineAudioContext で全クリップ (audio + video の音声) をミックス
  - 音量キーフレーム / フェードを GainNode オートメーションで反映
  - AudioBuffer を 1024 frames ずつ AudioData → AudioEncoder へ
- **進捗 UI + キャンセル**
  - モーダルダイアログでフェーズ別進捗バー、ETA 表示
  - AbortController によるキャンセル対応
  - 完了時に自動ダウンロード、Toast 通知

### その他

- 型定義拡張 (`Keyframe`, `Keyframes`, `Transition`, `ClipEffects`)
- `addTextClip` をマウント手順から独立した store アクション化
- `updateClip(id, patch, mergeKey?)` に `mergeKey` パラメータ追加
- トラックのミュート切替ボタン (TimelinePanel)
- `Arrow Left/Right`: 1 フレームずつ playhead 移動、`Shift+Arrow`: 1 秒、`Home`/`End`: 先頭/末尾

### 依存追加

```json
"mp4-muxer": "^5.2.2",
"webm-muxer": "^5.1.4"
```
