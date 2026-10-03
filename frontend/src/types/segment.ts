/**
 * 批次分段：一个入窖批次可按「块」拆成多个段落位到不同窖位。
 * 段是窖位占用、转架携带范围与环境记录归属的最小单位；
 * 同批次各段重量合计必须等于批次入窖重量 weightKg（允许 0.001kg 舍入误差）。
 *
 * 段状态：在窖 → 已出库（保留最后所在窖位备查）/ 已合并（并入同批另一段）。
 */
export type SegmentState = '在窖' | '已出库' | '已合并'

export interface BatchSegment {
  id: string
  /** 所属批次 id（外键 → Batch.id） */
  batchId: string
  /** 段序号，从 1 开始，批次内唯一 */
  seq: number
  /** 该段奶酪块数（至少 1 块，占用窖位时按块计） */
  blockCount: number
  /** 该段重量 kg，各段合计等于批次入窖重量 */
  weightKg: number
  /** 当前所在窖位 id（外键 → Shelf.id；已出库 / 已合并且需留痕时保留最后窖位） */
  shelfId: string | null
  /** 当前状态 */
  state: SegmentState
  /** 合并去向段 id（state=已合并 时填写） */
  mergedIntoId: string | null
  /** 最近一次窖位变更时间（转架签署 / 分段落位时回写） */
  placedAt: number
  createdAt: number
  updatedAt: number
}

export const SEGMENT_STATES: SegmentState[] = ['在窖', '已出库', '已合并']

/** 分段落位对话框中可编辑的一行（未保存的草稿用负数 id 标记） */
export interface SegmentDraft {
  /** 已存在段为其 id；新增行为负数临时 id */
  key: string
  seq: number
  blockCount: number
  weightKg: number
  shelfId: string | null
}

/** 分段落位保存结果 */
export interface LayoutResult {
  ok: boolean
  message: string
  /** 保存后各窖位的最新占用（用于并发冲突后提示余量） */
  shelfId?: string
  free?: number
  capacity?: number
  /** 本次保存中实际发生窖位变更的段数（会补记转架历史） */
  movedCount?: number
}

/** 批次分段汇总派生值 */
export interface BatchSegmentSummary {
  batchId: string
  /** 在窖段数 */
  placedSegmentCount: number
  /** 在窖块数合计 */
  totalBlocks: number
  /** 在窖重量合计（保留 3 位小数） */
  totalWeightKg: number
  /** 涉及窖位数（去重） */
  shelfCount: number
  /** 各段重量合计与批次入窖重量的差值（0 表示守恒） */
  weightDeltaKg: number
  /** 重量是否守恒（误差在 0.001kg 内） */
  weightBalanced: boolean
  /** 是否已完成上架（至少一个在窖段） */
  assigned: boolean
}

/** 重量守恒判定允许的舍入误差（kg） */
export const WEIGHT_EPSILON = 0.001
