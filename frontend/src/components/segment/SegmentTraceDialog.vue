<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useSegmentStore } from '@/stores/segmentStore'
import { useTurningStore } from '@/stores/turningStore'
import { useTastingStore } from '@/stores/tastingStore'
import { db } from '@/utils/db'
import type { Batch } from '@/types/batch'
import type { Environment } from '@/types/environment'
import type { Tasting } from '@/types/tasting'

const props = defineProps<{
  modelValue: boolean
  batch: Batch | null
}>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const milkStore = useMilkStore()
const shelfStore = useShelfStore()
const segmentStore = useSegmentStore()
const turningStore = useTurningStore()
const tastingStore = useTastingStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const batchLabel = computed(() => {
  if (!props.batch) return ''
  return `${milkStore.milkNameOf(props.batch.milkId)} · ${props.batch.cheeseType} ${props.batch.curdedAt}`
})

const segmentRows = computed(() => (props.batch ? segmentStore.segmentsOf(props.batch.id) : []))
const summary = computed(() => (props.batch ? segmentStore.summaryOf(props.batch.id) : null))

/** 转架历史：该批次全部作业按时间倒序，标注携带段与迁移前后窖位 */
const turningHistory = computed(() =>
  props.batch
    ? turningStore.turnings
        .filter((turning) => turning.batchId === props.batch?.id)
        .slice()
        .sort((a, b) => {
          const byApplied = (b.appliedAt ?? 0) - (a.appliedAt ?? 0)
          if (byApplied !== 0) return byApplied
          return b.doneAt.localeCompare(a.doneAt)
        })
    : []
)

const envRecords = ref<Environment[]>([])
const tastings = ref<Tasting[]>([])

watch(
  () => [props.modelValue, props.batch?.id] as const,
  async ([visibleNow, batchId]) => {
    if (!visibleNow || !batchId) return
    const [envs, tastingRows] = await Promise.all([
      db.environments.where('batchId').equals(batchId).toArray(),
      db.tastings.where('batchId').equals(batchId).toArray()
    ])
    envRecords.value = envs.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    tastings.value = tastingRows.sort((a, b) => b.outAt.localeCompare(a.outAt))
  },
  { immediate: true }
)

const tastingScore = computed(() => tastingStore.scoreOf(props.batch?.id ?? ''))

function stateTagType(state: string): 'success' | 'info' | 'warning' {
  if (state === '在窖') return 'success'
  if (state === '已出库') return 'info'
  return 'warning'
}

function segmentLabel(ids: string[]): string {
  if (ids.length === 0) return '整批'
  return ids
    .map((id) => {
      const segment = segmentStore.segmentById(id)
      return segment ? `段${segment.seq}（${segment.blockCount}块/${segment.weightKg}kg）` : '段已删除'
    })
    .join('、')
}
</script>

