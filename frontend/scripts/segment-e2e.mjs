import 'fake-indexeddb/auto'
import { db, DB_VERSION } from '../src/utils/db.ts'

let passed = 0
let failed = 0
function assert(condition, message) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const now = Date.UTC(2025, 5, 1, 8, 0, 0)

// ---- 场景 1：v2 旧库 → v3 升级（老批次自动生成默认段、历史记录回填段引用、占用按段重算）----
console.log('\n[1] v2 → v3 升级迁移')
{
  const old = new (await import('dexie')).default('gbcheeseage')
  old.version(1).stores({
    milks: 'id, farm, milkKind, collectedAt, updatedAt',
    batches: 'id, milkId, cheeseType, targetDays, state, curdedAt, updatedAt',
    shelves: 'id, room, rackNo, tempZone, capacity, occupied, updatedAt',
    turnings: 'id, batchId, shelfId, doneAt, type, state, updatedAt',
    environments: 'id, batchId, recordedAt, anomaly, updatedAt',
    tastings: 'id, batchId, outAt, score, conclusion, updatedAt'
  })
  old.version(2).stores({
    milks: 'id, farm, milkKind, collectedAt, updatedAt',
    batches: 'id, milkId, shelfId, cheeseType, targetDays, state, curdedAt, updatedAt',
    shelves: 'id, room, rackNo, tempZone, capacity, occupied, updatedAt',
    turnings: 'id, batchId, shelfId, doneAt, type, state, seq, updatedAt',
    environments: 'id, batchId, recordedAt, anomaly, updatedAt',
    tastings: 'id, batchId, outAt, score, conclusion, updatedAt'
  })
  await old.open()
  await old.milks.put({
    id: 'm1', farm: '牧场甲', milkKind: '牛', collectedAt: '2025-01-01', fatPct: 4, proteinPct: 3,
    note: '', createdAt: now, updatedAt: now
  })
  await old.batches.put({
    id: 'b1', milkId: 'm1', curdedAt: '2025-01-01', cheeseType: '硬质', targetDays: 60,
    weightKg: 10, state: '熟成中', shelfId: 's1', conclusion: '', createdAt: now, updatedAt: now
  })
  await old.batches.put({
    id: 'b2', milkId: 'm1', curdedAt: '2025-02-01', cheeseType: '软质', targetDays: 20,
    weightKg: 4, state: '凝乳', shelfId: null, conclusion: '', createdAt: now, updatedAt: now
  })
  await old.shelves.put({
    id: 's1', room: '一号库', rackNo: 'A-01', layerNo: 1, tempZone: '中温区',
    capacity: 6, occupied: 5, createdAt: now, updatedAt: now
  })
  await old.turnings.put({
    id: 't1', batchId: 'b1', shelfId: 's1', doneAt: '2025-01-05', type: '转架',
    brinePct: 18, operator: '甲', state: '已完成', seq: 1, createdAt: now, updatedAt: now
  })
  await old.environments.put({
    id: 'e1', batchId: 'b1', recordedAt: '2025-01-05T09:00', tempC: 11, humidityPct: 85,
    anomaly: false, action: '', createdAt: now, updatedAt: now
  })
  await old.tastings.put({
    id: 'k1', batchId: 'b1', outAt: '2025-03-02', appearance: 'a', flavor: 'f', texture: 't',
    appearanceScore: 9, flavorScore: 9, textureScore: 9, score: 9, conclusion: '优',
    taster: '甲', createdAt: now, updatedAt: now
  })
  await old.close()

  await db.open()
  assert(db.verno === DB_VERSION, `数据库结构版本升级到 ${DB_VERSION}（实际 ${db.verno}）`)

  const segB1 = await db.segments.where('batchId').equals('b1').toArray()
  assert(segB1.length === 1, '老批次 b1 生成 1 个默认段')
  assert(segB1[0].weightKg === 10 && segB1[0].blockCount === 1, '默认段重量=批次重量 10kg、1 块')
  assert(segB1[0].shelfId === 's1' && segB1[0].state === '在窖', '默认段落位到原 shelfId=s1、状态在窖')

  const segB2 = await db.segments.where('batchId').equals('b2').toArray()
  assert(segB2.length === 1 && segB2[0].shelfId === null, '未上架批次 b2 的默认段 shelfId=null')

  const t1 = await db.turnings.get('t1')
  assert(Array.isArray(t1.segmentIds) && t1.segmentIds[0] === segB1[0].id, '历史转架回填 segmentIds')
  assert(t1.appliedAt !== null, '已完成的历史转架回填 appliedAt（不会重复迁段）')
  const e1 = await db.environments.get('e1')
  assert(e1.segmentId === segB1[0].id, '历史环境记录回填 segmentId')

  const s1After = await db.shelves.get('s1')
  assert(s1After.occupied === 1, '窖位占用按段块数重算为 1（旧脏值 5 被纠正）')
  await db.close()
  await new Promise((resolve) => indexedDB.deleteDatabase('gbcheeseage').onsuccess = resolve)
}

