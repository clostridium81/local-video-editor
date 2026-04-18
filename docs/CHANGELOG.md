# Changelog

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
