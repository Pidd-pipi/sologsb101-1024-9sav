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
import type { Batch } from '@/types/batch'
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
 * 熟成库窖位 store：维护货架列表、占用率派生值、当前选中库房与上架分配。
 * 占用率以「分段数」为准（每段落位占 1 块容量），occupied 字段仅作缓存。
 * 落位 / 挪窝的并发控制由 segmentStore 在事务内完成。
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

  /** 某窖位上的分段（按段号排序） */
  function segmentsOfShelf(shelfId: string) {
    return segmentStore.segmentsOfShelf(shelfId)
  }

  /** 某窖位上的批次（按分段反查，去重） */
  function batchesOfShelf(shelfId: string): Batch[] {
    const batchIds = new Set(segmentsOfShelf(shelfId).map((segment) => segment.batchId))
    return milkStore.batches.filter((batch) => batchIds.has(batch.id))
  }

  /** 占用率：以「实际挂接的分段数」与 occupied 字段中的较大者为准，避免脏数据导致占用率偏低 */
  const occupancies = computed<ShelfOccupancy[]>(() =>
    shelves.value.map((shelf) => {
      const hosted = segmentsOfShelf(shelf.id).length
      const occupied = Math.max(shelf.occupied, hosted)
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
      (sum, shelf) => sum + (occupancyMap.value[shelf.id]?.occupied ?? shelf.occupied),
      0
    )
  )
  const occupancyPercent = computed(() =>
    totalCapacity.value === 0 ? 0 : Math.round((totalOccupied.value / totalCapacity.value) * 100)
  )
  const fullShelfCount = computed(
    () => filteredShelves.value.filter((shelf) => occupancyMap.value[shelf.id]?.full).length
  )
  /** 未上架的分段（可分配窖位） */
  const unassignedSegments = computed(() => segmentStore.unplacedSegments)
  /** 仍有未上架分段的批次 */
  const unassignedBatches = computed<Batch[]>(() => {
    const ids = new Set(unassignedSegments.value.map((segment) => segment.batchId))
    return milkStore.batches.filter(
      (batch) => ids.has(batch.id) && batch.state !== '已出库' && batch.state !== '报废'
    )
  })

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

  /** 级联删除：窖位 → 其上分段全部置为未上架（批次与子记录保留），并重算批次主窖位 */
  async function removeShelf(id: string): Promise<void> {
    await db.transaction('rw', [db.shelves, db.segments, db.batches], async () => {
      const hosted = await db.segments.where('shelfId').equals(id).toArray()
      const batchIds = Array.from(new Set(hosted.map((segment) => segment.batchId)))
      for (const segment of hosted) {
        await db.segments.update(segment.id, { shelfId: null, updatedAt: Date.now() })
      }
      await db.shelves.delete(id)
      // 重算受影响批次的主窖位（首段所在窖位）
      for (const batchId of batchIds) {
        const list = await db.segments.where('batchId').equals(batchId).toArray()
        const placed = list
          .filter((segment) => segment.shelfId !== null)
          .sort((a, b) => a.blockNo - b.blockNo)
        await db.batches.update(batchId, {
          shelfId: placed[0]?.shelfId ?? null,
          updatedAt: Date.now()
        })
      }
    })
    if (currentShelfId.value === id) currentShelfId.value = null
  }

  /**
   * 上架：把批次的首个未上架分段放到指定窖位。
   * 批次若有多个未上架分段，返回提示引导用分段落位。
   */
  async function assignBatch(batchId: string, shelfId: string): Promise<ShelfAssignResult> {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试' }
    if (batch.state === '已出库' || batch.state === '报废') {
      return { ok: false, message: `批次状态为「${batch.state}」，不能再上架` }
    }
    const pending = segmentStore.segmentsOfBatch(batchId).filter((segment) => segment.shelfId === null)
    if (pending.length === 0) return { ok: false, message: '该批次已全部落位' }
    if (pending.length > 1) {
      return {
        ok: false,
        message: `该批有 ${pending.length} 个待落位分段，请用「分段落位」逐块选择窖位`
      }
    }
    return segmentStore.placeSegment(pending[0].id, shelfId, pending[0].rev)
  }

  /** 下架：释放该批次全部已落位分段 */
  async function releaseBatch(batchId: string): Promise<ShelfAssignResult> {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试' }
    const released = await segmentStore.releaseBatchSegments(batchId)
    if (released === 0) return { ok: false, message: '该批次尚未上架' }
    return { ok: true, message: `已下架，释放 ${released} 段余量` }
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
    unassignedSegments,
    unassignedBatches,
    occupancyOf,
    shelfLabel,
    segmentsOfShelf,
    batchesOfShelf,
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
