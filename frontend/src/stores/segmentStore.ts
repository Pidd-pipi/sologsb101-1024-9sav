import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  WEIGHT_EPSILON,
  type BatchSegment,
  type BatchSegmentSummary,
  type LayoutResult,
  type SegmentDraft,
  type SegmentState
} from '@/types/segment'
import type { Turning } from '@/types/turning'
import { useMilkStore } from '@/stores/milkStore'
import { round3 } from '@/utils/weight'

export interface NewSegmentInput {
  batchId: string
  seq: number
  blockCount: number
  weightKg: number
  shelfId: string | null
  state?: SegmentState
  mergedIntoId?: string | null
  placedAt?: number
}

/**
 * 批次分段 store：维护段表、按段块数汇总窖位占用，并提供
 * 分段落位、段转架迁移、合并出库等事务化操作。
 *
 * 并发约定：两个平板（多标签页）同时落位同一窖位时，容量校验与占用重算
 * 全部在同一个 IndexedDB 读写事务内基于最新数据完成；容量不足则整事务回滚，
 * 后到者拿到失败结果与最新余量，重新选位，保证两段不会共占一格。
 */
export const useSegmentStore = defineStore('segment', () => {
  const segmentsTable = useIdbTable<BatchSegment>((database) => database.segments, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()

  const segments = computed<BatchSegment[]>(() => segmentsTable.rows.value)
  const loading = computed(() => segmentsTable.loading.value)
  const ready = computed(() => segmentsTable.ready.value)
  const error = computed(() => segmentsTable.error.value)

  /** 仅占用窖位的段（在窖） */
  const activeSegments = computed<BatchSegment[]>(() =>
    segments.value.filter((segment) => segment.state === '在窖')
  )

  /** shelfId → 在窖段列表 */
  const activeSegmentsByShelf = computed<Record<string, BatchSegment[]>>(() => {
    const grouped: Record<string, BatchSegment[]> = {}
    activeSegments.value.forEach((segment) => {
      if (!segment.shelfId) return
      const bucket = grouped[segment.shelfId] ?? []
      bucket.push(segment)
      grouped[segment.shelfId] = bucket
    })
    return grouped
  })

  /** shelfId → 占用块数（按段块数合计），窖位看板占用率的唯一口径 */
  const occupiedBlocksByShelf = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    activeSegments.value.forEach((segment) => {
      if (!segment.shelfId) return
      map[segment.shelfId] = (map[segment.shelfId] ?? 0) + segment.blockCount
    })
    return map
  })

  /** batchId → 该批全部段（按 seq 升序） */
  const segmentsByBatch = computed<Record<string, BatchSegment[]>>(() => {
    const grouped: Record<string, BatchSegment[]> = {}
    segments.value.forEach((segment) => {
      const bucket = grouped[segment.batchId] ?? []
      bucket.push(segment)
      grouped[segment.batchId] = bucket
    })
    Object.values(grouped).forEach((list) => list.sort((a, b) => a.seq - b.seq))
    return grouped
  })

  function segmentsOf(batchId: string): BatchSegment[] {
    return segmentsByBatch.value[batchId] ?? []
  }

  /** 批次当前在窖段 */
  function activeSegmentsOf(batchId: string): BatchSegment[] {
    return segmentsOf(batchId)
      .filter((segment) => segment.state === '在窖')
      .sort((a, b) => a.seq - b.seq)
  }

  function segmentById(id: string | null | undefined): BatchSegment | null {
    if (!id) return null
    return segments.value.find((segment) => segment.id === id) ?? null
  }

  /** 批次分段落位的汇总派生值 */
  function summaryOf(batchId: string): BatchSegmentSummary {
    const active = activeSegmentsOf(batchId)
    const weight = round3(active.reduce((sum, segment) => sum + segment.weightKg, 0))
    const batch = milkStore.batches.find((item) => item.id === batchId)
    const delta = batch ? round3(weight - batch.weightKg) : 0
    const shelfIds = new Set(active.map((segment) => segment.shelfId).filter(Boolean) as string[])
    return {
      batchId,
      placedSegmentCount: active.length,
      totalBlocks: active.reduce((sum, segment) => sum + segment.blockCount, 0),
      totalWeightKg: weight,
      shelfCount: shelfIds.size,
      weightDeltaKg: delta,
      weightBalanced: batch ? Math.abs(delta) <= WEIGHT_EPSILON : false,
      assigned: active.length > 0
    }
  }

  /** 批次的代表窖位（第一段所在窖位），兼容旧页面的 batch.shelfId 展示口径 */
  function primaryShelfIdOf(batchId: string): string | null {
    const active = activeSegmentsOf(batchId)
    if (active.length > 0) return active[0].shelfId
    const historic = segmentsOf(batchId)
      .filter((segment) => segment.shelfId && segment.state !== '已合并')
      .sort((a, b) => a.seq - b.seq)[0]
    return historic?.shelfId ?? null
  }

  function nextSeqOf(batchId: string): number {
    const list = segmentsOf(batchId)
    return list.length === 0 ? 1 : Math.max(...list.map((segment) => segment.seq)) + 1
  }

  /**
   * 事务内：把每个受影响窖位的 occupied 重算为「在窖段块数合计」，并夹取到 capacity。
   * 必须在 db.transaction('rw', ...) 回调内调用（Dexie 自动复用当前事务）；
   * 所有跨段迁移 / 落位 / 出库都走这一函数，保证占用口径唯一、并发安全。
   */
  async function recomputeShelfOccupancy(affectedShelfIds: Iterable<string>, now: number): Promise<void> {
    const onShelf = new Map<string, number>()
    const allSegments = await db.segments.toArray()
    allSegments.forEach((segment) => {
      if (segment.state !== '在窖' || !segment.shelfId) return
      onShelf.set(segment.shelfId, (onShelf.get(segment.shelfId) ?? 0) + segment.blockCount)
    })
    for (const shelfId of new Set(affectedShelfIds)) {
      const shelf = await db.shelves.get(shelfId)
      if (!shelf) continue
      await db.shelves.update(shelfId, {
        occupied: Math.max(0, Math.min(shelf.capacity, onShelf.get(shelfId) ?? 0)),
        updatedAt: now
      })
    }
  }

  /** 同步批次的代表窖位 shelfId（第一在窖段所在窖位），供旧索引与展示使用 */
  async function syncBatchShelf(batchId: string, now: number): Promise<void> {
    const batchSegments = await db.segments.where('batchId').equals(batchId).toArray()
    const first = batchSegments
      .filter((segment) => segment.state === '在窖')
      .sort((a, b) => a.seq - b.seq)[0]
    const batch = await db.batches.get(batchId)
    if (batch && batch.shelfId !== (first?.shelfId ?? null)) {
      await db.batches.update(batchId, { shelfId: first?.shelfId ?? null, updatedAt: now })
    }
  }

  /**
   * 分段落位：按草稿覆盖批次的在窖段（新增 / 修改 / 删除），
   * 同事务内校验重量守恒与各窖位容量，重算占用并回写批次代表窖位。
   * 校验失败时不写入任何数据，返回失败原因（含冲突窖位最新余量）。
   */
  async function saveLayout(batchId: string, drafts: SegmentDraft[]): Promise<LayoutResult> {
    // 从数据库直读最新批次（不依赖 store 响应式缓存，新建批次后立即保存时缓存可能尚未刷新）
    const batch = await db.batches.get(batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试' }
    if (batch.state === '已出库' || batch.state === '报废') {
      return { ok: false, message: `批次状态为「${batch.state}」，不能再分段落位` }
    }

    const existing = await db.segments.where('batchId').equals(batchId).toArray()
    const activeExisting = existing.filter((segment) => segment.state === '在窖')
    const kept = drafts.filter((draft) => draft.shelfId)
    if (kept.length === 0) {
      return { ok: false, message: '请至少保留一个已落位的段（选择窖位）；整批下架请用「全部下架」' }
    }
    if (kept.some((draft) => !Number.isFinite(draft.blockCount) || draft.blockCount < 1)) {
      return { ok: false, message: '每段至少 1 块，请修正块数后再保存' }
    }
    if (kept.some((draft) => !Number.isFinite(draft.weightKg) || draft.weightKg <= 0)) {
      return { ok: false, message: '每段重量需大于 0，请修正重量后再保存' }
    }

    const totalWeight = round3(kept.reduce((sum, draft) => sum + draft.weightKg, 0))
    if (Math.abs(totalWeight - batch.weightKg) > WEIGHT_EPSILON) {
      return {
        ok: false,
        message: `各段重量合计 ${totalWeight}kg 与入库重量 ${batch.weightKg}kg 不符（差 ${round3(
          totalWeight - batch.weightKg
        )}kg），请调整后再保存`
      }
    }

    // 本批草稿对每个窖位的块数需求
    const draftByShelf = new Map<string, number>()
    kept.forEach((draft) => {
      const shelfId = draft.shelfId as string
      draftByShelf.set(shelfId, (draftByShelf.get(shelfId) ?? 0) + draft.blockCount)
    })

    const now = Date.now()
    const movedSegmentIds: string[] = []
    const placedBlocks = kept.reduce((sum, draft) => sum + draft.blockCount, 0)
    try {
      await db.transaction(
        'rw',
        [db.segments, db.shelves, db.batches, db.turnings, db.environments],
        async () => {
          // 事务内重读窖位与占用，避免两个平板同时保存时读到旧余量
          const liveShelves = await db.shelves.toArray()
          const otherByShelf = new Map<string, number>()
          const liveSegments = await db.segments.toArray()
          liveSegments.forEach((segment) => {
            if (segment.state !== '在窖' || !segment.shelfId) return
            if (segment.batchId === batchId) return
            otherByShelf.set(
              segment.shelfId,
              (otherByShelf.get(segment.shelfId) ?? 0) + segment.blockCount
            )
          })
          for (const [shelfId, need] of draftByShelf) {
            const shelf = liveShelves.find((item) => item.id === shelfId)
            if (!shelf) throw new LayoutError('窖位已被删除，请刷新后重新选位')
            const other = otherByShelf.get(shelfId) ?? 0
            if (other + need > shelf.capacity) {
              throw new LayoutError(
                `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层余量不足：该窖位仅剩 ${Math.max(
                  0,
                  shelf.capacity - other
                )} 块余量，本段需要 ${need} 块。请看到最新余量后重新选位`,
                shelfId,
                Math.max(0, shelf.capacity - other),
                shelf.capacity
              )
            }
          }

          // 覆盖在窖段：有 seg_ id 的更新，临时 key 的新增；被删掉的在窖段解除引用后删除
          const keptIds = new Set(
            kept.map((draft) => draft.key).filter((key) => key.startsWith('seg_'))
          )
          const removeIds = activeExisting
            .filter((segment) => !keptIds.has(segment.id))
            .map((segment) => segment.id)
          if (removeIds.length > 0) {
            await db.turnings.where('batchId').equals(batchId).modify((turning) => {
              if (!turning.segmentIds.some((id) => removeIds.includes(id))) return
              turning.segmentIds = turning.segmentIds.filter((id) => !removeIds.includes(id))
              turning.updatedAt = now
            })
            await db.environments.where('segmentId').anyOf(removeIds).modify({
              segmentId: null,
              updatedAt: now
            })
            await db.segments.bulkDelete(removeIds)
          }

          const affectedShelfIds = new Set<string>(draftByShelf.keys())
          activeExisting.forEach((segment) => {
            if (segment.shelfId) affectedShelfIds.add(segment.shelfId)
          })

          for (const draft of kept) {
            if (draft.key.startsWith('seg_')) {
              const previous = await db.segments.get(draft.key)
              const changedShelf = previous && previous.shelfId !== draft.shelfId
              await db.segments.update(draft.key, {
                seq: draft.seq,
                blockCount: draft.blockCount,
                weightKg: draft.weightKg,
                shelfId: draft.shelfId,
                state: '在窖' as SegmentState,
                mergedIntoId: null,
                ...(changedShelf ? { placedAt: now } : {})
              })
              if (changedShelf) movedSegmentIds.push(draft.key)
            } else {
              await db.segments.put({
                id: createId('seg'),
                batchId,
                seq: draft.seq,
                blockCount: draft.blockCount,
                weightKg: draft.weightKg,
                shelfId: draft.shelfId,
                state: '在窖',
                mergedIntoId: null,
                placedAt: now,
                createdAt: now,
                updatedAt: now
              })
            }
          }

          await recomputeShelfOccupancy(affectedShelfIds, now)
          await syncBatchShelf(batchId, now)
        }
      )
    } catch (err) {
      if (err instanceof LayoutError) {
        return {
          ok: false,
          message: err.message,
          shelfId: err.shelfId,
          free: err.free,
          capacity: err.capacity
        }
      }
      throw err
    }
    return {
      ok: true,
      message: `分段落位已保存：${kept.length} 段、${placedBlocks} 块，重量合计 ${totalWeight}kg 与入库重量一致`,
      movedCount: movedSegmentIds.length
    }
  }

  /** 全部下架：批次在窖段全部移除（删除段及其引用），释放窖位 */
  async function releaseAll(batchId: string): Promise<LayoutResult> {
    const batch = await db.batches.get(batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试' }
    const active = (await db.segments.where('batchId').equals(batchId).toArray())
      .filter((segment) => segment.state === '在窖')
    if (active.length === 0) return { ok: false, message: '该批次当前没有在窖段' }
    const now = Date.now()
    const affectedShelfIds = new Set(
      active.map((segment) => segment.shelfId).filter(Boolean) as string[]
    )
    await db.transaction(
      'rw',
      [db.segments, db.shelves, db.batches, db.turnings, db.environments],
      async () => {
        const ids = active.map((segment) => segment.id)
        await db.turnings.where('batchId').equals(batchId).modify((turning) => {
          if (!turning.segmentIds.some((id) => ids.includes(id))) return
          turning.segmentIds = turning.segmentIds.filter((id) => !ids.includes(id))
          turning.updatedAt = now
        })
        await db.environments.where('segmentId').anyOf(ids).modify({ segmentId: null, updatedAt: now })
        await db.segments.bulkDelete(ids)
        await recomputeShelfOccupancy(affectedShelfIds, now)
        await syncBatchShelf(batchId, now)
      }
    )
    return { ok: true, message: '全部段已下架，窖位余量已释放' }
  }

  /**
   * 段转架：把指定段迁移到目标窖位。在事务内重读目标窖位余量，
   * 容量不足则回滚并返回最新余量（供后到的平板重新选位）。
   */
  async function moveSegments(
    batchId: string,
    segmentIds: string[],
    targetShelfId: string
  ): Promise<LayoutResult> {
    if (segmentIds.length === 0) return { ok: false, message: '请至少选择一个要转架的段' }
    const now = Date.now()
    const moving = new Set(segmentIds)
    let movedCount = 0
    try {
      await db.transaction('rw', [db.segments, db.shelves, db.batches], async () => {
        const target = await db.shelves.get(targetShelfId)
        if (!target) throw new LayoutError('目标窖位不存在，请刷新后重试')
        const liveSegments = await db.segments.toArray()
        const otherBlocks = liveSegments
          .filter(
            (segment) =>
              segment.state === '在窖' &&
              segment.shelfId === targetShelfId &&
              !moving.has(segment.id)
          )
          .reduce((sum, segment) => sum + segment.blockCount, 0)
        const needBlocks = liveSegments
          .filter((segment) => moving.has(segment.id))
          .reduce((sum, segment) => sum + segment.blockCount, 0)
        if (otherBlocks + needBlocks > target.capacity) {
          throw new LayoutError(
            `${target.room} ${target.rackNo} 第 ${target.layerNo} 层余量不足：仅剩 ${Math.max(
              0,
              target.capacity - otherBlocks
            )} 块，本次要转入 ${needBlocks} 块。请看到最新余量后重新选位`,
            targetShelfId,
            Math.max(0, target.capacity - otherBlocks),
            target.capacity
          )
        }

        const affectedShelfIds = new Set<string>([targetShelfId])
        for (const id of segmentIds) {
          const segment = await db.segments.get(id)
          if (!segment || segment.batchId !== batchId) {
            throw new LayoutError('段已被删除或不属于该批次，请刷新后重试')
          }
          if (segment.state !== '在窖') {
            throw new LayoutError(`第 ${segment.seq} 段不在窖中，无法转架`)
          }
          if (segment.shelfId === targetShelfId) continue
          if (segment.shelfId) affectedShelfIds.add(segment.shelfId)
          await db.segments.update(id, {
            shelfId: targetShelfId,
            placedAt: now,
            updatedAt: now
          })
          movedCount += 1
        }
        if (movedCount === 0) throw new LayoutError('所选段都已在目标窖位，无需转架')
        await recomputeShelfOccupancy(affectedShelfIds, now)
        await syncBatchShelf(batchId, now)
      })
    } catch (err) {
      if (err instanceof LayoutError) {
        return {
          ok: false,
          message: err.message,
          shelfId: err.shelfId,
          free: err.free,
          capacity: err.capacity
        }
      }
      throw err
    }
    return { ok: true, message: `已把 ${movedCount} 段转入所选窖位`, movedCount }
  }

  /**
   * 段合并：把多个在窖段并入一个保留段（重量与块数合计），
   * 其余段标记「已合并」；被合并段上的转架 / 环境记录改挂保留段。
   * 同窖位合并不动占用；跨窖位合并（理论上少见）会重算占用。
   */
  async function mergeSegments(
    batchId: string,
    segmentIds: string[],
    keepSegmentId: string
  ): Promise<LayoutResult> {
    const ids = new Set(segmentIds)
    if (!ids.has(keepSegmentId) || ids.size < 2) {
      return { ok: false, message: '请选择至少两个段，并指定保留段' }
    }
    const now = Date.now()
    try {
      await db.transaction(
        'rw',
        [db.segments, db.shelves, db.batches, db.turnings, db.environments],
        async () => {
          const members = (
            await db.segments.where('batchId').equals(batchId).toArray()
          ).filter((segment) => ids.has(segment.id))
          const keep = members.find((segment) => segment.id === keepSegmentId)
          if (!keep) throw new LayoutError('保留段不存在，请刷新后重试')
          const merged = members.filter(
            (segment) => segment.id !== keepSegmentId && segment.state === '在窖'
          )
          if (merged.length === 0) throw new LayoutError('没有可合并的其他在窖段')
          if (keep.state !== '在窖') throw new LayoutError('保留段不在窖中，无法承接合并')

          const totalBlocks =
            keep.blockCount + merged.reduce((sum, segment) => sum + segment.blockCount, 0)
          const totalWeight = round3(
            keep.weightKg + merged.reduce((sum, segment) => sum + segment.weightKg, 0)
          )
          await db.segments.update(keep.id, {
            blockCount: totalBlocks,
            weightKg: totalWeight,
            updatedAt: now
          })

          const affectedShelfIds = new Set<string>()
          if (keep.shelfId) affectedShelfIds.add(keep.shelfId)
          for (const segment of merged) {
            if (segment.shelfId) affectedShelfIds.add(segment.shelfId)
            await db.segments.update(segment.id, {
              state: '已合并' as SegmentState,
              mergedIntoId: keep.id,
              shelfId: keep.shelfId,
              updatedAt: now
            })
            await db.turnings.where('batchId').equals(batchId).modify((turning) => {
              if (!turning.segmentIds.includes(segment.id)) return
              turning.segmentIds = [
                ...new Set(turning.segmentIds.map((id) => (id === segment.id ? keep.id : id)))
              ]
              turning.updatedAt = now
            })
            await db.environments.where('segmentId').equals(segment.id).modify({
              segmentId: keep.id,
              updatedAt: now
            })
          }
          await recomputeShelfOccupancy(affectedShelfIds, now)
          await syncBatchShelf(batchId, now)
        }
      )
    } catch (err) {
      if (err instanceof LayoutError) return { ok: false, message: err.message }
      throw err
    }
    return { ok: true, message: '段已合并，重量与块数已计入保留段，历史记录改挂保留段' }
  }

  /** 批次出库：在窖段全部标记「已出库」，释放窖位占用，保留最后窖位备查；无在窖段时视为空操作 */
  async function markShipped(batchId: string): Promise<LayoutResult> {
    const active = activeSegmentsOf(batchId)
    if (active.length === 0) return { ok: true, message: '该批次没有在窖段，无需释放窖位' }
    const now = Date.now()
    const affectedShelfIds = new Set(
      active.map((segment) => segment.shelfId).filter(Boolean) as string[]
    )
    await db.transaction('rw', [db.segments, db.shelves, db.batches], async () => {
      for (const segment of active) {
        await db.segments.update(segment.id, { state: '已出库' as SegmentState, updatedAt: now })
      }
      await recomputeShelfOccupancy(affectedShelfIds, now)
      await syncBatchShelf(batchId, now)
    })
    return { ok: true, message: `已出库 ${active.length} 段，窖位余量已释放（段档案保留）` }
  }

  async function removeSegment(id: string): Promise<void> {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return
    const now = Date.now()
    const affectedShelfIds = new Set<string>(segment.shelfId ? [segment.shelfId] : [])
    await db.transaction(
      'rw',
      [db.segments, db.shelves, db.batches, db.turnings, db.environments],
      async () => {
        await db.turnings.where('batchId').equals(segment.batchId).modify((turning) => {
          if (!turning.segmentIds.includes(id)) return
          turning.segmentIds = turning.segmentIds.filter((item) => item !== id)
          turning.updatedAt = now
        })
        await db.environments.where('segmentId').equals(id).modify({ segmentId: null, updatedAt: now })
        await db.segments.delete(id)
        await recomputeShelfOccupancy(affectedShelfIds, now)
        await syncBatchShelf(segment.batchId, now)
      }
    )
  }

  /** 转架记录的携带段：空数组（历史整批记录）回退为该批全部段 */
  function resolveTurningSegments(turning: Turning): BatchSegment[] {
    if (turning.segmentIds.length > 0) {
      return turning.segmentIds
        .map((id) => segmentById(id))
        .filter((segment): segment is BatchSegment => Boolean(segment))
    }
    return segmentsOf(turning.batchId)
  }

  return {
    segments,
    activeSegments,
    loading,
    ready,
    error,
    activeSegmentsByShelf,
    occupiedBlocksByShelf,
    segmentsByBatch,
    segmentsOf,
    activeSegmentsOf,
    segmentById,
    summaryOf,
    primaryShelfIdOf,
    nextSeqOf,
    saveLayout,
    releaseAll,
    moveSegments,
    mergeSegments,
    markShipped,
    removeSegment,
    resolveTurningSegments,
    recomputeShelfOccupancy
  }
})

/** 可中断事务的业务异常：携带冲突窖位的最新余量供 UI 提示重新选位 */
class LayoutError extends Error {
  shelfId?: string
  free?: number
  capacity?: number

  constructor(message: string, shelfId?: string, free?: number, capacity?: number) {
    super(message)
    this.name = 'LayoutError'
    this.shelfId = shelfId
    this.free = free
    this.capacity = capacity
  }
}

export type SegmentStore = ReturnType<typeof useSegmentStore>
