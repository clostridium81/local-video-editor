# Local Video Editor (ブラウザローカル動画編集アプリ)

**完全にブラウザ内で動作する動画編集アプリケーション**。
初回アクセス後はサーバー通信なし。素材ファイルは IndexedDB にのみ保存され、外部に送信されません。

## 機能一覧 (Phase 2 完成)

### 編集

- 素材ファイル (動画 / 画像 / 音声) のドラッグ&ドロップ・ファイル選択アップロード
- タイムラインへの配置 (ドラッグ or ダブルクリック)
- マルチトラック (映像/音声)、トラック追加・ミュート
- クリップの移動・左右トリム (ドラッグ)
- **マルチ選択** (Shift/Cmd クリック, ラバーバンド)
- **クリップ分割** (`S` キーで playhead 位置)
- **コピー / カット / 貼り付け / 複製** (`Cmd/Ctrl+C/X/V/D`)
- **Undo / Redo** (`Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y`)
- **キーフレーム** (x / y / scale / rotation / opacity / volume, easing 4 種)
- **プレビュー直接ドラッグ** (move / scale / rotate ハンドル)
- テキストクリップ (フォント、サイズ、色、背景、太字/斜体、配置)
- **エフェクト / フィルター** (明るさ、コントラスト、彩度、ブラー、色相、グレースケール、反転、セピア)
- **トランジション** (fade / slide × 4 / zoom / wipe, 入/出)
- 音声波形表示
- 再生 / 停止 (Space)、playhead 微調整 (Arrow)

### 保存

- **バックアップZIP** でのプロジェクト全体エクスポート / インポート
- **自動保存** (IndexedDB、ページ再訪時に自動復元)

### エクスポート

- **MP4** (H.264 + AAC) / **WebM** (VP9 + Opus)
- 解像度 / FPS / ビットレートの選択
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

`dist/` に出力。初回ロード後はオフラインで動作。

## キーボードショートカット

| キー | 動作 |
|------|------|
| Space | 再生 / 停止 |
| S | 選択中 (or playhead 下) クリップを分割 |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y | Redo |
| Cmd/Ctrl+C | 選択クリップをコピー |
| Cmd/Ctrl+X | 選択クリップをカット |
| Cmd/Ctrl+V | 貼り付け |
| Cmd/Ctrl+D | 選択クリップを複製 |
| Cmd/Ctrl+A | 全クリップ選択 |
| Delete / Backspace | 選択クリップを削除 |
| ← / → | playhead を 1 フレームずつ移動 |
| Shift + ← / → | playhead を 1 秒ずつ移動 |
| Home / End | 先頭 / 末尾へ |

## ディレクトリ構成

```
src/
├── main.ts                          エントリ (bootstrap + autosave)
├── App.vue
├── types/project.ts                 状態モデル型
├── persistence/
│   ├── assetStore.ts                IndexedDB (assets + projects)
│   ├── mediaMeta.ts                 メタデータ抽出
│   └── backup.ts                    ZIP I/O
├── stores/
│   ├── projectStore.ts              Pinia プロジェクトストア (+ history + autosave)
│   └── history.ts                   Undo/Redo スタック
├── engine/
│   ├── previewEngine.ts             Canvas 合成・再生
│   ├── exportEngine.ts              MP4/WebM エクスポート (WebCodecs)
│   ├── keyframes.ts                 キーフレーム補間
│   ├── transitions.ts               トランジション計算
│   ├── waveform.ts                  音声波形生成
│   └── capabilities.ts              ブラウザ機能検出
├── composables/
│   ├── useSelection.ts              マルチ選択
│   ├── useClipboard.ts              コピー/ペースト
│   ├── useKeyboard.ts               グローバルショートカット
│   └── useToast.ts                  トースト通知
├── styles/global.css
└── components/
    ├── TopBar.vue
    ├── MediaLibrary.vue
    ├── PreviewPanel.vue
    ├── TimelinePanel.vue
    ├── InspectorPanel.vue
    ├── EffectSlider.vue
    ├── ExportDialog.vue
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
- mp4-muxer / webm-muxer (エクスポート)
- WebCodecs (エクスポート)
- nanoid (ID 生成)

## 設計メモ

- **素材 (Asset) とクリップ (Clip) は分離**
- **時刻は秒単位の number で統一**
- **ProjectState は常に JSON シリアライズ可能** (Blob / ObjectURL は store に入れない)
- **Canvas 合成は 2D Context** (将来 WebGL/WebGPU に差し替え可能)
- **デコードはブラウザ標準 `<video>`/`<audio>`** (エクスポート時のみ WebCodecs)
- **履歴はスナップショットベース** (JSON シリアライズ)。mergeKey で高頻度変更をまとめる
- 詳細は [docs/CHANGELOG.md](docs/CHANGELOG.md) を参照
