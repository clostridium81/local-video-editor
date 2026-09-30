# Changelog

## [Unreleased] — 縦長キャンバス / クロップ / マスク / 字幕 SRT / フリーズフレーム / トランジション追加

### キーフレームの強化 / 単語ハイライト字幕 (2026-10-01)

**キーフレーム**
- 基本 6 項目 (位置・大きさ・回転・不透明度・音量) に加え、エフェクト 8 種・クロップ・マスク・背景ぼかし・色温度/ティント・ビネット/グレイン/モザイク/色収差・文字サイズ/字間/縁取り幅・図形の幅/高さ/線幅/角丸をキーフレームで動かせる ([animatable.ts](../src/engine/animatable.ts))。描画直前にその時刻の値を埋め込むので、プレビューと書き出しで同じ
- 各スライダーに ◆ (再生位置のキーを付け外し)。キーのある項目を動かすと再生位置にキーが打たれる (プレビュー上のドラッグ・数値入力も同様。従来は基準値が変わるだけで画面が変わらなかった)
- 緩急を 13 種に拡充: 強めのイーズ、バック、スプリング、バウンス、エラスティック、ホールド、ベジェ (CSS の cubic-bezier 互換、グラフで制御点を編集、プリセット付き)
- 「キーフレーム (動き)」欄: 動かしている項目の一覧、前後のキーへの移動、全削除 (再生位置の値を基準値に残す)、再生位置のキーの緩急編集

**単語ハイライト字幕 (カラオケ風)**
- テキストを単語に区切り (日本語は Intl.Segmenter)、文字数に比例した時間で順に強調する ([karaoke.ts](../src/engine/karaoke.ts))。見せ方 5 種: ポップ (TikTok 風)・フィル (カラオケ)・カラー・ボックス・リビール。開始の遅れ / 終了の余白で発話に合わせる
- スタイル集に「TikTok 風」「カラオケ」「ハイライトボックス」を追加 (字幕トラック全体へ一括適用可)。単語ハイライトを持たないスタイルを当てても既存の設定は残す

### 安定性の監査と修正 (2026-09-26)

作業の消失・停止につながる経路を洗い出して修正した。

**バックアップ (唯一の保存手段)**
- ZIP を無圧縮・ZIP64 対応の独自実装に変更 ([zipStream.ts](../src/persistence/zipStream.ts))。素材は元の File を参照したまま組み立て、メモリにコピーしない (従来は素材合計の 3〜4 倍のメモリを使い、大きな作品で保存時にタブが落ちうる / 4GB 超で壊れた ZIP を「成功」として書いていた)
- 移動・変更・削除されて読めない素材があっても、保存全体を失敗させずにその素材だけ除いて保存し、通知する。この場合は「バックアップ済み」にしない
- 復元は 1 素材ずつ取り出す (ZIP 全体をメモリに載せない)。旧版の不具合で素材が欠けた/参照が切れたバックアップも、該当クリップだけ外して復元する (従来は全体が開けなかった)。旧形式 (deflate) の ZIP も読める
- File System Access API が使えるブラウザでは保存先を選ばせ、書き込み完了を確認してから「バックアップ済み」にする。保存先の選択をやめた場合は未保存のまま (従来はダウンロードの成否に関係なく保存済み扱いで、閉じる時の警告が出なかった)

**書き出し**
- 音声処理中のキャンセルが無視され、音声の無いファイルが「完成」として保存されていたのを修正。音声の合成失敗も黙って無音にせず失敗として知らせる。読めなかった素材は警告
- 出力を順次 Blob に確定するよう変更 ([positionedBlob.ts](../src/engine/positionedBlob.ts))。出力全体を複数回コピーしてメモリに持たない (MP4 は moov が末尾になる)。ビットレート手入力の上限 100Mbps
- エンコーダの待ち・flush がキャンセル/エラー/時間切れで抜けられるようにした (固まると閉じられず再読み込みしかなかった)
- 選んだ形式・サイズ・fps・音声がエンコード可能かを開始前に確認し、分かるメッセージで止める。非整数 fps でも MP4 を作れる
- ミュート・ソロ対象外・範囲外のクリップの音声はデコードしない

