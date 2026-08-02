// ============================================================
// mediabunny の使用シンボルだけを静的に re-export するローダー。
// frameSource.ts はこのモジュールを動的 import することで、
// (1) メインバンドルから mediabunny を分離しつつ
// (2) 名前付き import によるツリーシェイクを効かせる。
// (`import('mediabunny')` 直接だと全モジュールがチャンクに入る)
// ============================================================

export { Input, BlobSource, VideoSampleSink, MP4, QTFF, WEBM, MATROSKA } from 'mediabunny'
