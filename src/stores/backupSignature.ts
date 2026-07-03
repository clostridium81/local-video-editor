import type { ProjectState } from '../types/project'

// ============================================================
// バックアップ差分検知のための「内容署名」
// ============================================================
// タブを閉じる際に「最後の ZIP バックアップ以降に編集があるか」を判定するための
// 純粋関数群。フラグ方式ではなくハッシュ比較にすることで、どの操作経路で state が
// 変わっても閉じる瞬間に確実に差分を捕捉できる (dirty の立て忘れが起きない)。
// ============================================================

// cyrb53: 軽量で衝突の少ない 53bit ハッシュ
export function hash53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * 「編集内容」の署名。バックアップに実質的に含まれる情報のみを対象にする。
 * - playhead / zoom は再生・表示の一時状態なので除外 (再生しただけで dirty にしない)
 * - meta.updatedAt は編集タイムスタンプなので 0 に正規化 (内容が同じなら同一署名)
 * これ以外 (meta のその他 / assets / folders / tracks / clips / markers /
 * in-out / snapping / rippleMode / masterVolume) はすべて対象に含めるので、
 * 実質的な編集はもれなく署名に反映される。
 */
export function contentSignature(s: ProjectState): string {
  const normalized = {
    meta: { ...s.meta, updatedAt: 0 },
    assets: s.assets,
    folders: s.folders ?? [],
    tracks: s.tracks,
    clips: s.clips,
    markers: s.markers ?? [],
    timeline: {
      duration: s.timeline.duration,
      inPoint: s.timeline.inPoint ?? null,
      outPoint: s.timeline.outPoint ?? null,
      snapping: s.timeline.snapping ?? true,
      rippleMode: s.timeline.rippleMode ?? false,
      masterVolume: s.timeline.masterVolume ?? 1
    }
  }
  return hash53(JSON.stringify(normalized))
}

/** 何も作っていない (捨てても失うもののない) プロジェクトか */
export function isEmptyProject(s: ProjectState): boolean {
  return (
    s.clips.length === 0 &&
    Object.keys(s.assets).length === 0 &&
    (s.markers?.length ?? 0) === 0
  )
}
