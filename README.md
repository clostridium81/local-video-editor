# Local Video Editor (ブラウザローカル動画編集アプリ)

**完全にブラウザ内で動作する動画編集アプリケーション**。
素材ファイルや編集データが外部サーバーに送信されることはありません (通信は Web フォントの読み込みのみ)。素材はセッション中ブラウザ内 (IndexedDB) でのみ扱われます。

> **保存についての注意**: プロジェクトの自動保存・自動復元はありません。タブを閉じると編集内容は消えます。保存は**バックアップ ZIP のエクスポート/インポートのみ**です (未保存の編集があるままタブを閉じようとするとリマインダーが表示されます)。

## 機能一覧

### 編集

- 素材ファイル (動画 / 画像 / 音声) のドラッグ&ドロップ・ファイル選択アップロード、フォルダ整理
- タイムラインへの配置 (ドラッグ or ダブルクリック)
- マルチトラック (映像/音声)、トラック追加・ミュート・ソロ
- クリップの移動・左右トリム (ドラッグ)、フレーム単位移動 (`,` / `.`)
- **マルチ選択** (Shift/Cmd クリック, ラバーバンド)
- **クリップ分割** (`S`)、**クリップリンク** (`Cmd/Ctrl+L`)
- **コピー / カット / 貼り付け / 複製** (`Cmd/Ctrl+C/X/V/D`)
- **Undo / Redo** (`Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y`)
- **キーフレーム** (x / y / scale / rotation / opacity / volume, easing 4 種)
- **プレビュー直接ドラッグ** (move / scale / rotate ハンドル)
- テキストクリップ (フォント、サイズ、色、背景、太字/斜体、配置、**アニメーション・装飾**)
- **シェイプクリップ** (矩形 / 楕円 / 線 / 星 / 三角 / 矢印)
- **エフェクト / フィルター** (明るさ、コントラスト、彩度、ブラー、色相、グレースケール、反転、セピア) + **プリセット** (シネマティック、ヴィンテージ ほか)
- **カラーグレード / クロマキー / ピクセルエフェクト** (モザイク、ポスタライズ、ビネット、グレイン、色収差 ほか)
- **ブレンドモード**
- **トランジション** (fade / slide × 4 / zoom / wipe, 入/出)
- 逆再生・速度変更 (クリップ単位)
- 音声波形表示、**3 バンド EQ・音量ブースト** (プレビューにも反映)、**オーディオミキサー**
- **マーカー** (`M`)、**In/Out 範囲** (`I` / `O`)、スナップ (`N`)、リップル (`Shift+R`)
- **J / K / L シャトル再生** (連打でレート 1→2→4→8、逆再生対応)
- やさしい日本語モード切替、チュートリアルツアー、ショートカットヘルプ

### 録画・録音

- **カメラ録画 / 画面録画 / マイク録音**をアプリ内から実行し、そのまま素材に追加
- 画面録画では**マイク音声の同時録音**を選択可能 (画面共有音声とミックス)
- **読み上げ (TTS) ナレーション生成** (SpeechSynthesis)

### 保存

- **バックアップ ZIP** でのプロジェクト全体エクスポート / インポート
- 未バックアップの編集を検知して**タブを閉じる前にリマインド** (内容ハッシュによる差分検知)
- `navigator.storage.persist()` によるストレージ永続化リクエストと残量表示

### エクスポート

- **MP4** (H.264 + AAC) / **WebM** (VP9 + Opus) / **GIF**
- 用途プリセット (形式 / 解像度 / fps / 画質を一括設定)、In/Out 範囲のみの書き出し
- 進捗表示 + キャンセル
- WebCodecs 未対応ブラウザでは該当機能を無効化

## 起動

```bash
npm install
npm run dev
```

`http://localhost:5173` で起動。

本番ビルド:

```bash
npm run build
```

`dist/` に出力。

## キーボードショートカット

アプリ内のショートカットヘルプ (TopBar の `?`) からも参照できます。

### 再生

| キー | 動作 |
|------|------|
| Space | 再生 / 一時停止 |
| J / K / L | 逆再生 / 停止 / 再生 (連打でレート 1→2→4→8) |
| ← / → | playhead を 1 フレーム移動 |
| Shift + ← / → | playhead を 1 秒移動 |
| ↑ / ↓ | 前 / 次の編集点へジャンプ |
| Home / End | 先頭 / 末尾へ |

### 編集

