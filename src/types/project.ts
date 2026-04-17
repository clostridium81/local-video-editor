// ============================================================
// プロジェクト状態モデル
// ============================================================
// 設計方針:
// - すべての時刻は「秒」単位の number で統一 (ms/frameの変換は上位で)
// - ID は nanoid で発行される不変の文字列
// - 素材(Asset) と クリップ(Clip) を分離:
//     Asset = IndexedDBに保存されるファイル本体 (動画/画像/音声)
//     Clip  = タイムライン上に配置された "素材の参照" (使い回し可能)
// - プロジェクト全体を JSON シリアライズ可能に保つ
//   → バックアップZIPにそのまま書き出せる
// ============================================================

export type AssetKind = 'video' | 'image' | 'audio'

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  mimeType: string
  size: number // bytes
  // メディア固有メタデータ (検出できたもの)
  duration?: number // 秒, video/audio のみ
  width?: number
  height?: number
  // 追加時のタイムスタンプ
  createdAt: number
}

// ---------- キーフレーム ----------

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

export interface Keyframe {
  // クリップ開始からのローカル秒。クリップを移動/トリムしても
  // 内容に追従させるため、絶対時刻ではなくローカル時刻で保持する。
  time: number
  value: number
  easing: Easing
}

export type KeyframeableProperty =
  | 'x'
  | 'y'
  | 'scale'
  | 'rotation'
  | 'opacity'
  | 'volume'

export type Keyframes = Partial<Record<KeyframeableProperty, Keyframe[]>>

// ---------- トランジション ----------

export type TransitionType =
  | 'fade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'zoom'
  | 'wipe'

export interface Transition {
  type: TransitionType
  duration: number // 秒
}

// ---------- エフェクト ----------

export interface ClipEffects {
  brightness?: number // 1.0 = 通常
  contrast?: number // 1.0 = 通常
  saturation?: number // 1.0 = 通常
  blur?: number // px (0 = なし)
  hueRotate?: number // 度
  grayscale?: number // 0..1
  invert?: number // 0..1
  sepia?: number // 0..1
}

// ---------- クリップ種別 ----------

export type ClipKind = 'video' | 'image' | 'audio' | 'text'

export interface BaseClip {
  id: string
  kind: ClipKind
  trackId: string
  // タイムライン上の位置 (秒)
  start: number
  duration: number
  // 素材内のオフセット (動画/音声クリップ用, 秒)
  // 例: 10秒の動画素材の 3〜7秒だけ使いたい場合 sourceIn=3, duration=4
  sourceIn?: number
  // 透明度・表示状態
  opacity: number // 0..1
  muted?: boolean
  volume?: number // 0..1
  // キーフレーム (任意)
  keyframes?: Keyframes
  // トランジション (任意)
  transitionIn?: Transition
  transitionOut?: Transition
}

export interface VideoClip extends BaseClip {
  kind: 'video'
  assetId: string
  // 画面内配置 (0..1 の正規化座標, 中心基準)
  x: number
  y: number
  scale: number // 1 = 等倍
  rotation: number // degrees
  effects?: ClipEffects
}

export interface ImageClip extends BaseClip {
  kind: 'image'
  assetId: string
  x: number
  y: number
  scale: number
  rotation: number
  effects?: ClipEffects
}

export interface AudioClip extends BaseClip {
  kind: 'audio'
  assetId: string
}

export interface TextClip extends BaseClip {
  kind: 'text'
  text: string
  fontFamily: string
  fontSize: number // px (1080pキャンバス基準)
  color: string
  backgroundColor?: string
  x: number
  y: number
  align: 'left' | 'center' | 'right'
  bold: boolean
  italic: boolean
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip

// ---------- トラック ----------

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
  // 表示順 (小さいほど下、=画面の奥)
  order: number
}

// ---------- プロジェクト ----------

export interface ProjectMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  // 出力解像度・フレームレート
  width: number
  height: number
  fps: number
  // 背景色
  backgroundColor: string
}

export interface ProjectState {
  meta: ProjectMeta
  assets: Record<string, Asset>
  tracks: Track[]
  clips: Clip[]
  // UI状態 (復元可)
  timeline: {
    playhead: number // 現在の再生位置 (秒)
    zoom: number // px per second
    duration: number // プロジェクト全長 (秒)
  }
}

// ---------- バックアップ形式 ----------
// バックアップZIPの構造:
//   project.json            ... ProjectState (assetsのBlobは含まない)
//   manifest.json           ... バージョンなどメタ情報
//   assets/<assetId>.<ext>  ... 素材ファイル本体
//
// project.json 内の Asset には Blob への直接参照はない。
// 復元時は assets/ ディレクトリのファイルを読み込み直す。

export interface BackupManifest {
  format: 'local-video-editor-backup'
  version: 1
  createdAt: number
  projectId: string
  projectName: string
}