// ---- 场景 2：全新播种 ----
console.log('\n[2] 全新播种分段数据')
const { seedDatabase } = await import('../src/utils/db.ts')
{
  await db.open()
  await seedDatabase()
  const segments = await db.segments.toArray()
  assert(segments.length === 5, `播种 5 个段（实际 ${segments.length}）`)
  const aSegs = segments.filter((s) => s.batchId === 'batch_alp_01')
  const totalA = aSegs.reduce((sum, s) => sum + s.weightKg, 0)
  assert(Math.abs(totalA - 12.5) < 0.001, `A 批两段重量合计 12.5kg（实际 ${totalA}）`)
  const shelves = await db.shelves.toArray()
  const a1 = shelves.find((s) => s.id === 'shelf_a1')
  assert(a1.occupied === 2, `shelf_a1 占用 2 块（segA1 已出库不计入；实际 ${a1.occupied}）`)
  const c1 = shelves.find((s) => s.id === 'shelf_c1')
  assert(c1.occupied === 2, `shelf_c1 占用 2 块（A2 已出库不计，B2 在窖 2 块；实际 ${c1.occupied}）`)
  const b2shelf = shelves.find((s) => s.id === 'shelf_b2')
  assert(b2shelf.occupied === 2, `shelf_b2 占用 2 块（B1 在窖 2 块；实际 ${b2shelf.occupied}）`)
}

// ---- 场景 3：分段落位事务（重量守恒 + 容量抢占 + 并发互斥）----
console.log('\n[3] 分段落位：重量守恒与容量校验')
// 直接复用 Pinia store 之前，用低层事务模拟 saveLayout 的关键约束：
// 这里实例化 setActivePinia 后使用 store。
const { setActivePinia, createPinia } = await import('pinia')
setActivePinia(createPinia())
const { useSegmentStore } = await import('../src/stores/segmentStore.ts')
const { useMilkStore } = await import('../src/stores/milkStore.ts')
const { useShelfStore } = await import('../src/stores/shelfStore.ts')
const segmentStore = useSegmentStore()
const milkStore = useMilkStore()
const shelfStore = useShelfStore()
await new Promise((r) => setTimeout(r, 30)) // 等 liveQuery 首次订阅

