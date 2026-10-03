<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Edit, Plus, Position } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, {
  type FilterModel,
  type FilterSelectConfig
} from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useSegmentStore } from '@/stores/segmentStore'
import { TEMP_ZONES, createEmptyShelfFilter, type Shelf, type TempZone } from '@/types/shelf'
import { splitWeightEvenly, type Segment } from '@/types/segment'
import { TEMP_RANGE, ZONE_COLOR } from '@/utils/temperature'

const shelfStore = useShelfStore()
const milkStore = useMilkStore()
const segmentStore = useSegmentStore()

const {
  shelves,
  ready,
  filter,
  currentRoom,
  occupancyMap,
  totalCapacity,
  totalOccupied,
  occupancyPercent,
  fullShelfCount,
  unassignedSegments,
  roomOptions,
  filteredShelves,
  roomShelves
} = storeToRefs(shelfStore)

const shelfFormRef = ref<FormInstance>()
const placeFormRef = ref<FormInstance>()
const splitFormRef = ref<FormInstance>()
const moveFormRef = ref<FormInstance>()
const shelfDialogVisible = ref(false)
const placeDialogVisible = ref(false)
const splitDialogVisible = ref(false)
const moveDialogVisible = ref(false)
const editingShelfId = ref<string | null>(null)
const movingSegment = ref<Segment | null>(null)

const moveForm = reactive({
  shelfId: ''
})

const shelfForm = reactive({
  room: '',
  rackNo: '',
  layerNo: 1,
  tempZone: '中温区' as TempZone,
  capacity: 8,
  occupied: 0
})

const placeForm = reactive({
  segmentId: '',
  shelfId: ''
})

const splitForm = reactive({
  batchId: '',
  blockCount: 2
})

const shelfRules: FormRules = {
  room: [{ required: true, message: '请填写库房名称', trigger: 'blur' }],
  rackNo: [{ required: true, message: '请填写货架号', trigger: 'blur' }],
  layerNo: [{ required: true, message: '请填写层号', trigger: 'change' }],
  tempZone: [{ required: true, message: '请选择温区', trigger: 'change' }],
  capacity: [{ required: true, message: '请填写可放块数', trigger: 'blur' }]
}

const placeRules: FormRules = {
  segmentId: [{ required: true, message: '请选择要落位的分段', trigger: 'change' }],
  shelfId: [{ required: true, message: '请选择目标窖位', trigger: 'change' }]
}

const splitRules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  blockCount: [{ required: true, message: '请填写块数', trigger: 'blur' }]
}

const shelfFilterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  rooms: [...filter.value.rooms],
  tempZones: [...filter.value.tempZones]
}))

const shelfSelects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'rooms',
    label: '库房',
    queryKey: 'room',
    options: roomOptions.value.map((room) => ({
      label: room,
      value: room,
      count: shelves.value.filter((shelf) => shelf.room === room).length
    }))
  },
  {
    key: 'tempZones',
    label: '温区',
    queryKey: 'zone',
    options: TEMP_ZONES.map((zone) => ({
      label: zone,
      value: zone,
      count: shelves.value.filter((shelf) => shelf.tempZone === zone).length
    }))
  }
])

const filteredCapacity = computed(() =>
  filteredShelves.value.reduce((sum, shelf) => sum + shelf.capacity, 0)
)
const filteredOccupied = computed(() =>
  filteredShelves.value.reduce(
    (sum, shelf) => sum + (occupancyMap.value[shelf.id]?.occupied ?? shelf.occupied),
    0
  )
)
const filteredPercent = computed(() =>
  filteredCapacity.value === 0
    ? 0
    : Math.round((filteredOccupied.value / filteredCapacity.value) * 100)
)

/** 可分段落位的批次（未终态） */
const splittableBatches = computed(() =>
  milkStore.batches.filter((batch) => batch.state !== '已出库' && batch.state !== '报废')
)

/** 拆分预览：各段重量与合计 */
const splitPreview = computed(() => {
  const batch = milkStore.batches.find((item) => item.id === splitForm.batchId)
  if (!batch) return { weights: [] as number[], total: 0, balanced: false }
  const weights = splitWeightEvenly(batch.weightKg, splitForm.blockCount)
  const total = Math.round(weights.reduce((sum, w) => sum + w, 0) * 10) / 10
  return { weights, total, balanced: Math.abs(total - batch.weightKg) <= 0.05 }
})

