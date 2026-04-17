Local Video Editor - 引き継ぎ作業書（Phase 2以降）
:clapper: Local Video Editor 引き継ぎ作業書

このキャンバスは、ブラウザ完結型動画編集アプリ local-video-editor の Phase 1 MVP 完成後、Claude Code で継続開発するための引き継ぎ書です。

:dart: プロジェクトのゴール

無料・年齢制限なしで、Google Vids 相当の機能を持つ動画編集アプリ。完全ブラウザローカルで動作し、サーバーに素材が送信されない。

* 初回ロード後はオフラインで完動
* 素材・編集状態は IndexedDB に保存
* バックアップは素材ごとまとめた ZIP をローカル PC にダウンロード
* 同 ZIP を再ロードすると完全復元

:package: Phase 1 の現状（完成済み）

* Vite + Vue 3 + TypeScript + Pinia + IndexedDB (idb) + fflate
* 素材アップロード、タイムライン配置、Canvas 合成プレビュー、再生/停止、テキストクリップ、配置/不透明度/音量 編集、バックアップ ZIP の保存と復元
* npm install && npm run dev で http://localhost:5173 起動
* vue-tsc --noEmit および vite build は通る状態でリリース

:brain: アーキテクチャの要点（Claude Code が最初に読むべきこと）

設計判断は次のとおり。これを変えずに拡張することを強く推奨。

* Asset（素材）と Clip（配置）は分離。IndexedDB に Asset を 1 つ、タイムラインに同じ Asset を参照する Clip を複数置ける。
* **時刻はすべて秒単位の number**。フレーム変換は上位層でのみ行う。
* ProjectState は常に JSON シリアライズ可能。Blob / ObjectURL は絶対にストアに混入させない。これがバックアップ ZIP の核心。
* Canvas 合成は 2D Contextで開始、PreviewEngine クラスに抽象化済。将来 WebGL/WebGPU に差し替え可能。
* **動画・音声デコードはブラウザ標準 <video> / <audio>**。FFmpeg.wasm には依存しない。将来のエクスポートでのみ WebCodecs を導入する。
* Pinia setup store の戻り値はテンプレート・スクリプトとも store.xxx でアクセス（自動 unwrap）。store.xxx.value と書かない。

:file_folder: ファイル構成（再掲）

* src/types/project.ts 状態モデル
* src/persistence/assetStore.ts IndexedDB の Blob 保存
* src/persistence/mediaMeta.ts メタデータ抽出
* src/persistence/backup.ts バックアップ ZIP の入出力
* src/stores/projectStore.ts Pinia プロジェクトストア
* src/engine/previewEngine.ts Canvas 合成・再生エンジン
* src/composables/useSelection.ts 選択状態
* src/components/ TopBar / MediaLibrary / PreviewPanel / TimelinePanel / InspectorPanel

:rocket: Phase 2 タスク（優先順）

編集体験の完成度を最優先。次にエクスポートの土台作り。

A. 編集体験の完成（最優先）

* アンドゥ / リドゥ: projectStore の状態変更を一元化してスタックに積む。Ctrl+Z / Ctrl+Shift+Z。素材の追加/削除は履歴から除外するかオプションに。
* クリップの分割: playhead 位置で選択クリップを 2 つに分ける。動画/音声クリップは sourceIn と duration を適切に割り振る。キーボード S。
* クリップのコピー / 貼り付け: Ctrl+C / Ctrl+V。貼り付け先は playhead の位置、同じトラック優先。
* キーフレームアニメーション: 対象プロパティは x, y, scale, rotation, opacity, volume。型としては Keyframe = { time: number; value: number; easing: 'linear'|'easeIn'|'easeOut'|'easeInOut' } を Clip に持たせる。プレビューエンジンで時刻に応じて補間。
* プレビュー上での直接ドラッグ: Canvas 上でクリップをドラッグして x, y を更新。ハンドルで scale, rotation も。

B. 堅牢性・UX

