import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload,
  type BatchArchive
} from '@/utils/db'

/** 导入 / 校验结果：校验失败时 errors 非空、payload 为 null */
export interface ParseResult {
  ok: boolean
  errors: string[]
  payload: BackupPayload | null
}

const COLLECTIONS: Array<
  keyof Pick<
    BackupPayload,
    'milks' | 'batches' | 'segments' | 'shelves' | 'turnings' | 'environments' | 'tastings'
  >
> = ['milks', 'batches', 'segments', 'shelves', 'turnings', 'environments', 'tastings']

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

/**
 * 校验批次熟成档案 JSON 的必备字段，返回错误信息数组（为空表示通过）。
 * 同时剔除非法条目，保证导入的数据结构完整。
 */
export function validatePayload(input: unknown): ParseResult {
  const errors: string[] = []
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  if (input.app !== 'gbcheeseage') {
    errors.push('app 字段应为 gbcheeseage，文件来源不明')
  }
  COLLECTIONS.forEach((key) => {
    if (!Array.isArray(input[key])) errors.push(`${key} 字段缺失或不是数组`)
  })
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const obj = input as Partial<BackupPayload>
  const payload: BackupPayload = {
    app: 'gbcheeseage',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    milks: (obj.milks ?? []).filter((item) => typeof item?.id === 'string'),
    batches: (obj.batches ?? []).filter((item) => typeof item?.id === 'string'),
    // 旧版（v2 及以前）导出文件没有 segments 表，按空数组合法处理，由导入侧补默认段
    segments: (obj.segments ?? []).filter((item) => typeof item?.id === 'string'),
    shelves: (obj.shelves ?? []).filter((item) => typeof item?.id === 'string'),
    turnings: (obj.turnings ?? []).filter((item) => typeof item?.id === 'string'),
    environments: (obj.environments ?? []).filter((item) => typeof item?.id === 'string'),
    tastings: (obj.tastings ?? []).filter((item) => typeof item?.id === 'string')
  }
  if (payload.batches.length === 0 && payload.milks.length === 0) {
    errors.push('文件中没有任何奶源或批次记录')
    return { ok: false, errors, payload: null }
  }
  // 引用完整性校验：批次的奶源、分段 / 转架 / 环境 / 品评的批次必须能在文件内找到
  const milkIds = new Set(payload.milks.map((item) => item.id))
  const batchIds = new Set(payload.batches.map((item) => item.id))
  const segmentIds = new Set(payload.segments.map((item) => item.id))
  const shelfIds = new Set(payload.shelves.map((item) => item.id))
  payload.batches.forEach((batch) => {
    if (!milkIds.has(batch.milkId)) {
      errors.push(`批次 ${batch.id} 引用了不存在的奶源 ${batch.milkId}`)
    }
  })
  payload.segments.forEach((segment) => {
    if (!batchIds.has(segment.batchId)) {
      errors.push(`分段 ${segment.id} 引用了不存在的批次 ${segment.batchId}`)
    }
    if (segment.shelfId && !shelfIds.has(segment.shelfId)) {
      errors.push(`分段 ${segment.id} 引用了不存在的窖位 ${segment.shelfId}`)
    }
  })
  payload.turnings.forEach((turning) => {
    if (!batchIds.has(turning.batchId)) {
      errors.push(`转架作业 ${turning.id} 引用了不存在的批次 ${turning.batchId}`)
    }
    if (!shelfIds.has(turning.shelfId)) {
      errors.push(`转架作业 ${turning.id} 引用了不存在的窖位 ${turning.shelfId}`)
    }
    ;(turning.segmentIds ?? []).forEach((segmentId) => {
      if (!segmentIds.has(segmentId)) {
        errors.push(`转架作业 ${turning.id} 引用了不存在的分段 ${segmentId}`)
      }
    })
  })
  payload.environments.forEach((record) => {
    if (!batchIds.has(record.batchId)) {
      errors.push(`环境记录 ${record.id} 引用了不存在的批次 ${record.batchId}`)
    }
    if (record.segmentId && !segmentIds.has(record.segmentId)) {
      errors.push(`环境记录 ${record.id} 引用了不存在的分段 ${record.segmentId}`)
    }
  })
  payload.tastings.forEach((tasting) => {
    if (!batchIds.has(tasting.batchId)) {
      errors.push(`品评记录 ${tasting.id} 引用了不存在的批次 ${tasting.batchId}`)
    }
  })
  if (errors.length > 0) return { ok: false, errors, payload: null }
  return { ok: true, errors, payload }
}