function zoneRangeText(zone: TempZone): string {
  const range = TEMP_RANGE[zone]
  return `${range.min} - ${range.max} ℃`
}

function zoneColor(zone: TempZone): string {
  return ZONE_COLOR[zone]
}

function applyFilter(model: FilterModel): void {
  shelfStore.patchFilter({
    keyword: model.keyword,
    rooms: (model.rooms as string[]) ?? [],
    tempZones: (model.tempZones as TempZone[]) ?? []
  })
}

function resetFilter(): void {
  shelfStore.filter = createEmptyShelfFilter()
  shelfStore.setCurrentRoom('')
}

function resetShelfForm(): void {
  shelfForm.room = currentRoom.value || roomOptions.value[0] || '一号熟成库'
  shelfForm.rackNo = ''
  shelfForm.layerNo = 1
  shelfForm.tempZone = '中温区'
  shelfForm.capacity = 8
  shelfForm.occupied = 0
}

function openShelfDialog(shelf?: Shelf): void {
  if (shelf) {
    editingShelfId.value = shelf.id
    shelfForm.room = shelf.room
    shelfForm.rackNo = shelf.rackNo
    shelfForm.layerNo = shelf.layerNo
    shelfForm.tempZone = shelf.tempZone
    shelfForm.capacity = shelf.capacity
    shelfForm.occupied = shelf.occupied
  } else {
    editingShelfId.value = null
    resetShelfForm()
  }
  shelfDialogVisible.value = true
}

async function submitShelf(): Promise<void> {
  if (!shelfFormRef.value) return
  const valid = await shelfFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (editingShelfId.value) {
    await shelfStore.updateShelf(editingShelfId.value, { ...shelfForm })
    ElMessage.success('窖位已更新')
  } else {
    const created = await shelfStore.createShelf({ ...shelfForm })
    shelfStore.setCurrentShelf(created.id)
    ElMessage.success(`窖位已新建：${created.room} ${created.rackNo} 第 ${created.layerNo} 层`)
  }
  shelfDialogVisible.value = false
}

