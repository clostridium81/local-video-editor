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
  folderId?: string | null
  tags?: string[]
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

// ---------- カラーグレーディング (カスタムピクセル処理) ----------

export interface ColorGrade {
  // 各成分 -1..1 程度 (0=通常)
  lift?: { r: number; g: number; b: number }
  gamma?: { r: number; g: number; b: number }
  gain?: { r: number; g: number; b: number }
  temperature?: number // -1..1 (負=寒色、正=暖色)
  tint?: number // -1..1 (負=緑寄り、正=マゼンタ寄り)
}

// ---------- ピクセルエフェクト (Canvas ImageData 処理) ----------
// ClipEffects (CSS filter) では表現できない、画素単位の特殊効果。
// preview/export で同一の applyPixelEffects() を共有する。

export interface Duotone {
  enabled: boolean
  shadow: string // 暗部の色 #rrggbb
  highlight: string // 明部の色 #rrggbb
}

export interface PixelEffects {
  vignette?: number // 0..1 周辺減光
  sharpen?: number // 0..1 シャープ
  grain?: number // 0..1 フィルムグレイン
  pixelate?: number // 0=なし, ブロックサイズ (px)
  posterize?: number // 0=なし, 2..16 階調数
  scanlines?: number // 0..1 走査線
  chromaticAberration?: number // 0=なし, シフト量 (px)
  threshold?: number // 0=なし, 0..1 二値化しきい値
  vibrance?: number // -1..1 自然な彩度
  duotone?: Duotone
}

// ---------- クロマキー ----------

export interface ChromaKey {
  enabled: boolean
  color: string // #rrggbb
  threshold: number // 0..1 (色距離の許容範囲)
  softness: number // 0..1 (エッジの柔らかさ)
  spillSuppress: number // 0..1 (被写体にのっかった色の除去)
}

// ---------- ブレンドモード ----------

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'add'
  | 'subtract'

// ---------- テキストアニメーション ----------

export type TextAnimType =
  | 'none'
  | 'typewriter'
  | 'fade-words'
  | 'slide-chars'
  | 'bounce'
  | 'scale-pop'
  | 'wave'

export interface TextAnim {
  type: TextAnimType
  duration: number // アニメ全体の長さ (秒、0 ならクリップ長に一致)
}

// ---------- テキスト装飾 ----------

export interface TextDecor {
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number }
  outline?: { color: string; width: number }
  letterSpacing?: number // px
  lineHeight?: number // 倍率
}

// ---------- 図形 ----------

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'star' | 'triangle' | 'arrow'

export interface ShapeStyle {
  fill?: string
  stroke?: string
  strokeWidth?: number
  cornerRadius?: number // rect 専用
}

// ---------- 音声エフェクト ----------

export interface AudioEQ {
  low?: number // dB (-24..+24)
  mid?: number
  high?: number
}

// ---------- クリップ種別 ----------

export type ClipKind = 'video' | 'image' | 'audio' | 'text' | 'shape'

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
  // 再生速度 (1.0 = 等速、2.0 = 2倍速、0.5 = スロー)
  speed?: number
  // 逆再生 (video/audio)
  reversed?: boolean
  // ブレンドモード (映像のみ有効)
  blendMode?: BlendMode
  // 他のクリップと連動 (例: 動画 + その音声)
  linkGroup?: string
}

export type ClipKind2 = ClipKind | 'shape'

export interface VideoClip extends BaseClip {
  kind: 'video'
  assetId: string
  // 画面内配置 (0..1 の正規化座標, 中心基準)
  x: number
  y: number
  scale: number // 1 = 等倍
  rotation: number // degrees
  effects?: ClipEffects
  colorGrade?: ColorGrade
  chromaKey?: ChromaKey
  pixelFx?: PixelEffects
  eq?: AudioEQ
}

export interface ImageClip extends BaseClip {
  kind: 'image'
  assetId: string
  x: number
  y: number
  scale: number
  rotation: number
  effects?: ClipEffects
  colorGrade?: ColorGrade
  chromaKey?: ChromaKey
  pixelFx?: PixelEffects
}

export interface AudioClip extends BaseClip {
  kind: 'audio'
  assetId: string
  eq?: AudioEQ
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
  decor?: TextDecor
  anim?: TextAnim
}

export interface ShapeClip extends BaseClip {
  kind: 'shape'
  shape: ShapeKind
  // 位置 (0..1, キャンバス基準、中心)
  x: number
  y: number
  // サイズ (0..1, キャンバス「短辺」基準)
  // 例: width=0.3, height=0.3 なら、1920x1080 でも 1080x1080 でも正方形
  width: number
  height: number
  rotation: number
  // 追加の一様スケール (キーフレームや canvas ドラッグ用)
  scale?: number
  style: ShapeStyle
  effects?: ClipEffects
}

export type Clip = VideoClip | ImageClip | AudioClip | TextClip | ShapeClip

// ---------- トラック ----------

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
  solo?: boolean
  volume?: number // 0..2 (audio track のみ)
  // 表示順 (小さいほど下、=画面の奥)
  order: number
}

// ---------- マーカー ----------

export interface Marker {
  id: string
  time: number // 秒
  label: string
  color?: string
}

// ---------- アセットフォルダ ----------

export interface AssetFolder {
  id: string
  name: string
  color?: string
  parentId?: string | null
}

// ---------- アセットタグ追加 ----------
// Asset 型は破壊変更せず、メタ情報のみ拡張

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
  folders?: AssetFolder[]
  tracks: Track[]
  clips: Clip[]
  markers?: Marker[]
  // UI状態 (復元可)
  timeline: {
    playhead: number // 現在の再生位置 (秒)
    zoom: number // px per second
    duration: number // プロジェクト全長 (秒)
    inPoint?: number // 範囲再生/エクスポートの開始
    outPoint?: number
    snapping?: boolean
    rippleMode?: boolean
    masterVolume?: number // 0..2
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