<template>
  <el-dialog v-model="visible" title="分段与转架档案" width="860px" destroy-on-close>
    <div v-if="batch" class="trace">
      <div class="trace__head">
        <strong>{{ batchLabel }}</strong>
        <span class="muted">入库 {{ batch.weightKg }}kg · 状态 {{ batch.state }}</span>
      </div>

      <el-descriptions :column="4" border size="small" class="trace__desc">
        <el-descriptions-item label="在窖段">{{ summary?.placedSegmentCount ?? 0 }} 段</el-descriptions-item>
        <el-descriptions-item label="在窖块数">{{ summary?.totalBlocks ?? 0 }} 块</el-descriptions-item>
        <el-descriptions-item label="占用窖位">{{ summary?.shelfCount ?? 0 }} 个</el-descriptions-item>
        <el-descriptions-item label="在窖重量">
          <span :class="{ imbalance: summary && !summary.weightBalanced && (summary.placedSegmentCount ?? 0) > 0 }">
            {{ summary?.totalWeightKg ?? 0 }}kg
          </span>
        </el-descriptions-item>
      </el-descriptions>

      <h4>分段明细（重量合计 {{ summary?.totalWeightKg ?? 0 }}kg / 入库 {{ batch.weightKg }}kg）</h4>
      <el-table :data="segmentRows" border size="small">
        <el-table-column label="段号" width="64" align="center" prop="seq" />
        <el-table-column label="块数" width="80" align="center">
          <template #default="{ row }">{{ row.blockCount }} 块</template>
        </el-table-column>
        <el-table-column label="重量" width="110">
          <template #default="{ row }">{{ row.weightKg }} kg</template>
        </el-table-column>
        <el-table-column label="窖位" min-width="220">
          <template #default="{ row }">
            <el-tag v-if="row.shelfId" size="small" effect="plain">
              {{ shelfStore.shelfLabel(row.shelfId) }}
            </el-tag>
            <span v-else class="muted">未落位</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="stateTagType(row.state)" size="small" effect="dark">{{ row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近落位" min-width="150">
          <template #default="{ row }">
            {{ new Date(row.placedAt).toLocaleString('zh-CN', { hour12: false }) }}
          </template>
        </el-table-column>
      </el-table>

      <h4>转架历史（{{ turningHistory.length }}）</h4>
      <el-empty v-if="turningHistory.length === 0" description="暂无转架 / 翻面 / 擦洗记录" :image-size="60" />
      <el-timeline v-else class="trace__timeline">
        <el-timeline-item
          v-for="turning in turningHistory"
          :key="turning.id"
          :timestamp="`${turning.doneAt} · ${turning.operator || '未署名'}`"
          :type="
            turning.state === '已完成' ? 'success' : turning.state === '已跳过' ? 'info' : 'warning'
          "
        >
          <div class="trace__turn">
            <el-tag size="small" effect="dark">{{ turning.type }}</el-tag>
            <el-tag size="small" effect="plain" :type="turning.state === '已完成' ? 'success' : 'warning'">
              {{ turning.state }}
            </el-tag>
            <span>{{ segmentLabel(turning.segmentIds) }}</span>
          </div>
          <div class="trace__turn muted">
            <template v-if="turning.type === '转架' && turning.fromShelfId">
              {{ shelfStore.shelfLabel(turning.fromShelfId) }} →
              {{ shelfStore.shelfLabel(turning.shelfId) }}
            </template>
            <template v-else-if="turning.type === '转架'">
              转入 {{ shelfStore.shelfLabel(turning.shelfId) }}
            </template>
            <template v-else>作业窖位：{{ shelfStore.shelfLabel(turning.shelfId) }}</template>
            <span v-if="turning.brinePct > 0"> · 盐水 {{ turning.brinePct }}%</span>
          </div>
        </el-timeline-item>
      </el-timeline>

      <h4>段环境记录（{{ envRecords.length }}）</h4>
      <el-table :data="envRecords" border size="small">
        <el-table-column prop="recordedAt" label="时间" width="150" />
        <el-table-column label="归属段" width="90">
          <template #default="{ row }">
            {{ row.segmentId ? `段${segmentStore.segmentById(row.segmentId)?.seq ?? '?'}` : '整批' }}
          </template>
        </el-table-column>
        <el-table-column label="温/湿" width="130">
          <template #default="{ row }">
            <span class="mono">{{ row.tempC }}℃ / {{ row.humidityPct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.anomaly ? 'danger' : 'success'" size="small" effect="dark">
              {{ row.anomaly ? '异常' : '正常' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="action" label="措施" min-width="180" show-overflow-tooltip />
      </el-table>

      <h4>出库品评结论（{{ tastings.length }} 次）</h4>
      <div v-if="tastingScore" class="trace__tasting">
        <el-tag size="large" :type="tastingScore.conclusion === '优' ? 'success' : tastingScore.conclusion === '合格' ? 'primary' : 'danger'">
          批次结论：{{ tastingScore.conclusion }}
        </el-tag>
        <span class="muted">
          均分 {{ tastingScore.avgScore }}（外观 {{ tastingScore.avgAppearance }} / 风味
          {{ tastingScore.avgFlavor }} / 质地 {{ tastingScore.avgTexture }}）· 最近出库
          {{ tastingScore.lastOutAt }}
        </span>
      </div>
      <el-empty v-else description="暂无品评，出库品评后合回批次结论" :image-size="60" />
    </div>

    <template #footer>
      <el-button type="primary" @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.trace__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.trace h4 {
  margin: 18px 0 8px;
  font-size: 14px;
}

.trace__desc {
  margin-bottom: 4px;
}

.trace__turn {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.trace__turn.muted {
  margin-top: 4px;
  font-size: 12px;
}

.trace__timeline {
  padding-left: 4px;
}

.trace__tasting {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.imbalance {
  color: #c0392b;
  font-weight: 600;
}
</style>
