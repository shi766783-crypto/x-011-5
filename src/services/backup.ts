// 数据备份：导出文件的生成与下载、导入文件的格式校验、合并策略
// 安全原则：先完整校验再合并；合并是纯函数，产出全新数据后由调用方一次性写回 store，
// 任何一步失败都不会改动（更不会清空）现有数据

import type { KnowledgeCard, StudyLog, StudyPlan, UnlockedMap } from '@/types'
import { CARD_MASTERY_LEVELS, DOMAINS } from '@/constants'
import { uid } from '@/utils/id'
import { today } from '@/utils/date'

/** 备份文件标识与版本，导入时据此识别文件来源 */
export const BACKUP_APP_ID = 'family-study-manager'
export const BACKUP_VERSION = 1

/** 备份文件中的数据主体 */
export interface BackupData {
  plans: StudyPlan[]
  logs: StudyLog[]
  cards: KnowledgeCard[]
  unlocked: UnlockedMap
}

/** 备份文件完整结构 */
export interface BackupFile {
  app: typeof BACKUP_APP_ID
  version: number
  exportedAt: string
  data: BackupData
}

/** 同名冲突的处理策略 */
export type ConflictStrategy = 'overwrite' | 'skip'

export interface ImportStrategy {
  planConflict: ConflictStrategy
  cardConflict: ConflictStrategy
}

export interface ConflictInfo {
  planNames: string[]
  cardTitles: string[]
}

export interface ImportSummary {
  plansAdded: number
  plansOverwritten: number
  plansSkipped: number
  logsAdded: number
  logsSkipped: number
  cardsAdded: number
  cardsOverwritten: number
  cardsSkipped: number
  achievementsAdded: number
}

export interface MergeResult {
  data: BackupData
  summary: ImportSummary
}

export type ParseResult = { ok: true; data: BackupData } | { ok: false; error: string }

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY_RE.test(value)
}

// ---------- 导出 ----------