{
  // 新建一个 9.8kg 批次并拆两段：5.0 + 4.9（重量不符）应被拒
  const batch = await milkStore.createBatch({
    milkId: 'milk_alpine', curdedAt: '2025-06-01', cheeseType: '硬质',
    targetDays: 90, weightKg: 9.8, state: '凝乳'
  })
  const bad = await segmentStore.saveLayout(batch.id, [
    { key: 'n1', seq: 1, blockCount: 2, weightKg: 5.0, shelfId: 'shelf_c1' },
    { key: 'n2', seq: 2, blockCount: 2, weightKg: 4.9, shelfId: 'shelf_b2' }
  ])
  assert(!bad.ok && /重量/.test(bad.message), `重量合计 9.9 ≠ 9.8 被拒：${bad.message}`)
  assert((await db.segments.where('batchId').equals(batch.id).count()) === 0, '被拒后未写入任何段')

  const ok = await segmentStore.saveLayout(batch.id, [
    { key: 'n1', seq: 1, blockCount: 2, weightKg: 4.9, shelfId: 'shelf_c1' },
    { key: 'n2', seq: 2, blockCount: 2, weightKg: 4.9, shelfId: 'shelf_b2' }
  ])
  assert(ok.ok, `重量守恒 9.8=4.9+4.9 落位成功：${ok.message}`)
  const c1 = await db.shelves.get('shelf_c1')
  assert(c1.occupied === 4, `shelf_c1 占用变为 4（原 B2 的 2 + 新段 2；实际 ${c1.occupied}）`)
  const batchRow = await db.batches.get(batch.id)
  assert(batchRow.shelfId === 'shelf_c1', '批次代表窖位回写为第一段窖位')

  // 容量抢占：shelf_b2 cap=6, 现占 4；尝试放 3 块应被拒
  const batch2 = await milkStore.createBatch({
    milkId: 'milk_alpine', curdedAt: '2025-06-02', cheeseType: '硬质',
    targetDays: 90, weightKg: 6, state: '凝乳'
  })
  const full = await segmentStore.saveLayout(batch2.id, [
    { key: 'n3', seq: 1, blockCount: 3, weightKg: 6, shelfId: 'shelf_b2' }
  ])
  assert(!full.ok && full.free === 2, `容量不足被拒并返回最新余量 2（实际 free=${full.free}）：${full.message}`)
  assert((await db.segments.where('batchId').equals(batch2.id).count()) === 0, '冲突事务回滚，未写入段')

  // 两个平板并发：两笔各要 2 块、窖位只剩 2 块，必须恰好一成一败
  const x = await milkStore.createBatch({
    milkId: 'milk_alpine', curdedAt: '2025-06-03', cheeseType: '硬质',
    targetDays: 90, weightKg: 5, state: '凝乳'
  })
  const y = await milkStore.createBatch({
    milkId: 'milk_alpine', curdedAt: '2025-06-04', cheeseType: '硬质',
    targetDays: 90, weightKg: 5, state: '凝乳'
  })
  // 先清掉 shelf_b2 上的占用，构造只剩 2 块的场景：用一个 cap=2 的新窖位
  await db.shelves.put({
    id: 'shelf_tight', room: '三号库', rackNo: 'T-01', layerNo: 1, tempZone: '冷区',
    capacity: 2, occupied: 0, createdAt: now, updatedAt: now
  })
  const [r1, r2] = await Promise.all([
    segmentStore.saveLayout(x.id, [{ key: 'x1', seq: 1, blockCount: 2, weightKg: 5, shelfId: 'shelf_tight' }]),
    segmentStore.saveLayout(y.id, [{ key: 'y1', seq: 1, blockCount: 2, weightKg: 5, shelfId: 'shelf_tight' }])
  ])
  assert(r1.ok !== r2.ok, '两个平板同时抢同一窖位：恰好一个成功')
  assert((!r1.ok && r1.free === 0) || (!r2.ok && r2.free === 0), '后到者看到余量 0 并被要求重新选位')
  const tight = await db.shelves.get('shelf_tight')
  assert(tight.occupied === 2, '窖位最终占用 2/2，没有两段共占一格')
  const segCount = await db.segments
    .where('shelfId').equals('shelf_tight')
    .and((s) => s.state === '在窖').count()
  assert(segCount === 1, 'shelf_tight 上只有 1 个在窖段')
}