**プレビュー / 編集**
- 効果用の中間バッファを素材解像度と 1 辺 4096px で頭打ちにした (拡大したマスク・カラーグレード付きクリップで数百 MB/フレームを確保しタブが落ちうる)
- 波形表示・ダッキング解析のデコードを 8kHz・1 件ずつに変更し、1GB 超の素材は解析しない (ダッキングのきっかけにできない場合は通知)
- クリップごとのメディア要素を、使っていないものから解放する (上限 12)。細かく分割した長い素材で読み込み失敗になるのを防ぐ
- In 点 ≥ Out 点のとき再生が止まって見える問題を修正
- 速度カーブ付きクリップのトリムでカーブを伸縮させず切り取る (残り部分の再生位置がずれていた)
- 描画中の例外で以降の全フレームが崩れないよう save/restore を保証、音量・EQ の非有限値を防御
- フリーズフレームの画の取り込み・素材のメタデータ取得にタイムアウト、字幕読み込み中の作品切り替えを防御、SRT 書き出しで本文の空行を詰める

### 背景ぼかし / 速度カーブ / ダッキング / テキストスタイル / favicon (2026-09-25)

- **背景ぼかし塗り** (`bgFill`): 素材が画面を覆わないとき、余白を同じ素材の拡大・ぼかし版で埋める。1/8 に縮小した cover 画像をぼかしながら拡大して敷き、ぼかし幅の 2 倍はみ出して描いて端が透けないようにする。画面を覆っているときは描画を省く。全動画・画像への一括適用あり
- **速度カーブ** (`speedCurve`): クリップ内の位置ごとの速度 (0.1〜10x) を折れ線で指定。素材時刻は速度の積分 (`sourceAdvance`) で求め、プレビューの playbackRate・書き出しの映像フレーム・音声の playbackRate 自動化がすべて同じ計算に従う。分割・左トリム・右トリムの上限もカーブを考慮。プリセット 8 種 (モンタージュ / ヒーロー / バレット / ジャンプカット など) とグラフ編集 (点のドラッグ・追加・削除)。素材が足りない場合の警告と「長さを素材に合わせる」
- **自動ダッキング** (`AudioClip.ducking`): 他の音 (動画の音声・ナレーション等) が鳴る間、BGM を指定量だけ下げる。素材の RMS から鳴り具合を求め、先読み 0.1 秒・アタック 0.08 秒・リリース 0.45 秒で平滑化。プレビューはデバウンスして非同期に計算、書き出しはデコード済み音声から同じ関数で計算
- **テキストのスタイル集** 13 種 (字幕 白/黄/帯、見出し、ネオン 2 色、ポップ、バラエティ、シネマ、タイプライター、レトロ、ラベル、ミニマル)。位置・内容は変えず、同じトラックのテキストすべてへの一括適用も可能
- **favicon**: `public/favicon.svg` (ロゴの半円 + 再生マーク) と PNG (32px / apple-touch-icon 180px)。Vite の base により GitHub Pages のサブパスでも参照される
- 修正: プレビューで読み込み待ちの古い描画が新しい描画を上書きし、スクラブ後に古い時刻の画が残ることがあった。描画に通し番号を付けて最新の要求だけが描き、古い描画はメディア要素のシークもしない。停止中のシークは `seeked` を待ってから描く

### トランジション拡充 (2026-09-25)

- **30 種**に拡充 (+14): 斜めワイプ、縦スプリット、クロックワイプ、ダイヤ、ハート、ブラインド、チェッカー、フリップ (横/縦)、バウンス、シェイク、グリッチ、ピクセレート、ズームブラー。メニューは「スライド / ワイプ / シェイプ / モーション / エフェクト」に分類
- **クロストランジション**: 入りのトランジションで「前のクリップと重ねる」を選ぶと、開始位置の手前から前のクリップの上に重ねて切り替える (`Transition.overlap`)。タイムライン上の位置・長さは変えず、素材の手前が足りない分は先頭の画で止める。前倒し区間は映像のみで音はクリップ開始から鳴らす。タイムラインでは重なり区間を斜線で表示
- 同じトラック内の描画順を「開始が遅いクリップが手前」に固定 (`compareDrawOrder`)
- **トラック全体に適用**: 選んだ入りトランジションを、同じトラックの隣接クリップのつなぎ目すべてにまとめて設定 (長さは前後のクリップに収まるよう短縮, 1 回の Undo で戻る)
- グリッチなど乱数を使うトランジションは決定的な疑似乱数で、プレビューと書き出しの見た目が一致する