/** 从文本解析并校验 JSON */
export function parseSnapshotJson(text: string): ParseResult {
  try {
    const parsed: unknown = JSON.parse(text)
    return validatePayload(parsed)
  } catch {
    return { ok: false, errors: ['JSON 解析失败，请确认文件未损坏'], payload: null }
  }
}

/** 读取用户选择的文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
}

/** 导出全量档案 JSON */
export async function exportSnapshotJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const [milks, batches, segments, shelves, turnings, environments, tastings] = await Promise.all([
    db.milks.toArray(),
    db.batches.toArray(),
    db.segments.toArray(),
    db.shelves.toArray(),
    db.turnings.toArray(),
    db.environments.toArray(),
    db.tastings.toArray()
  ])
  const payload: BackupPayload = {
    app: 'gbcheeseage',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    milks,
    batches,
    segments,
    shelves,
    turnings,
    environments,
    tastings
  }
  const fileName = `gbcheeseage-archive-v${DB_VERSION}-${stamp()}.json`
  downloadJson(fileName, payload)
  stampBackupTime(payload.exportedAt)
  return {
    fileName,
    counts: {
      milks: milks.length,
      batches: batches.length,
      segments: segments.length,
      shelves: shelves.length,
      turnings: turnings.length,
      environments: environments.length,
      tastings: tastings.length
    }
  }
}

/** 导出单个批次的熟成档案（含奶源、分段、窖位、转架、环境与品评） */
export async function exportBatchArchiveJson(
  batchId: string
): Promise<{ fileName: string; counts: Record<string, number> }> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在，无法导出')
  const [milks, shelves, segments, turnings, environments, tastings] = await Promise.all([
    db.milks.toArray(),
    db.shelves.toArray(),
    db.segments.where('batchId').equals(batchId).toArray(),
    db.turnings.where('batchId').equals(batchId).toArray(),
    db.environments.where('batchId').equals(batchId).toArray(),
    db.tastings.where('batchId').equals(batchId).toArray()
  ])
  const shelfIds = new Set(
    segments.map((segment) => segment.shelfId).filter(Boolean) as string[]
  )
  turnings.forEach((turning) => shelfIds.add(turning.shelfId))
  const archive: BatchArchive = {
    app: 'gbcheeseage',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    scope: 'batch',
    batchId,
    milks: milks.filter((milk) => milk.id === batch.milkId),
    batches: [batch],
    segments,
    shelves: shelves.filter((shelf) => shelfIds.has(shelf.id)),
    turnings,
    environments,
    tastings
  }
  const fileName = `gbcheeseage-batch-${batchId}-${stamp()}.json`
  downloadJson(fileName, archive)
  return {
    fileName,
    counts: {
      milks: archive.milks.length,
      batches: 1,
      segments: segments.length,
      shelves: archive.shelves.length,
      turnings: turnings.length,
      environments: environments.length,
      tastings: tastings.length
    }
  }
}

/** 导入档案：overwrite 为 true 时先清空全部表，否则按 id 合并覆盖 */
export async function importSnapshotJson(
  payload: BackupPayload,
  overwrite = false
): Promise<Record<string, number>> {
  if (overwrite) await clearAllTables()
  // 兼容旧版（v2 及以前）导出：没有 segments 时为每个批次补一个默认段
  const normalized = normalizeLegacySegments(payload)
  await db.transaction(
    'rw',
    [
      db.milks,
      db.batches,
      db.segments,
      db.shelves,
      db.turnings,
      db.environments,
      db.tastings
    ],
    async () => {
      await db.milks.bulkPut(normalized.milks)
      await db.batches.bulkPut(normalized.batches)
      await db.segments.bulkPut(normalized.segments)
      await db.shelves.bulkPut(normalized.shelves)
      await db.turnings.bulkPut(normalized.turnings)
      await db.environments.bulkPut(normalized.environments)
      await db.tastings.bulkPut(normalized.tastings)
    }
  )
  return {
    milks: normalized.milks.length,
    batches: normalized.batches.length,
    segments: normalized.segments.length,
    shelves: normalized.shelves.length,
    turnings: normalized.turnings.length,
    environments: normalized.environments.length,
    tastings: normalized.tastings.length
  }
}