async function removeShelf(shelf: Shelf): Promise<void> {
  const hosted = shelfStore.segmentsOfShelf(shelf.id).length
  try {
    await ElMessageBox.confirm(
      `删除窖位「${shelfStore.shelfLabel(shelf.id)}」后，其上 ${hosted} 个分段会被置为未上架（批次与子记录保留）。是否继续？`,
      '删除窖位确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await shelfStore.removeShelf(shelf.id)
  ElMessage.success('窖位已删除，关联分段已置为未上架')
}

function openSplitDialog(): void {
  splitForm.batchId = splittableBatches.value[0]?.id ?? ''
  splitForm.blockCount = 2
  splitDialogVisible.value = true
}

async function submitSplit(): Promise<void> {
  if (!splitFormRef.value) return
  const valid = await splitFormRef.value.validate().catch(() => false)
  if (!valid) return
  const batch = milkStore.batches.find((item) => item.id === splitForm.batchId)
  if (!batch) return
  const existing = segmentStore.segmentsOfBatch(batch.id)
  const placed = existing.filter((segment) => segment.shelfId !== null).length
  if (placed > 0) {
    try {
      await ElMessageBox.confirm(
        `该批次已有 ${placed} 个分段落位，重新拆分会释放这些分段并按 ${splitForm.blockCount} 块重新均分重量。是否继续？`,
        '重新拆分确认',
        { type: 'warning', confirmButtonText: '确认拆分', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }
  const count = await segmentStore.splitBatch(batch.id, splitForm.blockCount)
  ElMessage.success(`已按 ${count} 段拆分，各段重量合计 ${batch.weightKg}kg（守恒）`)
  splitDialogVisible.value = false
}

function openPlaceDialog(shelfId?: string): void {
  placeForm.segmentId = unassignedSegments.value[0]?.id ?? ''
  placeForm.shelfId =
    shelfId ??
    filteredShelves.value.find((shelf) => (occupancyMap.value[shelf.id]?.free ?? 0) > 0)?.id ??
    ''
  placeDialogVisible.value = true
}

const placePreview = computed(() => {
  const occupancy = occupancyMap.value[placeForm.shelfId]
  if (!occupancy) return null
  return {
    ...occupancy,
    label: shelfStore.shelfLabel(placeForm.shelfId),
    after: Math.min(occupancy.capacity, occupancy.occupied + 1),
    afterPercent:
      occupancy.capacity === 0
        ? 100
        : Math.round((Math.min(occupancy.capacity, occupancy.occupied + 1) / occupancy.capacity) * 100)
  }
})

async function submitPlace(): Promise<void> {
  if (!placeFormRef.value) return
  const valid = await placeFormRef.value.validate().catch(() => false)
  if (!valid) return
  const segment = segmentStore.segmentMap[placeForm.segmentId]
  const result = await segmentStore.placeSegment(
    placeForm.segmentId,
    placeForm.shelfId,
    segment?.rev
  )
  if (result.ok) {
    ElMessage.success(result.message)
    placeDialogVisible.value = false
  } else {
    ElMessage.warning(result.message)
  }
}

async function releaseSegment(segment: Segment): Promise<void> {
  const result = await segmentStore.releaseSegment(segment.id)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

async function placeOnShelf(shelfId: string, segmentId: string): Promise<void> {
  const segment = segmentStore.segmentMap[segmentId]
  const result = await segmentStore.placeSegment(segmentId, shelfId, segment?.rev)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

/** 已落位分段（跨窖位），用于挪窝 / 下架 */
const placedSegments = computed(() =>
  segmentStore.segments
    .filter((segment) => segment.shelfId !== null)
    .sort((a, b) => a.batchId.localeCompare(b.batchId) || a.blockNo - b.blockNo)
)

function openMoveDialog(segment: Segment): void {
  movingSegment.value = segment
  moveForm.shelfId = segment.shelfId ?? ''
  moveDialogVisible.value = true
}

async function submitMove(): Promise<void> {
  if (!movingSegment.value) return
  if (!moveForm.shelfId) {
    ElMessage.warning('请选择目标窖位')
    return
  }
  const result = await segmentStore.moveSegment(
    movingSegment.value.id,
    moveForm.shelfId,
    movingSegment.value.rev
  )
  if (result.ok) {
    ElMessage.success(result.message)
    moveDialogVisible.value = false
  } else {
    ElMessage.warning(result.message)
  }
}

function segmentsOnShelf(shelfId: string) {
  return shelfStore.segmentsOfShelf(shelfId)
}

function segmentOptionLabel(segment: Segment): string {
  const batch = segmentStore.batchOf(segment.batchId)
  if (!batch) return `第 ${segment.blockNo} 段 · ${segment.weightKg}kg`
  return `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt} · 第 ${segment.blockNo} 段（${segment.weightKg}kg）`
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>熟成库货架与窖位</h2>
        <p>按库房 / 货架 / 层号维护窖位；一批可按块拆到多个窖位，每段落位占 1 块容量，重量合计守恒。</p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openShelfDialog()">新建窖位</el-button>
        <el-button :icon="Position" @click="openSplitDialog()">分段落位</el-button>
        <el-button
          :icon="Position"
          type="success"
          :disabled="unassignedSegments.length === 0"
          @click="openPlaceDialog()"
        >
          落位分配
        </el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="窖位总数" :value="shelves.length" suffix="个" icon="Grid" />
      <StatBadge label="可放块数" :value="totalCapacity" suffix="块" icon="Files" tone="info" />
      <StatBadge label="已占块数" :value="totalOccupied" suffix="块" icon="Box" tone="warning" />
      <StatBadge
        label="整体占用率"
        :value="occupancyPercent"
        suffix="%"
        icon="PieChart"
        :percent="occupancyPercent"
        show-percent
        tone="primary"
      />
      <StatBadge label="已满窖位" :value="fullShelfCount" suffix="个" icon="WarningFilled" tone="danger" />
      <StatBadge
        label="待落位分段"
        :value="unassignedSegments.length"
        suffix="段"
        icon="AlarmClock"
        tone="success"
      />
    </div>

    <FilterBar
      :model-value="shelfFilterModel"
      :selects="shelfSelects"
      keyword-placeholder="搜索库房 / 货架号 / 温区"
      @update:model-value="applyFilter"
      @reset="resetFilter"
    >
      <template #extra>
        <span class="filter-label">当前库房</span>
        <el-select
          :model-value="currentRoom"
          clearable
          placeholder="全部库房"
          class="room-select"
          @update:model-value="(value: string) => shelfStore.setCurrentRoom(value ?? '')"
        >
          <el-option v-for="room in roomOptions" :key="room" :label="room" :value="room" />
        </el-select>
      </template>
    </FilterBar>

    <div class="section-card">
      <div class="section-card__head">
        <h3>窖位看板（{{ filteredShelves.length }} / {{ shelves.length }}）</h3>
        <span class="muted">
          筛选结果占用率 {{ filteredPercent }}%（{{ filteredOccupied }} / {{ filteredCapacity }} 块）
        </span>
      </div>

      <EmptyPanel
        v-if="ready && filteredShelves.length === 0"
        title="还没有符合条件窖位"
        description="先按库房建立窖位（库房 + 货架号 + 层号 + 温区 + 可放块数），再把批次分段落位。"
        action-text="新建窖位"
        @action="openShelfDialog()"
      />

      <div v-else class="shelf-grid">
        <article v-for="shelf in filteredShelves" :key="shelf.id" class="shelf-card">
          <header class="shelf-card__head">
            <div>
              <h4>{{ shelf.room }} · {{ shelf.rackNo }}</h4>
              <p class="muted">第 {{ shelf.layerNo }} 层</p>
            </div>
            <span class="shelf-card__zone" :style="{ backgroundColor: zoneColor(shelf.tempZone) }">
              {{ shelf.tempZone }}
            </span>
          </header>

          <div class="shelf-card__meta">
            <span class="mono">
              {{ occupancyMap[shelf.id]?.occupied ?? shelf.occupied }} / {{ shelf.capacity }} 块
            </span>
            <span class="muted">余量 {{ occupancyMap[shelf.id]?.free ?? shelf.capacity }} 块</span>
          </div>

          <el-progress
            :percentage="occupancyMap[shelf.id]?.percent ?? 0"
            :stroke-width="12"
            :color="
              occupancyMap[shelf.id]?.full
                ? '#c0392b'
                : occupancyMap[shelf.id]?.tight
                  ? '#d68910'
                  : '#1e8449'
            "
          />

          <p class="muted zone-range">适宜温度 {{ zoneRangeText(shelf.tempZone) }}</p>

          <div class="shelf-card__batches">
            <template v-if="segmentsOnShelf(shelf.id).length > 0">
              <el-tag
                v-for="segment in segmentsOnShelf(shelf.id)"
                :key="segment.id"
                type="success"
                effect="plain"
                closable
                @close="releaseSegment(segment)"
              >
                {{ segmentOptionLabel(segment) }}
              </el-tag>
            </template>
            <span v-else class="muted">暂无分段</span>
          </div>

          <footer class="shelf-card__actions">
            <el-button
              text
              type="primary"
              :icon="Position"
              :disabled="(occupancyMap[shelf.id]?.free ?? 0) <= 0 || unassignedSegments.length === 0"
              @click="openPlaceDialog(shelf.id)"
            >
              落位
            </el-button>
            <el-button text :icon="Edit" @click="openShelfDialog(shelf)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" @click="removeShelf(shelf)">删除</el-button>
          </footer>
        </article>
      </div>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>待落位分段</h3>
        <span class="muted">批次拆分后的未上架分段，选择窖位完成落位；余量不足时会提示并可重新选位</span>
      </div>
      <EmptyPanel
        v-if="unassignedSegments.length === 0"
        compact
        title="所有分段都已落位"
        description="新建批次或先拆分后再分配窖位。"
      />
      <el-table v-else :data="unassignedSegments" border stripe>
        <el-table-column label="批次" min-width="200">
          <template #default="{ row }">
            {{ segmentOptionLabel(row) }}
          </template>
        </el-table-column>
        <el-table-column label="段号" width="90">
          <template #default="{ row }">第 {{ row.blockNo }} 段</template>
        </el-table-column>
        <el-table-column prop="weightKg" label="重量 kg" width="100" />
        <el-table-column label="入库重量" width="110">
          <template #default="{ row }">
            {{ segmentStore.batchOf(row.batchId)?.weightKg ?? '—' }} kg
          </template>
        </el-table-column>
        <el-table-column label="选择窖位" min-width="260">
          <template #default="{ row }">
            <el-select
              :model-value="''"
              placeholder="选择窖位完成落位"
              style="width: 100%"
              @update:model-value="(value: string) => placeOnShelf(value, row.id)"
            >
              <el-option
                v-for="shelf in roomShelves.length > 0 ? roomShelves : shelves"
                :key="shelf.id"
                :label="`${shelfStore.shelfLabel(shelf.id)}（余 ${occupancyMap[shelf.id]?.free ?? 0} 块）`"
                :value="shelf.id"
                :disabled="(occupancyMap[shelf.id]?.free ?? 0) <= 0"
              />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>已落位分段（{{ placedSegments.length }}）</h3>
        <span class="muted">每段占 1 块容量；可挪窝到其他窖位或下架，重量与作业历史随段走</span>
      </div>
      <EmptyPanel
        v-if="placedSegments.length === 0"
        compact
        title="还没有已落位分段"
        description="在上方「待落位分段」表格选择窖位完成落位。"
      />
      <el-table v-else :data="placedSegments" border stripe>
        <el-table-column label="批次" min-width="220">
          <template #default="{ row }">{{ segmentOptionLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="段号" width="90">
          <template #default="{ row }">第 {{ row.blockNo }} 段</template>
        </el-table-column>
        <el-table-column prop="weightKg" label="重量 kg" width="100" />
        <el-table-column label="所在窖位" min-width="180">
          <template #default="{ row }">
            <el-tag type="success" effect="plain">{{ shelfStore.shelfLabel(row.shelfId) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" @click="openMoveDialog(row)">挪窝</el-button>
            <el-button text type="danger" @click="releaseSegment(row)">下架</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="shelfDialogVisible"
      :title="editingShelfId ? '编辑窖位' : '新建窖位'"
      width="560px"
      destroy-on-close
    >
      <el-form ref="shelfFormRef" :model="shelfForm" :rules="shelfRules" label-width="110px">
        <el-form-item label="库房" prop="room">
          <el-select
            v-model="shelfForm.room"
            filterable
            allow-create
            default-first-option
            placeholder="选择或输入库房名称"
            style="width: 100%"
          >
            <el-option v-for="room in roomOptions" :key="room" :label="room" :value="room" />
          </el-select>
        </el-form-item>
        <el-form-item label="货架号" prop="rackNo">
          <el-input v-model="shelfForm.rackNo" placeholder="如：A-01" clearable />
        </el-form-item>
        <el-form-item label="层号" prop="layerNo">
          <el-input-number v-model="shelfForm.layerNo" :min="1" :max="20" />
        </el-form-item>
        <el-form-item label="温区" prop="tempZone">
          <el-radio-group v-model="shelfForm.tempZone">
            <el-radio-button v-for="zone in TEMP_ZONES" :key="zone" :value="zone">
              {{ zone }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="可放块数" prop="capacity">
          <el-input-number v-model="shelfForm.capacity" :min="0" :max="200" />
        </el-form-item>
        <el-form-item label="已占块数" prop="occupied">
          <el-input-number v-model="shelfForm.occupied" :min="0" :max="shelfForm.capacity" />
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon>
          温区 {{ shelfForm.tempZone }} 的适宜温度为 {{ zoneRangeText(shelfForm.tempZone) }}，环境记录越界会自动标异常。
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="shelfDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitShelf">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="splitDialogVisible" title="分段落位：按块拆分批次" width="560px" destroy-on-close>
      <el-form ref="splitFormRef" :model="splitForm" :rules="splitRules" label-width="110px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="splitForm.batchId" filterable placeholder="选择批次" style="width: 100%">
            <el-option
              v-for="batch in splittableBatches"
              :key="batch.id"
              :label="`${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}（${batch.weightKg}kg）`"
              :value="batch.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="拆成块数" prop="blockCount">
          <el-input-number v-model="splitForm.blockCount" :min="1" :max="40" />
        </el-form-item>
        <el-alert
          v-if="splitPreview.weights.length > 0"
          :type="splitPreview.balanced ? 'success' : 'warning'"
          :closable="false"
          show-icon
        >
          <div>各段重量：{{ splitPreview.weights.map((w) => `${w}kg`).join('、') }}</div>
          <div>
            合计 {{ splitPreview.total }}kg
            <template v-if="splitPreview.balanced">
              = 入库重量 {{ segmentStore.batchOf(splitForm.batchId)?.weightKg }}kg（守恒）
            </template>
            <template v-else>
              ≠ 入库重量 {{ segmentStore.batchOf(splitForm.batchId)?.weightKg }}kg，请调整块数
            </template>
          </div>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="splitDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitSplit">拆分并生成待落位分段</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="placeDialogVisible" title="分段落位分配" width="580px" destroy-on-close>
      <el-form ref="placeFormRef" :model="placeForm" :rules="placeRules" label-width="110px">
        <el-form-item label="分段" prop="segmentId">
          <el-select v-model="placeForm.segmentId" filterable placeholder="选择待落位分段" style="width: 100%">
            <el-option
              v-for="segment in unassignedSegments"
              :key="segment.id"
              :label="segmentOptionLabel(segment)"
              :value="segment.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标窖位" prop="shelfId">
          <el-select v-model="placeForm.shelfId" filterable placeholder="选择窖位" style="width: 100%">
            <el-option
              v-for="shelf in shelves"
              :key="shelf.id"
              :label="`${shelfStore.shelfLabel(shelf.id)}（${shelf.tempZone} 余 ${occupancyMap[shelf.id]?.free ?? 0} 块）`"
              :value="shelf.id"
              :disabled="(occupancyMap[shelf.id]?.free ?? 0) <= 0"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert v-if="placePreview" :type="placePreview.full ? 'error' : 'success'" :closable="false" show-icon>
        {{ placePreview.label }}：当前 {{ placePreview.occupied }} / {{ placePreview.capacity }} 块，
        落位后 {{ placePreview.after }} / {{ placePreview.capacity }} 块（占用率 {{ placePreview.afterPercent }}%）
      </el-alert>
      <el-alert v-else type="warning" :closable="false" show-icon>
        请选择目标窖位，系统会实时校验余量；若被其他设备占满会提示重新选位。
      </el-alert>
      <template #footer>
        <el-button @click="placeDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPlace">确认落位</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="moveDialogVisible" title="分段挪窝" width="520px" destroy-on-close>
      <el-form ref="moveFormRef" :model="moveForm" label-width="110px">
        <el-form-item label="分段">
          <span v-if="movingSegment" class="muted">
            {{ segmentOptionLabel(movingSegment) }}
          </span>
        </el-form-item>
        <el-form-item label="目标窖位" required>
          <el-select v-model="moveForm.shelfId" filterable placeholder="选择窖位" style="width: 100%">
            <el-option
              v-for="shelf in shelves"
              :key="shelf.id"
              :label="`${shelfStore.shelfLabel(shelf.id)}（${shelf.tempZone} 余 ${occupancyMap[shelf.id]?.free ?? 0} 块）`"
              :value="shelf.id"
              :disabled="
                shelf.id === movingSegment?.shelfId ||
                (occupancyMap[shelf.id]?.free ?? 0) <= 0
              "
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" show-icon>
        挪窝只移动该分段，转架与环境记录随段保留；若目标窖位被其他设备占满会提示重新选位。
      </el-alert>
      <template #footer>
        <el-button @click="moveDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitMove">确认挪窝</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.shelf-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid #e7dfd0;
  border-radius: 12px;
  background: #fffdf8;
}

.shelf-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.shelf-card__head h4 {
  margin: 0;
  font-size: 15px;
}

.shelf-card__zone {
  padding: 2px 10px;
  border-radius: 999px;
  color: #ffffff;
  font-size: 12px;
  white-space: nowrap;
}

.shelf-card__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13px;
}

.zone-range {
  margin: 0;
  font-size: 12px;
}

.shelf-card__batches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
}

.shelf-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border-top: 1px dashed #e7dfd0;
  padding-top: 8px;
}

.filter-label {
  margin-right: 6px;
  font-size: 13px;
  color: #6b6257;
}

.room-select {
  width: 170px;
}
</style>
