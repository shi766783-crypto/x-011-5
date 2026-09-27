// 数据备份/导入服务：全部为纯函数，不直接读写 localStorage。
// 合并结果先在内存中计算，再交给 store 一次性替换；任何环节失败都不会改动现有数据。

import type {
  CardMastery,
  Domain,
  KnowledgeCard,
  MasteryLevel,
  StudyLog,
  StudyPlan,
  StudyResource,
  UnlockedMap,
} from '@/types'
import { ACHIEVEMENTS, CARD_MASTERY_LEVELS, DOMAINS } from '@/constants'
import { uid } from '@/utils/id'
import { toDateKey } from '@/utils/date'

export const BACKUP_APP = 'family-study-manager'
export const BACKUP_TYPE = 'backup'
export const BACKUP_VERSION = 1

/** 备份文件中承载的四类业务数据 */
export interface BackupData {
  plans: StudyPlan[]
  logs: StudyLog[]
  cards: KnowledgeCard[]
  unlocked: UnlockedMap
}

/** 导出文件的完整结构 */
export interface BackupFile extends BackupData {
  app: string
  type: string
  version: number
  exportedAt: string
}

export interface RecordCounts {
  plans: number
  logs: number
  cards: number
  achievements: number
}

/** 备份文件解析结果（已剔除损坏记录） */
export interface ParsedBackup {
  data: BackupData
  exportedAt: string
  /** 因字段缺失/非法而被丢弃的记录数 */
  dropped: RecordCounts
}

export type ConflictAction = 'overwrite' | 'skip'

/** 同名（计划）/同标题（卡片）冲突项，action 由用户在弹窗中决定 */
export interface ConflictItem<T> {
  incoming: T
  existing: T
  action: ConflictAction
}

/** 导入前的分析结果：冲突清单 + 各项计数 */
export interface ImportPlan {
  exportedAt: string
  data: BackupData
  /** 按名称去重后待处理的计划（备份内同名只保留第一条） */
  incomingPlans: StudyPlan[]
  incomingCards: KnowledgeCard[]
  planConflicts: ConflictItem<StudyPlan>[]
  cardConflicts: ConflictItem<KnowledgeCard>[]
  addPlans: number
  addCards: number
  addLogs: number
  addAchievements: number
  dropped: RecordCounts
}

export interface ImportStats {
  plansAdded: number
  plansOverwritten: number
  plansSkipped: number
  cardsAdded: number
  cardsOverwritten: number
  cardsSkipped: number
  logsAdded: number
  logsSkipped: number
  achievementsAdded: number
  dropped: RecordCounts
}

export interface MergeResult {
  data: BackupData
  stats: ImportStats
}

/** 备份文件格式或内容校验失败 */
export class BackupError extends Error {}

