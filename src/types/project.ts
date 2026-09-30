// ============================================================
// プロジェクト状態モデル
// ============================================================
// 設計方針:
// - すべての時刻は「秒」単位の number で統一 (ms/frameの変換は上位で)
// - ID は nanoid で発行される不変の文字列
// - 素材(Asset) と クリップ(Clip) を分離:
//     Asset = セッション内の File/Blob を参照するメタデータ (動画/画像/音声)
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
  tags?: string[]
}

// ---------- キーフレーム ----------

export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  // v0.9 追加
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'back' // 少し行き過ぎて戻る
  | 'spring' // バネ (揺れながら収まる)
  | 'bounce' // 弾む
  | 'elastic' // ゴムのように伸び縮み
  | 'hold' // 補間しない (次のキーフレームで切り替わる)
  | 'bezier' // bezier に 3 次ベジェの制御点 (CSS の cubic-bezier と同じ)

export interface Keyframe {
  // クリップ開始からのローカル秒。クリップを移動/トリムしても
  // 内容に追従させるため、絶対時刻ではなくローカル時刻で保持する。
  time: number
  value: number
  // 前のキーフレームからこのキーフレームへの補間の緩急
  easing: Easing
  /** easing = 'bezier' のときの制御点 [x1, y1, x2, y2] */
  bezier?: [number, number, number, number]
}

/**
 * キーフレームで動かせる項目。基本の 6 項目に加えて、クリップ内の数値を
 * ドット区切りのパスで指定できる (例: 'effects.brightness', 'mask.x',
 * 'crop.left', 'fontSize', 'decor.outline.width')。
 * 使えるパスは engine/animatable.ts の ANIMATABLE に定義する。
 */
export type KeyframeableProperty =
  | 'x'
  | 'y'
  | 'scale'
  | 'rotation'
  | 'opacity'
  | 'volume'
  | (string & {})

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
  // v0.6 追加
  | 'wipe-rtl' // 右から拭う
  | 'wipe-up' // 下から拭う
  | 'wipe-down' // 上から拭う
  | 'split' // 中央から左右に開く
  | 'iris' // 中央から円形に開く
  | 'zoom-out' // 大きい状態から定位置へ
  | 'spin' // 回転しながら
  | 'blur' // ぼかしから
  | 'flash' // 白く飛んだ状態から
  // v0.7 追加
  | 'wipe-diag' // 左上から斜めに拭う
  | 'split-v' // 中央から上下に開く
  | 'clock' // 時計の針のように回って開く
  | 'diamond' // 中央からひし形に開く
  | 'heart' // 中央からハート形に開く
  | 'blinds' // ブラインド (横じま)
  | 'checker' // 市松模様
  | 'flip-x' // 横に裏返る
  | 'flip-y' // 縦に裏返る
  | 'bounce' // 弾んで出る
  | 'shake' // 揺れて止まる
  | 'glitch' // ノイズ風に乱れる
  | 'pixelate' // モザイクから
  | 'zoom-blur' // 拡大しつつぼかしから

export interface Transition {
  type: TransitionType
  duration: number // 秒
  /**
   * 入り (transitionIn) 専用: true なら開始位置より前 (前のクリップの末尾) に
   * duration 秒重ねて始め、開始位置で完了する (クロストランジション)。
   * タイムライン上の位置・長さは変わらない。素材の手前が足りない分は先頭の画で止める。
   */
  overlap?: boolean
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

// ---------- クロップ (切り抜き) ----------
// 素材の各辺から切り落とす割合 (0..1)。left + right / top + bottom は 1 未満。
// 表示サイズは切り抜き後の縦横比でキャンバスに contain フィットする。

export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

// ---------- マスク ----------
// クリップの表示領域 (切り抜き・拡大後の矩形) を基準にした正規化座標。
// x / y は中心 (0..1)、width / height は矩形に対する割合。
// linear は中心を通る直線で片側を残す (rotation で向きを変える)。

export type MaskShape = 'rect' | 'ellipse' | 'linear'

export interface Mask {
  shape: MaskShape
  x: number
  y: number
  width: number
  height: number
  rotation: number // 度
  feather: number // 0..1 (境界のぼかし、クリップ短辺に対する割合)
  invert: boolean
}

// ---------- 音声フェード ----------
// 映像のトランジションとは独立した音量のフェード (秒)

export interface AudioFade {
  in: number
  out: number
}

// ---------- 背景ぼかし塗り ----------
// 素材が画面を覆いきらない (例: 16:9 を縦長画面に置く) とき、余白を同じ素材の
// 拡大・ぼかし版で埋める。クリップの位置・大きさ・回転は背景には影響しない。

export interface BgFill {
  blur: number // ぼかしの強さ (px, 1080p 基準)
  dim: number // 暗くする量 0..1 (0=そのまま)
}

// ---------- 速度カーブ ----------
// クリップ内の位置 x (0=先頭, 1=末尾) ごとの再生速度。点の間は直線でつなぐ。
// 設定されている間は clip.speed より優先する。

export interface SpeedPoint {
  x: number // 0..1
  speed: number // 0.1..10
}

// ---------- ダッキング ----------
// 他の音 (話し声・動画の音など) が鳴っている間、このクリップの音量を自動で下げる

export interface Ducking {
  amount: number // 下げる量 0..1 (0.7 = 30% まで下げる)
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

// ---------- 単語ハイライト字幕 (カラオケ風) ----------
// 文章を単語 (日本語は形態素に近い単位) に分け、文字数に比例した時間で
// 順に強調する。lead 秒後に始まり、クリップ終わりの tail 秒前に終わる。

export type KaraokeMode =
  | 'color' // 読んだ所の色を変える
  | 'fill' // 左から色が塗られていく
  | 'pop' // 今の単語を色付き・少し大きく (TikTok 風)
  | 'box' // 今の単語の後ろに色の箱
  | 'reveal' // 読んだ所まで表示していく

export interface Karaoke {
  mode: KaraokeMode
  color: string // 強調色
  boxColor?: string // box モードの箱の色 (未指定は color)
  lead: number // 開始までの秒
  tail: number // 終わりを何秒手前にするか
}

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
  // ブレンドモード (映像のみ有効)
  blendMode?: BlendMode
  // 音量フェード (video / audio クリップのみ有効)
  audioFade?: AudioFade
  // 速度カーブ (video / audio クリップのみ有効)
  speedCurve?: SpeedPoint[]
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
  crop?: Crop
  mask?: Mask
  bgFill?: BgFill
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
  crop?: Crop
  mask?: Mask
  bgFill?: BgFill
}

export interface AudioClip extends BaseClip {
  kind: 'audio'
  assetId: string
  eq?: AudioEQ
  ducking?: Ducking
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
  karaoke?: Karaoke
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
  /** 保存時に読めずに含められなかった素材 ID (元ファイルの移動・変更など) */
  missingAssets?: string[]
}
