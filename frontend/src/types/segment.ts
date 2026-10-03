/**
 * 分段（块）：一批奶酪因窖位不够拆成多个块，每块单独落位到一个窖位。
 * 各段重量合计 = 批次入库重量；每段落位占用窖位 1 块容量。
 * 转架作业与环境记录都认到具体段，出库品评再合回批次结论。
 */
import { round } from '@/utils/temperature'

export interface Segment {
  id: string
  /** 所属批次 id（外键 → Batch.id） */
  batchId: string
  /** 段号（同批次内从 1 开始，按段号排序） */
  blockNo: number
  /** 本段重量 kg（各段合计 = 批次 weightKg） */
  weightKg: number
  /** 所落窖位 id（null = 尚未上架） */
  shelfId: string | null
  /** 乐观锁版本号：每次落位 / 挪窝 +1，多标签页并发写时先写者胜 */
  rev: number
  /** 备注（如本块表皮状态、摆放位置） */
  note: string
  createdAt: number
  updatedAt: number
}

/** 分段落位 / 挪窝操作结果 */
export interface SegmentPlaceResult {
  ok: boolean
  message: string
}

/** 各段重量合计与批次入库重量的比对结果 */
export interface SegmentWeightBalance {
  batchId: string
  batchWeightKg: number
  segmentCount: number
  totalWeightKg: number
  /** 差值（合计 - 入库重量），应为 0 */
  diffKg: number
  /** 是否守恒（差值绝对值 ≤ 容差，容忍浮点误差） */
  balanced: boolean
  placedCount: number
  unplacedCount: number
}

/** 重量守恒容差：合计与入库重量差值在此范围内视为相等 */
export const SEGMENT_WEIGHT_TOLERANCE = 0.05

/** 把入库重量按块数均分，末段补齐余数，保证合计 = weightKg */
export function splitWeightEvenly(weightKg: number, blockCount: number): number[] {
  const count = Math.max(1, Math.round(blockCount))
  const total = round(weightKg, 1)
  const base = round(total / count, 1)
  const weights: number[] = []
  let acc = 0
  for (let index = 0; index < count; index += 1) {
    if (index === count - 1) {
      weights.push(round(total - acc, 1))
    } else {
      weights.push(base)
      acc = round(acc + base, 1)
    }
  }
  return weights
}

/** 校验一组段重量合计是否等于入库重量 */
export function checkWeightBalance(
  batchId: string,
  batchWeightKg: number,
  segments: Array<{ weightKg: number; shelfId: string | null }>
): SegmentWeightBalance {
  const total = round(segments.reduce((sum, item) => sum + item.weightKg, 0), 1)
  const diff = round(total - batchWeightKg, 1)
  return {
    batchId,
    batchWeightKg,
    segmentCount: segments.length,
    totalWeightKg: total,
    diffKg: diff,
    balanced: Math.abs(diff) <= SEGMENT_WEIGHT_TOLERANCE,
    placedCount: segments.filter((item) => item.shelfId !== null).length,
    unplacedCount: segments.filter((item) => item.shelfId === null).length
  }
}