### 描画の共通化

- プレビューと書き出しで二重に持っていたクリップ描画 (変形・エフェクト・テキスト・図形) を [renderer.ts](../src/engine/renderer.ts) に集約。以下の新機能はここ 1 か所で実装し、プレビューと書き出しの見た目を一致させる
- 修正: カラーグレード / クロマキー / ピクセルエフェクトを使うクリップで、明るさなどのエフェクト (CSS filter) が二重に掛かっていた
- 修正: 作品と異なる解像度 (720p など) で書き出すと、文字・線幅・角丸・影が画面に対して大きく/小さくなっていた。px 指定の値は短辺 1080px 基準で換算する (`pxUnit`)

### 画面の縦横比

- プレビュー下部から作品の画面サイズを切り替え: 16:9 / 9:16 (ショート動画) / 1:1 / 4:5 / 4:3 / 21:9。位置は正規化座標なので配置はそのまま追従する
- 書き出しの解像度プリセット (1080p / 720p / 480p) を「短辺のピクセル数」として作品の縦横比に合わせる
- H.264 の Level を解像度・fps から自動選択 (`avcCodecFor`)。21:9 (2560×1080) など Level 4.x を超えるサイズでも書き出せる

### クロップ / マスク

- 動画・画像クリップに**クロップ** (上下左右の切り落とし割合)。表示サイズは切り抜き後の縦横比で contain フィットし、プレビューの選択枠も追従
- **マスク**: 矩形 / 楕円 / 線形 (片側だけ残す)。位置・大きさ・回転・境界のぼかし・反転

### 音声フェード

- 動画・音声クリップに映像トランジションと独立した**音量フェードイン/アウト** (`audioFade`)。書き出しの音量エンベロープは キーフレーム × トランジションの fade × 音声フェード をプレビューと同じ関数で評価するよう一本化 (従来はキーフレームと fade を同時に使うと後勝ちで崩れていた)
- 音声クリップの「フェード (音量)」メニューは音声セクションへ移動。旧版で設定したフェードが残るクリップだけ従来の欄を表示する

### フリーズフレーム

- 動画クリップの再生位置の画を PNG 素材として切り出し、指定秒数の静止画クリップとして挿入 (以降のクリップは全トラックで後ろへずらす)。配置・エフェクト・クロップ・マスクを引き継ぎ、素材追加も含め 1 回の Undo で戻せる

### 字幕 (SRT / VTT)

- SRT / WebVTT を読み込むと「字幕」トラックにテキストクリップとして並べる (素材パネルの「字幕 → 読み込む」、または .srt / .vtt をドロップ)
- テキストクリップを SRT に書き出し
- テキストクリップの**複数行表示**に対応 (改行ごとに行を分けて中央揃え)

### トランジション

- 9 種追加: ワイプ (右→左 / 下→上 / 上→下)、スプリット、アイリス、ズーム (拡大から)、スピン、ブラー、フラッシュ

### その他

- Inspector の 2 列/3 列グリッドで入力欄が右へはみ出していたのを修正

---

## [0.5.x] — IndexedDB 廃止 / 素材の絞り込み / ルーラー固定 / 動画の音声だけ利用

### 素材保存方式 (2026-09-08)

- IndexedDB への素材読み書き、`idb` 依存、ストレージ永続化要求・残量表示を削除。File/Blob をタブ内で参照し、保存は手動 ZIP に統一。
- 起動時は旧 `local-video-editor` DB の削除だけを要求し、ブロック・失敗を通知。削除完了待ちで画面を止めない。
- 素材追加/削除を Undo/Redo に統合。履歴からも参照されない素材を解放し、新規作成/復元時は素材、URL、選択、クリップボード、描画キャッシュを切り替える。
- ZIP v1 互換を維持。欠損素材は失敗扱いにし、復元は整合性確認後に一括反映。読み込み中の作品切り替えによる素材混入を防止。
- セッション素材・ZIP の回帰テストを追加し、Pages ビルド前にも実行。検証範囲は `docs/session-storage-migration.md` を参照。

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
