import { ref } from 'vue'
import type { Asset } from '../types/project'
import { loadAssetBlob } from './assetStore'

// ============================================================
// 読み込んだフォント素材をブラウザ (document.fonts) に登録する
// ============================================================
// フォントの書体名は素材 ID から作る (ファイル名の重複や記号に影響されない)。
// テキストクリップは fontFamily に fontFamilyForAsset() の値を持つ。
// 作品の切り替え・素材の削除に合わせて登録を入れ替える (syncFonts)。
// ============================================================

/** 登録が済むたびに増える (プレビューの再描画のきっかけにする) */
export const fontsVersion = ref(0)

const registered = new Map<string, { key: string; face: any }>() // assetId → FontFace

/** テキストの fontFamily に入れる値 (CSS の font 指定にそのまま使える) */
export function fontFamilyForAsset(assetId: string): string {
  return `'lvefont-${assetId}'`
}

/** fontFamily がフォント素材を指していれば、その素材 ID */
export function assetIdFromFontFamily(family: string): string | null {
  const m = /^'lvefont-([\w-]+)'$/.exec(family)
  return m ? m[1] : null
}

export function fontDisplayName(asset: Asset): string {
  return asset.name.replace(/\.(ttf|otf|woff2?)$/i, '')
}

let chain: Promise<void> = Promise.resolve()
let generation = 0

/**
 * syncFontsNow を 1 つずつ順番に実行する。連続して呼ばれた (素材を続けて追加した・
 * 作品を切り替えた) ときに、並行実行で同じフォントを二重登録したり、古い作品の
 * フォントを後から登録したりしないようにする。古い呼び出しは最新の状態で実行し直す。
 */
export function syncFonts(projectId: string, assets: Record<string, Asset>): Promise<void> {
  const gen = ++generation
  const snapshot = { ...assets }
  chain = chain.then(() => (gen === generation ? syncFontsNow(projectId, snapshot) : undefined)).catch(e => {
    console.warn('フォントの登録に失敗しました', e)
  })
  return chain
}

/**
 * 現在の作品のフォント素材を登録し、不要になったものを外す。
 * 素材本体が同じ ID で差し替わった (復元) 場合も登録し直す。
 */
async function syncFontsNow(projectId: string, assets: Record<string, Asset>): Promise<void> {
  const FontFaceCtor = (globalThis as any).FontFace
  const fontSet = (globalThis as any).document?.fonts
  if (!FontFaceCtor || !fontSet) return
  const wanted = Object.values(assets).filter(a => a.kind === 'font')
  const wantedIds = new Set(wanted.map(a => a.id))
  for (const [id, entry] of registered) {
    if (!wantedIds.has(id)) {
      fontSet.delete(entry.face)
      registered.delete(id)
    }
  }
  let changed = false
  for (const asset of wanted) {
    const blob = await loadAssetBlob(projectId, asset.id)
    if (!blob) continue
    const key = `${projectId}:${asset.id}:${blob.size}`
    const cur = registered.get(asset.id)
    if (cur?.key === key) continue
    try {
      const face = new FontFaceCtor(`lvefont-${asset.id}`, await blob.arrayBuffer())
      await face.load()
      if (cur) fontSet.delete(cur.face)
      fontSet.add(face)
      registered.set(asset.id, { key, face })
      changed = true
    } catch (e) {
      console.warn('フォントを読み込めませんでした', asset.name, e)
    }
  }
  if (changed) fontsVersion.value++
}

/** フォントとして読み込めるか (追加時の確認用) */
export async function canLoadFont(blob: Blob): Promise<boolean> {
  const FontFaceCtor = (globalThis as any).FontFace
  if (!FontFaceCtor) return true
  try {
    await new FontFaceCtor('lve-probe', await blob.arrayBuffer()).load()
    return true
  } catch {
    return false
  }
}