| キー | 動作 |
|------|------|
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y | Redo |
| Cmd/Ctrl+C / X / V / D | コピー / カット / 貼り付け / 複製 |
| Cmd/Ctrl+A | 全クリップ選択 |
| S | 選択中 (or playhead 下) クリップを分割 |
| , / . | 選択クリップを 1 フレーム移動 |
| Shift + , / . | 選択クリップを 1 秒移動 |
| Cmd/Ctrl+L | クリップをリンク |
| Cmd/Ctrl+Shift+L | リンクを解除 |
| Delete / Backspace | 選択クリップを削除 |

### タイムライン

| キー | 動作 |
|------|------|
| M | 現在位置にマーカー追加 |
| I / O | In 点 / Out 点を設定 |
| Shift + I | In/Out 解除 |
| N | スナップ切替 |
| Shift + R | リップル切替 |

## ディレクトリ構成

```
src/
├── main.ts                          エントリ (起動時ストレージ掃除 + マウント)
├── App.vue
├── types/project.ts                 状態モデル型
├── persistence/
│   ├── assetStore.ts                IndexedDB (素材 Blob)
│   ├── mediaMeta.ts                 メタデータ抽出
│   └── backup.ts                    ZIP I/O
├── stores/
│   ├── projectStore.ts              Pinia プロジェクトストア (+ history)
│   ├── history.ts                   Undo/Redo スタック
│   └── backupSignature.ts           バックアップ差分検知 (内容ハッシュ)
├── engine/
│   ├── previewEngine.ts             Canvas 合成・再生 (WebAudio EQ 含む)
│   ├── exportEngine.ts              MP4/WebM/GIF エクスポート (WebCodecs)
│   ├── keyframes.ts                 キーフレーム補間
│   ├── transitions.ts               トランジション計算
│   ├── effectPresets.ts             エフェクトプリセット定義
│   ├── pixelEffects.ts              ピクセルエフェクト (ImageData 処理)
│   ├── waveform.ts                  音声波形生成
│   └── capabilities.ts              ブラウザ機能検出
├── composables/
│   ├── useSelection.ts              マルチ選択
│   ├── useClipboard.ts              コピー/ペースト
│   ├── useKeyboard.ts               グローバルショートカット
│   ├── useLocale.ts                 やさしい日本語モード切替
│   ├── useLayout.ts                 パネルレイアウト調整
│   ├── useStorage.ts                ストレージ永続化・残量管理
│   ├── useTutorial.ts               チュートリアルツアー
│   └── useToast.ts                  トースト通知
├── styles/global.css
└── components/
    ├── TopBar.vue
    ├── MediaLibrary.vue
    ├── PreviewPanel.vue
    ├── TimelinePanel.vue
    ├── InspectorPanel.vue
    ├── AudioMixer.vue
    ├── EffectSlider.vue
    ├── ExportDialog.vue
    ├── RecorderDialog.vue
    ├── BackupReminderDialog.vue
    ├── ShortcutHelp.vue
    ├── TutorialOverlay.vue
    └── Toast.vue
```

## バックアップZIPの中身

```
<projectname>__YYYY-MM-DD-HH-MM-SS.lvebackup.zip
├── manifest.json          フォーマット識別
├── project.json           プロジェクト全状態 (シリアライズ可能)
└── assets/
    └── <assetId>.<ext>    素材ファイル本体 (元のバイト列)
```

## 技術スタック

- Vue 3 (Composition API, `<script setup>`)
- Pinia (setup store)
- Vite + TypeScript
- IndexedDB (`idb` ラッパー)
- fflate (ZIP 入出力)
- mp4-muxer / webm-muxer / gifenc (エクスポート)
- WebCodecs (エクスポート)
- nanoid (ID 生成)

## 設計メモ

- **素材 (Asset) とクリップ (Clip) は分離**
- **時刻は秒単位の number で統一**
- **ProjectState は常に JSON シリアライズ可能** (Blob / ObjectURL は store に入れない)
- **Canvas 合成は 2D Context** (将来 WebGL/WebGPU に差し替え可能)
- **デコードはブラウザ標準 `<video>`/`<audio>`** (エクスポート時のみ WebCodecs)
- **履歴はスナップショットベース** (JSON シリアライズ)。mergeKey で高頻度変更をまとめる
- **永続化はしない**: 自動保存・自動復元は廃止し、手動バックアップ ZIP に一本化。起動時に前セッションの IndexedDB 残骸を掃除する
- 詳細は [docs/CHANGELOG.md](docs/CHANGELOG.md) を参照
