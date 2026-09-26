import { saveBackup } from '../persistence/backup'
import { toast } from './useToast'
import { localeT as t } from './useLocale'
import type { useProjectStore } from '../stores/projectStore'

// ============================================================
// バックアップ保存の共通処理 (上部バー / バックアップ促進ダイアログ)
// ============================================================
// 「バックアップ済み」(= タブを閉じる時の警告を出さない) にするのは、
// 素材をすべて含めて保存できたときだけ。
//  - 保存先への書き込み完了を確認できた (saved)
//  - ダウンロードを開始した (downloaded: 完了はブラウザ任せ。従来どおり)
// 保存先の選択をやめた / 読めない素材があった場合は未保存のままにする。

type Store = ReturnType<typeof useProjectStore>

/** 保存できたら true */
export async function runBackupSave(store: Store): Promise<boolean> {
  const session = store.sessionVersion
  try {
    // ダウンロードした内容と一致する署名を記録するため、同じスナップショットを使う
    const snapshot = store.serialize()
    const { status, skipped } = await saveBackup(snapshot)
    if (status === 'cancelled') {
      toast.info(t('バックアップを やめました (まだ 保存されていません)', 'バックアップを中止しました (未保存)'))
      return false
    }
    if (skipped.length > 0) {
      toast.warn(
        t(
          '読めなかった素材を 除いて 保存しました。元のファイルが 移動・変更・削除されていないか 確かめてください: ',
          '読み込めない素材を除いて保存しました (元ファイルの移動・変更・削除を確認してください): '
        ) + skipped.map(a => a.name).join('、'),
        15000
      )
      return false
    }
    if (session === store.sessionVersion) store.markBackedUp(snapshot)
    toast.success(
      status === 'saved'
        ? t('バックアップを保存しました', 'バックアップを保存しました')
        : t(
            'バックアップを ダウンロードしました。保存された ファイルを 確かめてください',
            'バックアップをダウンロードしました (保存先のファイルを確認してください)'
          )
    )
    return true
  } catch (e: any) {
    console.error(e)
    toast.error(
      t('バックアップの保存に失敗しました: ', 'バックアップの保存に失敗しました: ') + (e?.message ?? ''),
      15000
    )
    return false
  }
}