// ---- 场景 4：转架签署携带指定段、容量冲突回滚 ----
console.log('\n[4] 转架只带指定段 + 冲突回滚')
const { useTurningStore } = await import('../src/stores/turningStore.ts')
const turningStore = useTurningStore()
{
  // B 批两段分别在 shelf_b2(2块) 与 shelf_c1(2块)。新建一条只带 segB2 的转架到 shelf_a1
  const segB2 = (await db.segments.where('batchId').equals('batch_alp_02').toArray())
    .find((s) => s.shelfId === 'shelf_c1')
  const turning = await turningStore.createTurning({
    batchId: 'batch_alp_02',
    segmentIds: [segB2.id],
    shelfId: 'shelf_a1',
    doneAt: '2025-06-10',
    type: '转架',
    brinePct: 18,
    operator: '测试员',
    state: '待执行'
  })
  const beforeB2 = await db.segments.get(segB2.id)
  assert(beforeB2.shelfId === 'shelf_c1', '签署前段 B2 在 shelf_c1')
  const sign = await turningStore.complete(turning.id)
  assert(sign.ok, '转架签署成功')
  const afterB2 = await db.segments.get(segB2.id)
  assert(afterB2.shelfId === 'shelf_a1', '只把携带段 B2 迁到 shelf_a1')
  const segB1 = (await db.segments.where('batchId').equals('batch_alp_02').toArray())
    .find((s) => s.id !== segB2.id)
  assert(segB1.shelfId === 'shelf_b2', '未携带的段 B1 仍在 shelf_b2，没有跟着走')
  const t = await db.turnings.get(turning.id)
  assert(t.fromShelfId === 'shelf_c1' && t.appliedAt !== null, '转架记录留下 fromShelfId 与 appliedAt 历史')
  const a1 = await db.shelves.get('shelf_a1')
  const c1 = await db.shelves.get('shelf_c1')
  assert(a1.occupied === 4, `shelf_a1 占用 4（C1 2块 + B2 2块；实际 ${a1.occupied}）`)
  assert(c1.occupied === 2, `shelf_c1 占用 2（场景3 新批段 2块，B2 迁走后；实际 ${c1.occupied}）`)

  // 重复完成不再迁段（幂等）
  await turningStore.complete(turning.id)
  const t2 = await db.turnings.get(turning.id)
  assert(t2.appliedAt === t.appliedAt, '重复签署不会再次迁段')

  // 容量冲突：把 B2 从 a1 转去容量已满的 shelf_tight（2/2），应失败且保持待执行
  const conflictTurning = await turningStore.createTurning({
    batchId: 'batch_alp_02',
    segmentIds: [segB2.id],
    shelfId: 'shelf_tight',
    doneAt: '2025-06-11',
    type: '转架',
    brinePct: 18,
    operator: '测试员',
    state: '待执行'
  })
  const result = await turningStore.complete(conflictTurning.id)
  assert(!result.ok && /余量/.test(result.conflict ?? ''), `目标窖位满，签署被拒：${result.conflict}`)
  const stay = await db.segments.get(segB2.id)
  assert(stay.shelfId === 'shelf_a1', '冲突时段仍在原窖位，未发生迁移')
  const stayT = await db.turnings.get(conflictTurning.id)
  assert(stayT.state === '待执行' && stayT.appliedAt === null, '冲突作业保持待执行，可改窖位后重签')
}

// ---- 场景 5：段合并与出库 ----
console.log('\n[5] 段合并 / 出库释放 / 品评仍按批次')
{
  const segs = (await db.segments.where('batchId').equals('batch_alp_02').toArray())
    .filter((s) => s.state === '在窖')
    .sort((a, b) => a.seq - b.seq)
  // B2 此刻在 shelf_a1，B1 在 shelf_b2；把 B2 合并进 B1
  const merge = await segmentStore.mergeSegments('batch_alp_02', [segs[0].id, segs[1].id], segs[0].id)
  assert(merge.ok, `跨窖位合并成功：${merge.message}`)
  const keep = await db.segments.get(segs[0].id)
  assert(keep.blockCount === 4 && Math.abs(keep.weightKg - 9.8) < 0.001, `保留段块数 4、重量 9.8（实际 ${keep.blockCount}/${keep.weightKg}）`)
  const merged = await db.segments.get(segs[1].id)
  assert(merged.state === '已合并' && merged.mergedIntoId === keep.id, '被合并段标记已合并并指向保留段')
  // 被合并段的转架记录改挂保留段
  const carried = await db.turnings.where('batchId').equals('batch_alp_02').toArray()
  const dangling = carried.filter((t) => t.segmentIds.includes(segs[1].id))
  assert(dangling.length === 0, '被合并段上的转架记录全部改挂保留段')

  // 出库：标记在窖段并释放占用
  const ship = await segmentStore.markShipped('batch_alp_02')
  assert(ship.ok, ship.message)
  const activeLeft = await db.segments
    .where('batchId').equals('batch_alp_02')
    .and((s) => s.state === '在窖').count()
  assert(activeLeft === 0, '出库后无在窖段')
  const b2 = await db.shelves.get('shelf_b2')
  assert(b2.occupied === 2, `shelf_b2 出库后释放回 2（剩场景3 批一段；实际 ${b2.occupied}）`)
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