/**
 * 旧版档案兼容：缺少 segments 集合（v2 导出）时，按批次 shelfId 生成唯一默认段，
 * 并把该批转架 / 环境记录回填到默认段；已出库批次同样保留段以便追溯。
 */
function normalizeLegacySegments(payload: BackupPayload): BackupPayload {
  if (payload.segments.length > 0) return payload
  const now = Date.now()
  const segments = payload.batches.map((batch) => ({
    id: `seg_${batch.id}`,
    batchId: batch.id,
    seq: 1,
    blockCount: 1,
    weightKg: batch.weightKg,
    shelfId: batch.shelfId ?? null,
    state: batch.state === '已出库' ? ('已出库' as const) : ('在窖' as const),
    mergedIntoId: null,
    placedAt: batch.updatedAt ?? now,
    createdAt: batch.createdAt ?? now,
    updatedAt: now
  }))
  const batchToSegment = new Map(segments.map((segment) => [segment.batchId, segment.id]))
  const turnings = payload.turnings.map((turning) => ({
    ...turning,
    segmentIds: turning.segmentIds ?? (batchToSegment.has(turning.batchId)
      ? [batchToSegment.get(turning.batchId) as string]
      : []),
    fromShelfId: turning.fromShelfId ?? null,
    appliedAt: turning.appliedAt ?? null
  }))
  const environments = payload.environments.map((record) => ({
    ...record,
    segmentId: record.segmentId ?? batchToSegment.get(record.batchId) ?? null
  }))
  return { ...payload, segments, turnings, environments }
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapPayloadIds(payload: BackupPayload): BackupPayload {
  const normalized = normalizeLegacySegments(payload)
  const milkIdMap = new Map<string, string>()
  const batchIdMap = new Map<string, string>()
  const shelfIdMap = new Map<string, string>()
  const segmentIdMap = new Map<string, string>()

  const milks = normalized.milks.map((milk) => {
    const id = createId('milk')
    milkIdMap.set(milk.id, id)
    return { ...milk, id }
  })
  const shelves = normalized.shelves.map((shelf) => {
    const id = createId('shelf')
    shelfIdMap.set(shelf.id, id)
    return { ...shelf, id }
  })
  const batches = normalized.batches.map((batch) => {
    const id = createId('batch')
    batchIdMap.set(batch.id, id)
    return {
      ...batch,
      id,
      milkId: milkIdMap.get(batch.milkId) ?? batch.milkId,
      shelfId: batch.shelfId ? shelfIdMap.get(batch.shelfId) ?? null : null
    }
  })
  const segments = normalized.segments.map((segment) => {
    const id = createId('seg')
    segmentIdMap.set(segment.id, id)
    return {
      ...segment,
      id,
      batchId: batchIdMap.get(segment.batchId) ?? segment.batchId,
      shelfId: segment.shelfId ? shelfIdMap.get(segment.shelfId) ?? null : null,
      mergedIntoId: segment.mergedIntoId ? segmentIdMap.get(segment.mergedIntoId) ?? null : null
    }
  })
  const turnings = normalized.turnings.map((turning) => ({
    ...turning,
    id: createId('turn'),
    batchId: batchIdMap.get(turning.batchId) ?? turning.batchId,
    shelfId: shelfIdMap.get(turning.shelfId) ?? turning.shelfId,
    fromShelfId: turning.fromShelfId ? shelfIdMap.get(turning.fromShelfId) ?? null : null,
    segmentIds: turning.segmentIds
      .map((segmentId) => segmentIdMap.get(segmentId) ?? segmentId)
  }))
  const environments = normalized.environments.map((record) => ({
    ...record,
    id: createId('env'),
    batchId: batchIdMap.get(record.batchId) ?? record.batchId,
    segmentId: record.segmentId ? segmentIdMap.get(record.segmentId) ?? null : null
  }))
  const tastings = normalized.tastings.map((tasting) => ({
    ...tasting,
    id: createId('tast'),
    batchId: batchIdMap.get(tasting.batchId) ?? tasting.batchId
  }))

  return { ...normalized, milks, batches, segments, shelves, turnings, environments, tastings }
}
