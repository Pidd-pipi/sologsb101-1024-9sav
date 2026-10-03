import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createEmptyShelfFilter,
  TEMP_ZONES,
  type Shelf,
  type ShelfAssignResult,
  type ShelfFilterState,
  type ShelfOccupancy,
  type TempZone
} from '@/types/shelf'
import type { BatchSegment } from '@/types/segment'
import { useMilkStore } from '@/stores/milkStore'
import { useSegmentStore } from '@/stores/segmentStore'

export interface NewShelfInput {
  room: string
  rackNo: string
  layerNo: number
  tempZone: TempZone
  capacity: number
  occupied: number
}

/**
 * 熟成库窖位 store：维护货架列表、占用率派生值、当前选中库房。
 * 占用口径：窖位 occupied = 该窖位上全部「在窖段」块数合计（分段块数），
 * 由 segmentStore 的事务化操作统一重算，本 store 只做派生展示。
 */
export const useShelfStore = defineStore('shelf', () => {
  const shelvesTable = useIdbTable<Shelf>((database) => database.shelves, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()
  const segmentStore = useSegmentStore()

  const prefs = readUiPrefs()
  const filter = ref<ShelfFilterState>(createEmptyShelfFilter())
  const currentRoom = ref<string>(prefs.lastRoom ?? '')
  const currentShelfId = ref<string | null>(null)

  const shelves = computed<Shelf[]>(() => shelvesTable.rows.value)
  const loading = computed(() => shelvesTable.loading.value)
  const ready = computed(() => shelvesTable.ready.value)
  const error = computed(() => shelvesTable.error.value)

  /** 库房选项（含「未指定」的空字符串过滤语义） */
  const roomOptions = computed<string[]>(() =>
    Array.from(new Set(shelves.value.map((shelf) => shelf.room))).sort()
  )

  /** 某窖位上的在窖段 */
  function segmentsOfShelf(shelfId: string): BatchSegment[] {
    return segmentStore.activeSegmentsByShelf[shelfId] ?? []
  }

  /** 某窖位上的批次（按段去重） */
  function batchesOfShelf(shelfId: string) {
    const ids = new Set(segmentsOfShelf(shelfId).map((segment) => segment.batchId))
    return milkStore.batches.filter((batch) => ids.has(batch.id))
  }

  /** 占用率：以「在窖段块数合计」为准（segmentStore.occupiedBlocksByShelf 为唯一口径） */
  const occupancies = computed<ShelfOccupancy[]>(() =>
    shelves.value.map((shelf) => {
      const bySegments = segmentStore.occupiedBlocksByShelf[shelf.id] ?? 0
      // 兜底取 stored.occupied 的较大值，避免段表订阅尚未刷新或历史脏数据导致占用率偏低
      const occupied = Math.max(shelf.occupied ?? 0, bySegments)
      const free = Math.max(0, shelf.capacity - occupied)
      const percent = shelf.capacity === 0 ? 100 : Math.round((occupied / shelf.capacity) * 100)
      return {
        shelfId: shelf.id,
        capacity: shelf.capacity,
        occupied,
        free,
        percent,
        full: free === 0,
        tight: percent >= 85
      }
    })
  )

  const occupancyMap = computed<Record<string, ShelfOccupancy>>(() => {
    const map: Record<string, ShelfOccupancy> = {}
    occupancies.value.forEach((item) => {
      map[item.shelfId] = item
    })
    return map
  })

  /** 当前选中库房下的窖位 */
  const roomShelves = computed<Shelf[]>(() =>
    currentRoom.value ? shelves.value.filter((shelf) => shelf.room === currentRoom.value) : shelves.value
  )

  const filteredShelves = computed<Shelf[]>(() =>
    shelves.value.filter((shelf) => {
      if (currentRoom.value && shelf.room !== currentRoom.value) return false
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${shelf.room}${shelf.rackNo}${shelf.layerNo}${shelf.tempZone}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.rooms.length > 0 && !filter.value.rooms.includes(shelf.room)) return false
      if (filter.value.tempZones.length > 0 && !filter.value.tempZones.includes(shelf.tempZone)) {
        return false
      }
      return true
    })
  )

  const totalCapacity = computed(() =>
    filteredShelves.value.reduce((sum, shelf) => sum + shelf.capacity, 0)
  )
  const totalOccupied = computed(() =>
    filteredShelves.value.reduce(
      (sum, shelf) => sum + (occupancyMap.value[shelf.id]?.occupied ?? shelf.occupied ?? 0),
      0
    )
  )
  const occupancyPercent = computed(() =>
    totalCapacity.value === 0 ? 0 : Math.round((totalOccupied.value / totalCapacity.value) * 100)
  )
  const fullShelfCount = computed(
    () => filteredShelves.value.filter((shelf) => occupancyMap.value[shelf.id]?.full).length
  )
  /** 未完成分段落位的批次（没有任何在窖段），可分配窖位 */
  const unassignedBatches = computed(() =>
    milkStore.batches.filter(
      (batch) =>
        !segmentStore.summaryOf(batch.id).assigned &&
        batch.state !== '已出库' &&
        batch.state !== '报废'
    )
  )

  function occupancyOf(shelfId: string | null): ShelfOccupancy | null {
    if (!shelfId) return null
    return occupancyMap.value[shelfId] ?? null
  }

  function shelfLabel(shelfId: string | null): string {
    if (!shelfId) return '未上架'
    const shelf = shelves.value.find((item) => item.id === shelfId)
    if (!shelf) return '窖位已删除'
    return `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层`
  }

  function setCurrentRoom(room: string): void {
    currentRoom.value = room
    writeUiPrefs({ ...readUiPrefs(), lastRoom: room || null })
  }

  function setCurrentShelf(id: string | null): void {
    currentShelfId.value = id
  }

  function patchFilter(patch: Partial<ShelfFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyShelfFilter()
  }

  async function createShelf(payload: NewShelfInput): Promise<Shelf> {
    return shelvesTable.create({ ...payload }, 'shelf')
  }

  async function updateShelf(id: string, patch: Partial<Shelf>): Promise<void> {
    await shelvesTable.update(id, patch)
  }

  /**
   * 级联删除：窖位 → 其上在窖段全部置为未落位（shelfId=null，段保留），
   * 随后重算受影响窖位占用。批次与段记录本身保留。
   */
  async function removeShelf(id: string): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', [db.shelves, db.segments, db.batches], async () => {
      const hosted = await db.segments.where('shelfId').equals(id).toArray()
      const batchIds = new Set(hosted.map((segment) => segment.batchId))
      for (const segment of hosted) {
        await db.segments.update(segment.id, { shelfId: null, updatedAt: now })
      }
      await db.shelves.delete(id)
      for (const batchId of batchIds) {
        const first = (await db.segments.where('batchId').equals(batchId).toArray())
          .filter((segment) => segment.state === '在窖')
          .sort((a, b) => a.seq - b.seq)[0]
        await db.batches.update(batchId, { shelfId: first?.shelfId ?? null, updatedAt: now })
      }
    })
    if (currentShelfId.value === id) currentShelfId.value = null
  }

  /**
   * 快速上架（兼容旧入口）：为整批建立唯一一个段（全部入库重量、1 块）落到指定窖位。
   * 已有在窖段的批次请走「分段落位」；容量校验在 segmentStore 的事务内完成，
   * 冲突时返回最新余量，保证两段不会共占一格。
   */
  async function assignBatch(batchId: string, shelfId: string): Promise<ShelfAssignResult> {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试' }
    if (batch.state === '已出库' || batch.state === '报废') {
      return { ok: false, message: `批次状态为「${batch.state}」，不能再上架` }
    }
    const existing = segmentStore.activeSegmentsOf(batchId)
    if (existing.length > 0) {
      return { ok: false, message: '该批次已分段落位，如需调整请使用「分段落位」' }
    }
    const result = await segmentStore.saveLayout(batchId, [
      {
        key: `new_${Date.now()}`,
        seq: 1,
        blockCount: 1,
        weightKg: batch.weightKg,
        shelfId
      }
    ])
    return result.ok
      ? { ...result, message: `已上架至 ${shelfLabel(shelfId)}：${result.message}` }
      : result
  }

  /** 下架：整批在窖段全部移除并释放窖位余量 */
  async function releaseBatch(batchId: string): Promise<ShelfAssignResult> {
    return segmentStore.releaseAll(batchId)
  }

  /** 按温区阈值给出窖位可用性说明，用于卡片提示 */
  function zoneOptions(): TempZone[] {
    return TEMP_ZONES
  }

  return {
    shelves,
    loading,
    ready,
    error,
    filter,
    currentRoom,
    currentShelfId,
    roomOptions,
    occupancies,
    occupancyMap,
    roomShelves,
    filteredShelves,
    totalCapacity,
    totalOccupied,
    occupancyPercent,
    fullShelfCount,
    unassignedBatches,
    occupancyOf,
    shelfLabel,
    batchesOfShelf,
    segmentsOfShelf,
    setCurrentRoom,
    setCurrentShelf,
    patchFilter,
    resetFilter,
    createShelf,
    updateShelf,
    removeShelf,
    assignBatch,
    releaseBatch,
    zoneOptions
  }
})

export type ShelfStore = ReturnType<typeof useShelfStore>
