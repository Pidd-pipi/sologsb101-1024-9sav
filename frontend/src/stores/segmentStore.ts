import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  checkWeightBalance,
  splitWeightEvenly,
  type Segment,
  type SegmentPlaceResult,
  type SegmentWeightBalance
} from '@/types/segment'
import type { Batch } from '@/types/batch'
import { useMilkStore } from '@/stores/milkStore'

/**
 * 分段（块）store：一批按块拆到多个窖位，每块单独落位。
 * 各段重量合计 = 批次入库重量；每段落位占用窖位 1 块容量。
 * 落位 / 挪窝在 Dexie 读写事务内二次校验窖位余量与段版本号，
 * 两个平板同时保存同一段时先写者胜，后到者看到余量后重新选位。
 */
export const useSegmentStore = defineStore('segment', () => {
  const segmentsTable = useIdbTable<Segment>((database) => database.segments, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()

  const segments = computed<Segment[]>(() => segmentsTable.rows.value)
  const loading = computed(() => segmentsTable.loading.value)
  const ready = computed(() => segmentsTable.ready.value)
  const error = computed(() => segmentsTable.error.value)

  const batches = computed<Batch[]>(() => milkStore.batches)

  /** segmentId → 分段 */
  const segmentMap = computed<Record<string, Segment>>(() => {
    const map: Record<string, Segment> = {}
    segments.value.forEach((segment) => {
      map[segment.id] = segment
    })
    return map
  })

  /** batchId → 该批次的分段（按段号升序） */
  const segmentsByBatch = computed<Record<string, Segment[]>>(() => {
    const grouped: Record<string, Segment[]> = {}
    segments.value.forEach((segment) => {
      const bucket = grouped[segment.batchId] ?? []
      bucket.push(segment)
      grouped[segment.batchId] = bucket
    })
    Object.values(grouped).forEach((list) => list.sort((a, b) => a.blockNo - b.blockNo))
    return grouped
  })

  /** shelfId → 该窖位上的分段（按段号排序） */
  const segmentsByShelf = computed<Record<string, Segment[]>>(() => {
    const grouped: Record<string, Segment[]> = {}
    segments.value.forEach((segment) => {
      if (!segment.shelfId) return
      const bucket = grouped[segment.shelfId] ?? []
      bucket.push(segment)
      grouped[segment.shelfId] = bucket
    })
    return grouped
  })

  /** 全部未上架分段（跨批次），落位选择用 */
  const unplacedSegments = computed<Segment[]>(() =>
    segments.value
      .filter((segment) => segment.shelfId === null)
      .sort((a, b) => b.createdAt - a.createdAt)
  )

  function segmentsOfBatch(batchId: string): Segment[] {
    return (segmentsByBatch.value[batchId] ?? []).slice().sort((a, b) => a.blockNo - b.blockNo)
  }

  function placedSegmentsOfBatch(batchId: string): Segment[] {
    return segmentsOfBatch(batchId).filter((segment) => segment.shelfId !== null)
  }

  function segmentsOfShelf(shelfId: string): Segment[] {
    return (segmentsByShelf.value[shelfId] ?? []).slice().sort((a, b) => a.blockNo - b.blockNo)
  }

  function batchOf(batchId: string): Batch | null {
    return batches.value.find((batch) => batch.id === batchId) ?? null
  }

  function segmentLabel(segment: Segment | null | undefined): string {
    if (!segment) return '整批'
    const batch = batchOf(segment.batchId)
    const batchLabel = batch ? `${batch.cheeseType} ${batch.curdedAt}` : '批次已删除'
    return `${batchLabel} · 第 ${segment.blockNo} 段`
  }

  /** 批次主窖位：已落位分段中段号最小的所在窖位 */
  function primaryShelfIdOf(batchId: string): string | null {
    const placed = placedSegmentsOfBatch(batchId)
    return placed[0]?.shelfId ?? null
  }

  /** 重量守恒校验：各段合计 = 批次入库重量 */
  function weightBalanceOf(batchId: string): SegmentWeightBalance | null {
    const batch = batchOf(batchId)
    if (!batch) return null
    const list = segmentsOfBatch(batchId)
    return checkWeightBalance(
      batchId,
      batch.weightKg,
      list.map((segment) => ({ weightKg: segment.weightKg, shelfId: segment.shelfId }))
    )
  }

  /** 按当前分段数重算窖位占用数（段数 = 占用块数） */
  async function recomputeShelfOccupancy(shelfIds?: string[]): Promise<void> {
    const ids = shelfIds ?? (await db.shelves.toArray()).map((shelf) => shelf.id)
    const now = Date.now()
    await db.transaction('rw', [db.shelves, db.segments], async () => {
      for (const id of ids) {
        const hosted = await db.segments.where('shelfId').equals(id).count()
        await db.shelves.update(id, { occupied: hosted, updatedAt: now })
      }
    })
  }

  /**
   * 为批次重建分段：按块数均分入库重量，末段补齐余数。
   * 已落位的分段会被释放（重量重排），调用前由组件确认。
   */
  async function splitBatch(batchId: string, blockCount: number): Promise<number> {
    const batch = batchOf(batchId)
    if (!batch) return 0
    const count = Math.max(1, Math.round(blockCount))
    const weights = splitWeightEvenly(batch.weightKg, count)
    const now = Date.now()
    const old = segmentsOfBatch(batchId)
    const oldIds = old.map((segment) => segment.id)
    const oldShelfIds = Array.from(new Set(old.map((segment) => segment.shelfId).filter(Boolean))) as string[]
    await db.transaction(
      'rw',
      [db.segments, db.shelves, db.batches, db.turnings, db.environments],
      async () => {
        // 解除历史转架 / 环境记录对旧分段的引用（变为批次级作业），避免悬挂指针
        if (oldIds.length > 0) {
          await db.turnings.where('segmentId').anyOf(oldIds).modify({ segmentId: null, updatedAt: now })
          await db.environments
            .where('segmentId')
            .anyOf(oldIds)
            .modify({ segmentId: null, updatedAt: now })
        }
        await db.segments.where('batchId').equals(batchId).delete()
        const records: Segment[] = weights.map((weightKg, index) => ({
          id: createId('seg'),
          batchId,
          blockNo: index + 1,
          weightKg,
          shelfId: null,
          rev: 0,
          note: '',
          createdAt: now,
          updatedAt: now
        }))
        await db.segments.bulkPut(records)
        // 释放原占用窖位
        for (const shelfId of oldShelfIds) {
          const hosted = await db.segments.where('shelfId').equals(shelfId).count()
          await db.shelves.update(shelfId, { occupied: hosted, updatedAt: now })
        }
        // 批次主窖位清空（分段全部重新落位）
        await db.batches.update(batchId, { shelfId: null, updatedAt: now })
      }
    )
    return count
  }

  /**
   * 落位：把一个未上架分段放到指定窖位。
   * 事务内二次校验：段版本号一致（先写者胜）+ 窖位余量（段数 < 容量）。
   * 冲突时返回明确提示，由组件引导用户重新选位。
   */
  async function placeSegment(
    segmentId: string,
    shelfId: string,
    expectedRev?: number
  ): Promise<SegmentPlaceResult> {
    const segment = await db.segments.get(segmentId)
    if (!segment) return { ok: false, message: '分段不存在，请刷新后重试' }
    if (segment.shelfId) {
      return { ok: false, message: `该段已在其他窖位上，如需挪窝请用「移段」` }
    }
    if (expectedRev !== undefined && segment.rev !== expectedRev) {
      return { ok: false, message: '该段已被其他操作修改（可能已被另一台设备上架），请刷新余量后重新选位' }
    }
    const shelf = await db.shelves.get(shelfId)
    if (!shelf) return { ok: false, message: '窖位不存在，请刷新后重试' }
    const hosted = await db.segments.where('shelfId').equals(shelfId).count()
    if (hosted >= shelf.capacity) {
      return {
        ok: false,
        message: `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层余量已被占完（${hosted}/${shelf.capacity}），请重新选位`
      }
    }

    const now = Date.now()
    try {
      await db.transaction('rw', [db.segments, db.shelves, db.batches], async () => {
        // 事务内二次校验，保证多标签页并发写时先写者胜
        const segNow = await db.segments.get(segmentId)
        if (!segNow || segNow.shelfId) throw new Error('SEGMENT_ALREADY_PLACED')
        const shelfNow = await db.shelves.get(shelfId)
        const hostedNow = await db.segments.where('shelfId').equals(shelfId).count()
        if (!shelfNow || hostedNow >= shelfNow.capacity) throw new Error('SHELF_FULL')
        await db.segments.update(segmentId, {
          shelfId,
          rev: segNow.rev + 1,
          updatedAt: now
        })
        await db.shelves.update(shelfId, { occupied: hostedNow + 1, updatedAt: now })
        await syncBatchPlacement(segment.batchId, now)
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'SHELF_FULL') {
        return {
          ok: false,
          message: `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层余量已被其他设备占用，请重新选位`
        }
      }
      if (err instanceof Error && err.message === 'SEGMENT_ALREADY_PLACED') {
        return { ok: false, message: '该段已被其他设备上架，请刷新后重新选位' }
      }
      throw err
    }

    return {
      ok: true,
      message: `已落位至 ${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层（${Math.min(
        shelf.capacity,
        hosted + 1
      )}/${shelf.capacity} 块）`
    }
  }

  /**
   * 挪窝：把已落位分段从原窖位移到新窖位。
   * 事务内二次校验段版本号与新窖位余量。
   */
  async function moveSegment(
    segmentId: string,
    toShelfId: string,
    expectedRev?: number
  ): Promise<SegmentPlaceResult> {
    const segment = await db.segments.get(segmentId)
    if (!segment) return { ok: false, message: '分段不存在，请刷新后重试' }
    if (!segment.shelfId) return { ok: false, message: '该段尚未落位，请先选择窖位上架' }
    if (segment.shelfId === toShelfId) {
      return { ok: false, message: '该段已在目标窖位上' }
    }
    if (expectedRev !== undefined && segment.rev !== expectedRev) {
      return { ok: false, message: '该段已被其他操作修改，请刷新余量后重新选位' }
    }
    const target = await db.shelves.get(toShelfId)
    if (!target) return { ok: false, message: '目标窖位不存在，请刷新后重试' }
    const hosted = await db.segments.where('shelfId').equals(toShelfId).count()
    if (hosted >= target.capacity) {
      return {
        ok: false,
        message: `${target.room} ${target.rackNo} 第 ${target.layerNo} 层余量已被占完（${hosted}/${target.capacity}），请重新选位`
      }
    }

    const fromShelfId = segment.shelfId
    const now = Date.now()
    try {
      await db.transaction('rw', [db.segments, db.shelves, db.batches], async () => {
        const segNow = await db.segments.get(segmentId)
        if (!segNow || segNow.shelfId !== fromShelfId) throw new Error('SEGMENT_CHANGED')
        const targetNow = await db.shelves.get(toShelfId)
        const hostedNow = await db.segments.where('shelfId').equals(toShelfId).count()
        if (!targetNow || hostedNow >= targetNow.capacity) throw new Error('SHELF_FULL')
        // 释放原窖位
        const fromHosted = await db.segments.where('shelfId').equals(fromShelfId).count()
        await db.shelves.update(fromShelfId, {
          occupied: Math.max(0, fromHosted - 1),
          updatedAt: now
        })
        // 占用新窖位
        await db.segments.update(segmentId, {
          shelfId: toShelfId,
          rev: segNow.rev + 1,
          updatedAt: now
        })
        await db.shelves.update(toShelfId, { occupied: hostedNow + 1, updatedAt: now })
        await syncBatchPlacement(segment.batchId, now)
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'SHELF_FULL') {
        return {
          ok: false,
          message: `${target.room} ${target.rackNo} 第 ${target.layerNo} 层余量已被其他设备占用，请重新选位`
        }
      }
      if (err instanceof Error && err.message === 'SEGMENT_CHANGED') {
        return { ok: false, message: '该段已被其他设备挪动，请刷新后重新选位' }
      }
      throw err
    }

    return {
      ok: true,
      message: `已挪至 ${target.room} ${target.rackNo} 第 ${target.layerNo} 层（${Math.min(
        target.capacity,
        hosted + 1
      )}/${target.capacity} 块）`
    }
  }

  /** 下架：释放分段所在窖位占用，分段回到未上架状态 */
  async function releaseSegment(segmentId: string): Promise<SegmentPlaceResult> {
    const segment = await db.segments.get(segmentId)
    if (!segment) return { ok: false, message: '分段不存在，请刷新后重试' }
    if (!segment.shelfId) return { ok: false, message: '该段尚未落位' }
    const shelfId = segment.shelfId
    const shelf = await db.shelves.get(shelfId)
    const label = shelf ? `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层` : shelfId
    const now = Date.now()
    await db.transaction('rw', [db.segments, db.shelves, db.batches], async () => {
      const hosted = await db.segments.where('shelfId').equals(shelfId).count()
      await db.shelves.update(shelfId, {
        occupied: Math.max(0, hosted - 1),
        updatedAt: now
      })
      await db.segments.update(segmentId, { shelfId: null, rev: segment.rev + 1, updatedAt: now })
      await syncBatchPlacement(segment.batchId, now)
    })
    return { ok: true, message: `已下架，释放 ${label} 1 块余量` }
  }

  /** 批次出库 / 批量下架：释放该批次全部已落位分段 */
  async function releaseBatchSegments(batchId: string): Promise<number> {
    const list = await db.segments.where('batchId').equals(batchId).toArray()
    const placed = list.filter((segment) => segment.shelfId !== null)
    if (placed.length === 0) return 0
    const shelfIds = Array.from(new Set(placed.map((segment) => segment.shelfId))) as string[]
    const now = Date.now()
    await db.transaction('rw', [db.segments, db.shelves, db.batches], async () => {
      for (const shelfId of shelfIds) {
        const hosted = await db.segments.where('shelfId').equals(shelfId).count()
        const releasing = placed.filter((segment) => segment.shelfId === shelfId).length
        await db.shelves.update(shelfId, {
          occupied: Math.max(0, hosted - releasing),
          updatedAt: now
        })
      }
      for (const segment of placed) {
        await db.segments.update(segment.id, {
          shelfId: null,
          rev: segment.rev + 1,
          updatedAt: now
        })
      }
      await db.batches.update(batchId, { shelfId: null, updatedAt: now })
    })
    return placed.length
  }

  /** 批次落位后回写批次主窖位（首段所在窖位）与状态 */
  async function syncBatchPlacement(batchId: string, now: number): Promise<void> {
    const list = await db.segments.where('batchId').equals(batchId).toArray()
    const placed = list
      .filter((segment) => segment.shelfId !== null)
      .sort((a, b) => a.blockNo - b.blockNo)
    const primary = placed[0]?.shelfId ?? null
    const batch = await db.batches.get(batchId)
    if (!batch) return
    const patch: Partial<Batch> = { shelfId: primary, updatedAt: now }
    if (batch.state === '凝乳' && placed.length > 0) patch.state = '熟成中'
    await db.batches.update(batchId, patch)
  }

  return {
    segments,
    loading,
    ready,
    error,
    segmentMap,
    segmentsByBatch,
    segmentsByShelf,
    unplacedSegments,
    segmentsOfBatch,
    placedSegmentsOfBatch,
    segmentsOfShelf,
    batchOf,
    segmentLabel,
    primaryShelfIdOf,
    weightBalanceOf,
    recomputeShelfOccupancy,
    splitBatch,
    placeSegment,
    moveSegment,
    releaseSegment,
    releaseBatchSegments
  }
})

export type SegmentStore = ReturnType<typeof useSegmentStore>
