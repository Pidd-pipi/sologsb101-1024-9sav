/** 重量相关纯函数：分段重量合计需与批次入库重量守恒，统一保留 3 位小数避免浮点误差 */

export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000
}

/** 求和后保留 3 位小数 */
export function sumWeight(values: number[]): number {
  return round3(values.reduce((sum, value) => sum + value, 0))
}
