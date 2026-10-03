<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useSegmentStore } from '@/stores/segmentStore'
import { round3 } from '@/utils/weight'
import { WEIGHT_EPSILON, type SegmentDraft } from '@/types/segment'
import type { Batch } from '@/types/batch'

const props = defineProps<{
  modelValue: boolean
  batch: Batch | null
}>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'saved'): void
}>()

const milkStore = useMilkStore()
const shelfStore = useShelfStore()
const segmentStore = useSegmentStore()

const drafts = reactive<SegmentDraft[]>([])
const conflict = ref<string>('')
const saving = ref(false)

function resetDrafts(): void {
  drafts.splice(0, drafts.length)
  conflict.value = ''
  if (!props.batch) return
  const active = segmentStore.activeSegmentsOf(props.batch.id)
  if (active.length > 0) {
    active.forEach((segment) => {
      drafts.push({
        key: segment.id,
        seq: segment.seq,
        blockCount: segment.blockCount,
        weightKg: segment.weightKg,
        shelfId: segment.shelfId
      })
    })
  } else {
    drafts.push({
      key: `new_${Date.now()}`,
      seq: 1,
      blockCount: 1,
      weightKg: props.batch.weightKg,
      shelfId: null
    })
  }
}

watch(
  () => [props.modelValue, props.batch?.id],
  ([visible]) => {
    if (visible) resetDrafts()
  }
)

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const batchLabel = computed(() => {
  if (!props.batch) return ''
  return `${milkStore.milkNameOf(props.batch.milkId)} · ${props.batch.cheeseType} ${props.batch.curdedAt}`
})

const keptDrafts = computed(() => drafts.filter((draft) => draft.shelfId))
const totalBlocks = computed(() =>
  keptDrafts.value.reduce((sum, draft) => sum + Math.max(0, draft.blockCount || 0), 0)
)
const totalWeight = computed(() =>
  round3(keptDrafts.value.reduce((sum, draft) => sum + (draft.weightKg || 0), 0))
)
const weightDelta = computed(() =>
  props.batch ? round3(totalWeight.value - props.batch.weightKg) : 0
)
const balanced = computed(() => Math.abs(weightDelta.value) <= WEIGHT_EPSILON)

/** 窖位选项是否因容量不足而禁用（排除当前行自身，避免把本段块数重复计算一次） */
function shelfOptionDisabled(shelfId: string, row: SegmentDraft): boolean {
  const occupancy = shelfStore.occupancyMap[shelfId]
  if (!occupancy) return true
  // 预占时排除当前行自身，避免把当前段块数重复计算一次
  const plannedOther = keptDrafts.value
    .filter((draft) => draft !== row && draft.shelfId === shelfId)
    .reduce((sum, draft) => sum + draft.blockCount, 0)
  return occupancy.occupied + plannedOther + Math.max(1, row.blockCount || 0) > occupancy.capacity
}

function addRow(): void {
  if (!props.batch) return
  drafts.push({
    key: `new_${Date.now()}_${drafts.length}`,
    seq: drafts.length + 1,
    blockCount: 1,
    weightKg: 0,
    shelfId: null
  })
}

function removeRow(index: number): void {
  drafts.splice(index, 1)
  drafts.forEach((draft, i) => {
    draft.seq = i + 1
  })
  conflict.value = ''
}

async function submit(): Promise<void> {
  if (!props.batch) return
  if (keptDrafts.value.length === 0) {
    ElMessage.warning('请至少为一个段选择窖位')
    return
  }
  if (!balanced.value) {
    ElMessage.warning(
      `各段重量合计 ${totalWeight.value}kg，需等于入库重量 ${props.batch.weightKg}kg（当前差 ${weightDelta.value}kg）`
    )
    return
  }
  saving.value = true
  try {
    const result = await segmentStore.saveLayout(
      props.batch.id,
      drafts.map((draft, index) => ({ ...draft, seq: index + 1 }))
    )
    if (!result.ok) {
      conflict.value = result.message
      ElMessage.warning('保存被拒绝：窖位余量已变化，请看到最新余量后重新选位')
      return
    }
    ElMessage.success(result.message)
    conflict.value = ''
    visible.value = false
    emit('saved')
  } finally {
    saving.value = false
  }
}

async function releaseAll(): Promise<void> {
  if (!props.batch) return
  const result = await segmentStore.releaseAll(props.batch.id)
  if (result.ok) {
    ElMessage.success(result.message)
    visible.value = false
    emit('saved')
  } else {
    ElMessage.warning(result.message)
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="分段落位" width="760px" destroy-on-close>
    <div v-if="batch" class="layout-head">
      <strong>{{ batchLabel }}</strong>
      <span class="muted">入库重量 {{ batch.weightKg }}kg · 同一窖位容量不足时保存会被拒绝并提示最新余量</span>
    </div>

    <el-table :data="drafts" border size="small" class="layout-table">
      <el-table-column label="段号" width="64" align="center">
        <template #default="{ $index }">{{ $index + 1 }}</template>
      </el-table-column>
      <el-table-column label="块数" width="130">
        <template #default="{ row }">
          <el-input-number v-model="row.blockCount" :min="1" :max="60" :step="1" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="重量 kg" width="150">
        <template #default="{ row }">
          <el-input-number
            v-model="row.weightKg"
            :min="0.05"
            :max="200"
            :step="0.1"
            :precision="3"
            size="small"
          />
        </template>
      </el-table-column>
      <el-table-column label="落位窖位" min-width="280">
        <template #default="{ row }">
          <el-select
            v-model="row.shelfId"
            placeholder="选择窖位（留空=不落位）"
            clearable
            size="small"
            style="width: 100%"
            @change="conflict = ''"
          >
            <el-option
              v-for="shelf in shelfStore.shelves"
              :key="shelf.id"
              :label="`${shelfStore.shelfLabel(shelf.id)}（${shelf.tempZone} 余 ${shelfStore.occupancyMap[shelf.id]?.free ?? 0} 块）`"
              :value="shelf.id"
              :disabled="shelfOptionDisabled(shelf.id, row)"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="80" align="center">
        <template #default="{ $index }">
          <el-button text type="danger" :icon="Delete" @click="removeRow($index)" />
        </template>
      </el-table-column>
    </el-table>

    <div class="layout-actions">
      <el-button text type="primary" :icon="Plus" @click="addRow">增加一段</el-button>
      <div class="layout-summary">
        <el-tag type="info" effect="plain">共 {{ keptDrafts.length }} 段 / {{ totalBlocks }} 块</el-tag>
        <el-tag :type="balanced ? 'success' : 'danger'" effect="dark">
          重量合计 {{ totalWeight }}kg / 入库 {{ batch?.weightKg }}kg
          {{ balanced ? '· 守恒' : `· 差 ${weightDelta}kg` }}
        </el-tag>
      </div>
    </div>

    <el-alert
      v-if="keptDrafts.length > 0"
      :closable="false"
      show-icon
      class="layout-alert"
      :type="balanced ? 'success' : 'warning'"
      :title="balanced ? '各段重量合计等于入库重量，可以保存' : '请调整各段重量，使合计等于入库重量'"
    />
    <el-alert
      v-if="conflict"
      :closable="false"
      show-icon
      type="error"
      class="layout-alert"
      :title="conflict"
    />

    <template #footer>
      <el-button @click="releaseAll" type="warning" plain>全部下架</el-button>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!balanced" @click="submit">
        保存分段落位
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.layout-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.layout-table {
  margin-bottom: 10px;
}

.layout-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.layout-summary {
  display: flex;
  gap: 8px;
}

.layout-alert {
  margin-top: 10px;
}
</style>