/** 触发浏览器下载备份文件（JSON） */
export function downloadBackup(data: BackupData): void {
  const payload: BackupFile = {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `知识管家备份-${today()}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

// ---------- 校验 ----------

function planError(value: unknown): string | null {
  if (!isRecord(value)) return '条目不是对象'
  if (!isNonEmptyString(value.id)) return '缺少 id'
  if (!isNonEmptyString(value.name)) return '缺少名称'
  if (!DOMAINS.includes(value.domain as never)) return `计划「${value.name}」的领域无效`
  if (typeof value.goal !== 'string') return `计划「${value.name}」的目标格式不正确`
  if (!isDateKey(value.startDate) || !isDateKey(value.endDate)) {
    return `计划「${value.name}」的起止日期格式不正确（应为 YYYY-MM-DD）`
  }
  if (!isNonNegativeNumber(value.totalHours) || !isNonNegativeNumber(value.dailyHours)) {
    return `计划「${value.name}」的学时必须是大于等于 0 的数字`
  }
  if (!Array.isArray(value.resources)) return `计划「${value.name}」的资源列表格式不正确`
  for (const resource of value.resources) {
    if (!isRecord(resource) || typeof resource.id !== 'string'
      || typeof resource.name !== 'string' || typeof resource.link !== 'string') {
      return `计划「${value.name}」包含无效的学习资源`
    }
  }
  if (typeof value.createdAt !== 'string') return `计划「${value.name}」缺少创建时间`
  if (value.completedAt !== undefined && typeof value.completedAt !== 'string') {
    return `计划「${value.name}」的完成时间格式不正确`
  }
  return null
}

function logError(value: unknown): string | null {
  if (!isRecord(value)) return '条目不是对象'
  if (!isNonEmptyString(value.id)) return '缺少 id'
  if (value.planId !== undefined && typeof value.planId !== 'string') return '关联计划 id 格式不正确'
  if (!isDateKey(value.date)) return '日期格式不正确（应为 YYYY-MM-DD）'
  if (typeof value.content !== 'string') return '学习内容格式不正确'
  if (!isNonNegativeNumber(value.duration)) return '学习时长必须是大于等于 0 的数字'
  if (typeof value.mastery !== 'number' || ![1, 2, 3, 4, 5].includes(value.mastery)) {
    return '掌握程度必须是 1-5 的整数'
  }
  if (typeof value.problem !== 'string' || typeof value.solution !== 'string'
    || typeof value.notes !== 'string') {
    return '问题/解决/备注字段格式不正确'
  }
  if (typeof value.createdAt !== 'string') return '缺少创建时间'
  return null
}

function cardError(value: unknown): string | null {
  if (!isRecord(value)) return '条目不是对象'
  if (!isNonEmptyString(value.id)) return '缺少 id'
  if (!isNonEmptyString(value.title)) return '缺少标题'
  if (!DOMAINS.includes(value.domain as never)) return `卡片「${value.title}」的领域无效`
  if (typeof value.question !== 'string' || typeof value.answer !== 'string') {
    return `卡片「${value.title}」的问题/答案格式不正确`
  }
  if (!Array.isArray(value.tags) || value.tags.some((t) => typeof t !== 'string')) {
    return `卡片「${value.title}」的标签格式不正确`
  }
  if (!CARD_MASTERY_LEVELS.includes(value.mastery as never)) {
    return `卡片「${value.title}」的掌握程度无效`
  }
  if (typeof value.reviewCount !== 'number' || !Number.isInteger(value.reviewCount) || value.reviewCount < 0) {
    return `卡片「${value.title}」的复习次数必须是非负整数`
  }
  if (value.lastReviewedAt !== undefined && !isDateKey(value.lastReviewedAt)) {
    return `卡片「${value.title}」的最近复习日期格式不正确`
  }
  if (typeof value.createdAt !== 'string') return `卡片「${value.title}」缺少创建时间`
  return null
}

/** 解析并逐字段校验备份文件；任何一项不合法都整体拒绝，返回可读的错误原因 */
export function parseBackup(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，请选择本应用导出的备份文件' }
  }
  if (!isRecord(raw)) return { ok: false, error: '备份文件结构不正确' }
  if (raw.app !== BACKUP_APP_ID) return { ok: false, error: '这不是本应用导出的备份文件' }
  if (raw.version !== BACKUP_VERSION) {
    return { ok: false, error: `备份文件版本（${String(raw.version)}）不受支持，请使用最新版本导出的文件` }
  }
  if (!isRecord(raw.data)) return { ok: false, error: '备份文件缺少数据内容' }

  const { plans, logs, cards, unlocked } = raw.data
  if (!Array.isArray(plans) || !Array.isArray(logs) || !Array.isArray(cards) || !isRecord(unlocked)) {
    return { ok: false, error: '备份文件数据不完整（应包含计划、日志、卡片和成就）' }
  }

  for (let i = 0; i < plans.length; i++) {
    const error = planError(plans[i])
    if (error) return { ok: false, error: `第 ${i + 1} 个计划：${error}` }
  }
  for (let i = 0; i < logs.length; i++) {
    const error = logError(logs[i])
    if (error) return { ok: false, error: `第 ${i + 1} 条日志：${error}` }
  }
  for (let i = 0; i < cards.length; i++) {
    const error = cardError(cards[i])
    if (error) return { ok: false, error: `第 ${i + 1} 张卡片：${error}` }
  }
  for (const [code, unlockedAt] of Object.entries(unlocked)) {
    if (!isDateKey(unlockedAt)) return { ok: false, error: `成就「${code}」的解锁时间格式不正确` }
  }

  return { ok: true, data: { plans, logs, cards, unlocked } as BackupData }
}

// ---------- 冲突检测与合并 ----------

const normalize = (name: string): string => name.trim()

/** 找出备份中与现有数据同名的计划与卡片，供用户决定覆盖还是跳过 */
export function detectConflicts(incoming: BackupData, current: BackupData): ConflictInfo {
  const existingPlanNames = new Set(current.plans.map((p) => normalize(p.name)))
  const existingCardTitles = new Set(current.cards.map((c) => normalize(c.title)))
  const planNames = new Set<string>()
  const cardTitles = new Set<string>()
  for (const plan of incoming.plans) {
    if (existingPlanNames.has(normalize(plan.name))) planNames.add(plan.name)
  }
  for (const card of incoming.cards) {
    if (existingCardTitles.has(normalize(card.title))) cardTitles.add(card.title)
  }
  return { planNames: [...planNames], cardTitles: [...cardTitles] }
}

/**
 * 纯函数合并：不修改入参，返回全新的完整数据。
 * - 计划/卡片按名称匹配冲突，按策略覆盖（保留本地 id 以维持日志关联）或跳过
 * - 日志按 id 去重；其 planId 依据计划合并结果重映射
 * - 成就取并集，同一成就保留最早解锁时间
 */
export function mergeBackup(
  incoming: BackupData,
  current: BackupData,
  strategy: ImportStrategy,
): MergeResult {
  const summary: ImportSummary = {
    plansAdded: 0,
    plansOverwritten: 0,
    plansSkipped: 0,
    logsAdded: 0,
    logsSkipped: 0,
    cardsAdded: 0,
    cardsOverwritten: 0,
    cardsSkipped: 0,
    achievementsAdded: 0,
  }

  // 计划
  const plans = current.plans.map((p) => ({ ...p, resources: p.resources.map((r) => ({ ...r })) }))
  const planIdMap = new Map<string, string>()
  for (const raw of incoming.plans) {
    const plan: StudyPlan = { ...raw, resources: raw.resources.map((r) => ({ ...r })) }
    const byName = plans.find((p) => normalize(p.name) === normalize(plan.name))
    if (byName) {
      if (strategy.planConflict === 'skip') {
        summary.plansSkipped += 1
      } else {
        Object.assign(byName, plan, { id: byName.id })
        summary.plansOverwritten += 1
      }
      planIdMap.set(plan.id, byName.id)
      continue
    }
    // id 撞车但名称不同：视为全新计划，重新分配 id
    const id = plans.some((p) => p.id === plan.id) ? uid() : plan.id
    plans.push({ ...plan, id })
    planIdMap.set(plan.id, id)
    summary.plansAdded += 1
  }

  // 日志
  const logs = current.logs.map((l) => ({ ...l }))
  const logIds = new Set(logs.map((l) => l.id))
  for (const raw of incoming.logs) {
    if (logIds.has(raw.id)) {
      summary.logsSkipped += 1
      continue
    }
    const log: StudyLog = { ...raw }
    // 映射不到时保留原 planId：可能指向本地已有计划；指向不存在计划时界面显示「未关联」
    if (log.planId) log.planId = planIdMap.get(log.planId) ?? log.planId
    logs.push(log)
    logIds.add(log.id)
    summary.logsAdded += 1
  }

  // 卡片
  const cards = current.cards.map((c) => ({ ...c, tags: [...c.tags] }))
  for (const raw of incoming.cards) {
    const card: KnowledgeCard = { ...raw, tags: [...raw.tags] }
    const byTitle = cards.find((c) => normalize(c.title) === normalize(card.title))
    if (byTitle) {
      if (strategy.cardConflict === 'skip') {
        summary.cardsSkipped += 1
      } else {
        Object.assign(byTitle, card, { id: byTitle.id })
        summary.cardsOverwritten += 1
      }
      continue
    }
    const id = cards.some((c) => c.id === card.id) ? uid() : card.id
    cards.push({ ...card, id })
    summary.cardsAdded += 1
  }

  // 成就
  const unlocked: UnlockedMap = { ...current.unlocked }
  for (const [code, unlockedAt] of Object.entries(incoming.unlocked)) {
    const existing = unlocked[code]
    if (!existing) {
      unlocked[code] = unlockedAt
      summary.achievementsAdded += 1
    } else if (unlockedAt < existing) {
      unlocked[code] = unlockedAt
    }
  }

  return { data: { plans, logs, cards, unlocked }, summary }
}