* IndexedDB への自動保存: プロジェクト状態の変更を debounce して IndexedDB に常時書き戻し。ブラウザを閉じても戻れば即再開。
* 起動時の復元フロー: 起動時に IndexedDB から最新プロジェクトを読む。無ければ空プロジェクト。
* 音声波形の表示: Web Audio API で decodeAudioData、ピーク値配列を作成、OffscreenCanvas に描画してタイムライン上のオーディオクリップに敷く。
* エラーハンドリング: 復元失敗、素材読み込み失敗、ブラウザ非対応コーデック時のユーザー通知。
* 警告: ブラウザが WebCodecs 非対応の場合、エクスポート機能を無効化しその旨表示。

C. 表現力

* トランジション: クロスディゾルブ、フェードイン/アウトを Clip の追加メタで。プレビューで時刻に応じてアルファ合成。
* エフェクト / フィルター: 明度・彩度・ブラー。Canvas filter プロパティまたは WebGL シェーダ。

D. エクスポート（最終フェーズ）

最後にまとめて実装する。

* MP4 エクスポート: WebCodecs VideoEncoder (avc) + mp4-muxer。音声は AudioEncoder (aac)。再生エンジンを再利用してフレーム単位で描画 → VideoFrame に変換 → エンコード。
* WebM エクスポート: VideoEncoder (vp9) + webm-muxer。フォールバック用途。
* 進捗 UI とキャンセル: エンコード中の進捗バー、キャンセル、完了時の自動ダウンロード。

:warning: 既知の注意点と落とし穴

* テンプレート内で store.xxx.value と書かない。store.meta で中身に触れる。Phase 1 で全体修正済。
* vue-tsc は TypeScript 5.3 との互換性注意。vue-tsc@latest に揃える。package.json は更新済。
* crossOrigin='anonymous': <video> 要素に設定しているが、Blob URL は同一オリジン扱いなので不要。ただしエクスポートで Canvas を tainted にしない保険として残置。
* IndexedDB の容量: ブラウザごとに違う。大きな動画で quota exceeded の可能性。エラーハンドリングを丁寧に。
* requestAnimationFrame 駆動の再生: タブが非アクティブだと止まる。長時間録音等には不向き。エクスポートは完全に別経路。
* 音声と映像の同期: <video> / <audio> の currentTime シークはコーデック依存で不正確。0.2 秒 のしきい値で許容しているが、エクスポート時は精密化が必要。

:speech_balloon: Claude Code への初回プロンプト例

次の内容をコピペして Claude Code に投げるのが想定されるスタート。

このリポジトリは `local-video-editor`。
Phase 1 の MVP は完成済み。これから Phase 2 に入る。
最初に README.md と本キャンバスの「アーキテクチャの要点」を読んでから、
Phase 2 の A-1「アンドゥ / リドゥ」から着手してほしい。

実装方針:
- projectStore の mutation を一元化するラッパを作り、各変更前に現在状態のスナップショットを history スタックに push
- 履歴スタック上限は 100 程度、超えたら古いものから捨てる
- 素材の追加/削除は IndexedDB への副作用があるので履歴から除外（または特殊扱い）
- Ctrl+Z / Ctrl+Shift+Z のキーバインドをグローバルに追加、INPUT/TEXTAREA 上では無効化

実装が終わったら型チェックとビルドが通ることを確認し、
`docs/CHANGELOG.md` に追記し、次のタスク（クリップ分割）に進んでほしい。

:white_check_mark: 進捗チェックリスト

* Phase 2-A アンドゥ / リドゥ
* Phase 2-A クリップ分割
* Phase 2-A コピー / 貼り付け
* Phase 2-A キーフレーム
* Phase 2-A プレビュー上ドラッグ
* Phase 2-B 自動保存
* Phase 2-B 起動時復元
* Phase 2-B 音声波形
* Phase 2-B エラーハンドリング
* Phase 2-C トランジション
* Phase 2-C エフェクト
* Phase 2-D MP4 エクスポート
* Phase 2-D WebM エクスポート
* Phase 2-D 進捗 UI