// ---------------------------------------------------------------------------
// 基础类型守卫
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 严格校验 YYYY-MM-DD 且为真实日历日期 */
function isDateKey(v: unknown): v is string {
  if (!isString(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function isDomain(v: unknown): v is Domain {
  return isString(v) && (DOMAINS as readonly string[]).includes(v)
}

function isCardMastery(v: unknown): v is CardMastery {
  return isString(v) && (CARD_MASTERY_LEVELS as readonly string[]).includes(v)
}

function isLogMastery(v: unknown): v is MasteryLevel {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 1 && v <= 5
}

function nonEmptyId(v: unknown): string {
  return isString(v) && v.trim() !== '' ? v : uid()
}

function optionalDateKey(v: unknown): string | undefined {
  return isDateKey(v) ? v : undefined
}

function compact<T>(arr: (T | null)[]): T[] {
  return arr.filter((x): x is T => x !== null)
}

// ---------------------------------------------------------------------------
// 单条记录规范化：字段缺失尽量补默认值，关键字段非法则丢弃该条
// ---------------------------------------------------------------------------

function normalizePlan(raw: unknown): StudyPlan | null {
  if (!isObject(raw)) return null
  if (!isString(raw.name) || raw.name.trim() === '') return null
  if (!isDomain(raw.domain)) return null
  if (!isDateKey(raw.startDate) || !isDateKey(raw.endDate)) return null
  if (!isFiniteNumber(raw.totalHours) || raw.totalHours < 0) return null
  if (!isFiniteNumber(raw.dailyHours) || raw.dailyHours < 0) return null

  const resources: StudyResource[] = Array.isArray(raw.resources)
    ? compact(
        raw.resources.map((r): StudyResource | null => {
          if (!isObject(r) || !isString(r.name) || r.name.trim() === '') return null
          return {
            id: nonEmptyId(r.id),
            name: r.name,
            link: isString(r.link) ? r.link : '',
          }
        }),
      )
    : []

  const plan: StudyPlan = {
    id: nonEmptyId(raw.id),
    name: raw.name,
    domain: raw.domain,
    goal: isString(raw.goal) ? raw.goal : '',
    startDate: raw.startDate,
    endDate: raw.endDate,
    totalHours: raw.totalHours,
    dailyHours: raw.dailyHours,
    resources,
    createdAt: isString(raw.createdAt) && raw.createdAt ? raw.createdAt : new Date().toISOString(),
  }
  if (isString(raw.completedAt) && raw.completedAt) plan.completedAt = raw.completedAt
  return plan
}

function normalizeLog(raw: unknown): StudyLog | null {
  if (!isObject(raw)) return null
  if (!isDateKey(raw.date)) return null
  if (!isString(raw.content)) return null
  if (!isFiniteNumber(raw.duration) || raw.duration < 0) return null
  if (!isLogMastery(raw.mastery)) return null

  return {
    id: nonEmptyId(raw.id),
    planId: isString(raw.planId) && raw.planId ? raw.planId : undefined,
    date: raw.date,
    content: raw.content,
    duration: raw.duration,
    mastery: raw.mastery,
    problem: isString(raw.problem) ? raw.problem : '',
    solution: isString(raw.solution) ? raw.solution : '',
    notes: isString(raw.notes) ? raw.notes : '',
    createdAt: isString(raw.createdAt) && raw.createdAt ? raw.createdAt : new Date().toISOString(),
  }
}

function normalizeCard(raw: unknown): KnowledgeCard | null {
  if (!isObject(raw)) return null
  if (!isString(raw.title) || raw.title.trim() === '') return null
  if (!isDomain(raw.domain)) return null
  if (!isCardMastery(raw.mastery)) return null

  const tags = Array.isArray(raw.tags) ? raw.tags.filter(isString) : []
  const card: KnowledgeCard = {
    id: nonEmptyId(raw.id),
    title: raw.title,
    domain: raw.domain,
    question: isString(raw.question) ? raw.question : '',
    answer: isString(raw.answer) ? raw.answer : '',
    tags,
    mastery: raw.mastery,
    reviewCount:
      isFiniteNumber(raw.reviewCount) && Number.isInteger(raw.reviewCount) && raw.reviewCount >= 0
        ? raw.reviewCount
        : 0,
    createdAt: isString(raw.createdAt) && raw.createdAt ? raw.createdAt : new Date().toISOString(),
  }
  const lastReviewedAt = optionalDateKey(raw.lastReviewedAt)
  if (lastReviewedAt) card.lastReviewedAt = lastReviewedAt
  return card
}

const ACHIEVEMENT_CODES = new Set(ACHIEVEMENTS.map((a) => a.code))

function normalizeUnlocked(raw: unknown): { unlocked: UnlockedMap; dropped: number } {
  if (!isObject(raw)) return { unlocked: {}, dropped: 0 }
  const unlocked: UnlockedMap = {}
  let dropped = 0
  for (const [code, date] of Object.entries(raw)) {
    if (ACHIEVEMENT_CODES.has(code) && isDateKey(date)) {
      unlocked[code] = date
    } else {
      dropped++
    }
  }
  return { unlocked, dropped }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 组装备份文件对象 */
export function buildBackup(current: BackupData): BackupFile {
  return {
    app: BACKUP_APP,
    type: BACKUP_TYPE,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    plans: current.plans,
    logs: current.logs,
    cards: current.cards,
    unlocked: current.unlocked,
  }
}

/** 一键导出：序列化为 JSON 并触发浏览器下载 */
export function downloadBackup(current: BackupData): void {
  const json = JSON.stringify(buildBackup(current), null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `知识管家备份-${toDateKey(new Date())}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// 导入：解析 & 格式校验（只校验、不写数据）
// ---------------------------------------------------------------------------

/**
 * 解析备份文件文本。
 * 顶层结构不符合备份格式时抛 BackupError；单条记录损坏则剔除并计数，不影响其他记录。
 */
export function parseBackup(text: string): ParsedBackup {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new BackupError('文件不是有效的 JSON，请确认选择的是本应用导出的备份文件')
  }
  if (!isObject(json)) {
    throw new BackupError('备份内容格式不正确：顶层不是对象')
  }
  if (json.app !== BACKUP_APP || json.type !== BACKUP_TYPE) {
    throw new BackupError('文件格式不正确：缺少备份标识，请选择本应用导出的 .json 备份文件')
  }
  if (json.version !== BACKUP_VERSION) {
    throw new BackupError(
      `备份文件版本（v${String(json.version)}）不受支持，当前仅支持 v${BACKUP_VERSION}`,
    )
  }
  if (!isString(json.exportedAt) || json.exportedAt === '') {
    throw new BackupError('备份内容格式不正确：缺少导出时间')
  }
  if (!Array.isArray(json.plans) || !Array.isArray(json.logs) || !Array.isArray(json.cards)) {
    throw new BackupError('备份内容格式不正确：计划、日志、卡片必须是数组')
  }
  if (!isObject(json.unlocked)) {
    throw new BackupError('备份内容格式不正确：成就数据必须是对象')
  }

  const rawPlans = compact(json.plans.map(normalizePlan))
  const rawLogs = compact(json.logs.map(normalizeLog))
  const rawCards = compact(json.cards.map(normalizeCard))
  const { unlocked, dropped: droppedAchievements } = normalizeUnlocked(json.unlocked)

  return {
    data: { plans: rawPlans, logs: rawLogs, cards: rawCards, unlocked },
    exportedAt: json.exportedAt,
    dropped: {
      plans: json.plans.length - rawPlans.length,
      logs: json.logs.length - rawLogs.length,
      cards: json.cards.length - rawCards.length,
      achievements: droppedAchievements,
    },
  }
}

// ---------------------------------------------------------------------------
// 导入：冲突分析与内存合并
// ---------------------------------------------------------------------------

/** 按名称/标题去重，备份内的重复项只保留第一条 */
function dedupeBy<T>(items: T[], keyOf: (item: T) => string): { unique: T[]; dropped: number } {
  const seen = new Set<string>()
  const unique: T[] = []
  let dropped = 0
  for (const item of items) {
    const key = keyOf(item).trim()
    if (seen.has(key)) {
      dropped++
      continue
    }
    seen.add(key)
    unique.push(item)
  }
  return { unique, dropped }
}

/**
 * 分析备份与本地数据的冲突，生成待用户确认的导入计划。
 * 同名计划、同标题卡片记为冲突，默认动作是“跳过”（更安全的选择）。
 */
export function analyzeImport(current: BackupData, parsed: ParsedBackup): ImportPlan {
  const { unique: incomingPlans, dropped: dupPlans } = dedupeBy(parsed.data.plans, (p) => p.name)
  const { unique: incomingCards, dropped: dupCards } = dedupeBy(parsed.data.cards, (c) => c.title)

  const currentPlanByName = new Map(current.plans.map((p) => [p.name.trim(), p]))
  const currentCardByTitle = new Map(current.cards.map((c) => [c.title.trim(), c]))

  const planConflicts: ConflictItem<StudyPlan>[] = []
  for (const incoming of incomingPlans) {
    const existing = currentPlanByName.get(incoming.name.trim())
    if (existing) planConflicts.push({ incoming, existing, action: 'skip' })
  }

  const cardConflicts: ConflictItem<KnowledgeCard>[] = []
  for (const incoming of incomingCards) {
    const existing = currentCardByTitle.get(incoming.title.trim())
    if (existing) cardConflicts.push({ incoming, existing, action: 'skip' })
  }

  // 日志按业务指纹去重（同一内容重复导入不会产生重复日志）
  const logSigs = new Set(current.logs.map(logSignature))
  let addLogs = 0
  for (const log of parsed.data.logs) {
    const sig = logSignature(log)
    if (!logSigs.has(sig)) {
      addLogs++
      logSigs.add(sig)
    }
  }

  const addAchievements = Object.keys(parsed.data.unlocked).filter(
    (code) => !(code in current.unlocked),
  ).length

  return {
    exportedAt: parsed.exportedAt,
    data: parsed.data,
    incomingPlans,
    incomingCards,
    planConflicts,
    cardConflicts,
    addPlans: incomingPlans.length - planConflicts.length,
    addCards: incomingCards.length - cardConflicts.length,
    addLogs,
    addAchievements,
    dropped: {
      plans: parsed.dropped.plans + dupPlans,
      logs: parsed.dropped.logs,
      cards: parsed.dropped.cards + dupCards,
      achievements: parsed.dropped.achievements,
    },
  }
}

/** 日志业务指纹：不含 id / planId，便于跨设备识别重复日志 */
function logSignature(log: StudyLog): string {
  return [log.date, log.content, log.duration, log.mastery].join('|')
}

/** 新记录在前，与 store 的 unshift 展示习惯保持一致 */
function newestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/**
 * 在内存中执行合并，返回完整的下一状态与统计。
 * 不写入任何存储；调用方拿到结果后再交给 store 替换，失败可整体回滚。
 */
export function mergeImport(current: BackupData, plan: ImportPlan): MergeResult {
  const stats: ImportStats = {
    plansAdded: 0,
    plansOverwritten: 0,
    plansSkipped: 0,
    cardsAdded: 0,
    cardsOverwritten: 0,
    cardsSkipped: 0,
    logsAdded: 0,
    logsSkipped: 0,
    achievementsAdded: 0,
    dropped: plan.dropped,
  }

  // ---- 计划：冲突覆盖时沿用本地 id，保证日志关联不断裂 ----
  const plans = [...current.plans]
  const currentPlanByName = new Map(current.plans.map((p) => [p.name.trim(), p]))
  const planActions = new Map(plan.planConflicts.map((c) => [c.incoming.id, c.action]))
  // 备份计划 id → 合并后本地计划 id
  const planIdMap = new Map<string, string>()

  for (const incoming of plan.incomingPlans) {
    const existing = currentPlanByName.get(incoming.name.trim())
    if (existing) {
      planIdMap.set(incoming.id, existing.id)
      if (planActions.get(incoming.id) === 'overwrite') {
        const index = plans.findIndex((p) => p.id === existing.id)
        plans[index] = { ...incoming, id: existing.id }
        stats.plansOverwritten++
      } else {
        stats.plansSkipped++
      }
    } else {
      plans.push(incoming)
      planIdMap.set(incoming.id, incoming.id)
      stats.plansAdded++
    }
  }

  // ---- 卡片 ----
  const cards = [...current.cards]
  const currentCardByTitle = new Map(current.cards.map((c) => [c.title.trim(), c]))
  const cardActions = new Map(plan.cardConflicts.map((c) => [c.incoming.id, c.action]))

  for (const incoming of plan.incomingCards) {
    const existing = currentCardByTitle.get(incoming.title.trim())
    if (existing) {
      if (cardActions.get(incoming.id) === 'overwrite') {
        const index = cards.findIndex((c) => c.id === existing.id)
        cards[index] = { ...incoming, id: existing.id }
        stats.cardsOverwritten++
      } else {
        stats.cardsSkipped++
      }
    } else {
      cards.push(incoming)
      stats.cardsAdded++
    }
  }

  // ---- 日志：重写 planId 关联；按指纹跳过重复 ----
  const localPlanIds = new Set(current.plans.map((p) => p.id))
  const logs = [...current.logs]
  const logSigs = new Set(current.logs.map(logSignature))

  for (const incoming of plan.data.logs) {
    let planId = incoming.planId
    if (planId) {
      const mapped = planIdMap.get(planId)
      if (mapped) {
        planId = mapped
      } else if (!localPlanIds.has(planId)) {
        // 关联的计划不在备份中、本地也不存在：保留日志但解除悬空关联
        planId = undefined
      }
    }
    const log: StudyLog = { ...incoming, planId }
    const sig = logSignature(log)
    if (logSigs.has(sig)) {
      stats.logsSkipped++
      continue
    }
    logSigs.add(sig)
    logs.push(log)
    stats.logsAdded++
  }

  // ---- 已解锁成就：保留较早的解锁日期 ----
  const unlocked: UnlockedMap = { ...current.unlocked }
  for (const [code, date] of Object.entries(plan.data.unlocked)) {
    const existingDate = unlocked[code]
    if (!existingDate) {
      unlocked[code] = date
      stats.achievementsAdded++
    } else if (date < existingDate) {
      unlocked[code] = date
    }
  }

  return {
    data: {
      plans: newestFirst(plans),
      logs: newestFirst(logs),
      cards: newestFirst(cards),
      unlocked,
    },
    stats,
  }
}
