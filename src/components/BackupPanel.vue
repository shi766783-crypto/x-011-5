<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { KnowledgeCard, StudyPlan } from '@/types'
import { useAchievementsStore } from '@/stores/achievements'
import { useCardsStore } from '@/stores/cards'
import { useLogsStore } from '@/stores/logs'
import { usePlansStore } from '@/stores/plans'
import type { BackupData, RecordCounts } from '@/services/backup'
import {
  BackupError,
  analyzeImport,
  downloadBackup,
  mergeImport,
  parseBackup,
  type ConflictAction,
  type ConflictItem,
  type ImportPlan,
  type ImportStats,
} from '@/services/backup'

const plansStore = usePlansStore()
const logsStore = useLogsStore()
const cardsStore = useCardsStore()
const achievementsStore = useAchievementsStore()

const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)

// 冲突确认弹窗
const conflictVisible = ref(false)
const planData = ref<ImportPlan | null>(null)

// 导入结果弹窗
const resultVisible = ref(false)
const resultStats = ref<ImportStats | null>(null)

const planConflicts = computed<ConflictItem<StudyPlan>[]>(() => planData.value?.planConflicts ?? [])
const cardConflicts = computed<ConflictItem<KnowledgeCard>[]>(() => planData.value?.cardConflicts ?? [])

function currentData(): BackupData {
  return {
    plans: plansStore.plans,
    logs: logsStore.logs,
    cards: cardsStore.cards,
    unlocked: achievementsStore.unlocked,
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

function handleExport(): void {
  try {
    // 深拷贝，避免下载序列化期间数据变动造成不一致
    downloadBackup(JSON.parse(JSON.stringify(currentData())) as BackupData)
    ElMessage.success('备份文件已开始下载')
  } catch {
    ElMessage.error('导出失败，请重试')
  }
}

// ---------------------------------------------------------------------------
// 导入：选择文件 → 校验 → 冲突确认 → 内存合并 → 原子替换（失败回滚）
// ---------------------------------------------------------------------------

function triggerImport(): void {
  fileInput.value?.click()
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空 value，保证再次选择同一文件也能触发 change
  input.value = ''
  if (!file) return

  importing.value = true
  try {
    const text = await file.text()
    const parsed = parseBackup(text) // 格式不合法时抛 BackupError，现有数据完全不受影响
    const current = currentData()
    planData.value = analyzeImport(current, parsed)
    conflictVisible.value = true
  } catch (err) {
    ElMessage.error(err instanceof BackupError ? err.message : '读取文件失败，请重试')
  } finally {
    importing.value = false
  }
}

function setAllPlanActions(action: ConflictAction): void {
  planConflicts.value.forEach((c) => (c.action = action))
}

function setAllCardActions(action: ConflictAction): void {
  cardConflicts.value.forEach((c) => (c.action = action))
}

function droppedTotal(d: RecordCounts): number {
  return d.plans + d.logs + d.cards + d.achievements
}

function confirmImport(): void {
  if (!planData.value) return

  // 写入前快照旧数据；任一步骤写入失败即回滚，保证不出现半导入状态
  const snapshot: BackupData = JSON.parse(JSON.stringify(currentData()))
  let merged: BackupData
  let stats: ImportStats
  try {
    const result = mergeImport(currentData(), planData.value)
    merged = result.data
    stats = result.stats

    plansStore.replaceAll(merged.plans)
    logsStore.replaceAll(merged.logs)
    cardsStore.replaceAll(merged.cards)
    achievementsStore.replaceAll(merged.unlocked)
  } catch {
    plansStore.replaceAll(snapshot.plans)
    logsStore.replaceAll(snapshot.logs)
    cardsStore.replaceAll(snapshot.cards)
    achievementsStore.replaceAll(snapshot.unlocked)
    conflictVisible.value = false
    ElMessage.error('导入过程中发生错误，已恢复到导入前的数据')
    return
  }

  // 数据变化后重新评估成就（App.vue 的 watch 也会触发，这里确保立即一致）
  achievementsStore.checkAll()

  resultStats.value = stats
  conflictVisible.value = false
  resultVisible.value = true
}
</script>

<template>
  <el-card shadow="never" class="backup-card">
    <div class="backup-body">
      <div class="backup-info">
        <span class="backup-icon">💾</span>
        <div>
          <div class="backup-title">数据备份与恢复</div>
          <div class="backup-desc">
            一键导出全部计划、日志、卡片与已解锁成就为文件；换机或清理缓存后可导入恢复。
          </div>
        </div>
      </div>
      <div class="backup-actions">
        <el-button type="primary" @click="handleExport">导出备份</el-button>
        <el-button type="success" :loading="importing" @click="triggerImport">导入恢复</el-button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="file-input"
          @change="handleFileChange"
        />
      </div>
    </div>

    <!-- 导入预览 & 冲突选择 -->
    <el-dialog
      v-model="conflictVisible"
      title="确认导入"
      width="640px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <template v-if="planData">
        <el-alert
          v-if="droppedTotal(planData.dropped) > 0"
          type="warning"
          :closable="false"
          class="conflict-alert"
        >
          备份中有 {{ droppedTotal(planData.dropped) }}
          条记录格式异常（计划 {{ planData.dropped.plans }} / 日志 {{ planData.dropped.logs }}
          / 卡片 {{ planData.dropped.cards }} / 成就 {{ planData.dropped.achievements }}），将自动跳过。
        </el-alert>

        <p class="summary-line">
          将新增
          <b>{{ planData.addPlans }}</b> 个计划、<b>{{ planData.addCards }}</b> 张卡片、<b>{{ planData.addLogs }}</b>
          条日志、<b>{{ planData.addAchievements }}</b> 个成就。
        </p>

        <template v-if="planConflicts.length > 0">
          <div class="conflict-head">
            <span>同名计划（{{ planConflicts.length }}）</span>
            <div class="batch-ops">
              <el-button size="small" text type="primary" @click="setAllPlanActions('overwrite')">
                全部覆盖
              </el-button>
              <el-button size="small" text type="info" @click="setAllPlanActions('skip')">
                全部跳过
              </el-button>
            </div>
          </div>
          <el-table :data="planConflicts" size="small" class="conflict-table">
            <el-table-column prop="incoming.name" label="计划名称" min-width="140" />
            <el-table-column prop="incoming.domain" label="领域" width="90" />
            <el-table-column label="操作" width="150" align="center">
              <template #default="{ row }">
                <el-radio-group v-model="row.action" size="small">
                  <el-radio value="overwrite">覆盖</el-radio>
                  <el-radio value="skip">跳过</el-radio>
                </el-radio-group>
              </template>
            </el-table-column>
          </el-table>
        </template>

        <template v-if="cardConflicts.length > 0">
          <div class="conflict-head">
            <span>同名卡片（{{ cardConflicts.length }}）</span>
            <div class="batch-ops">
              <el-button size="small" text type="primary" @click="setAllCardActions('overwrite')">
                全部覆盖
              </el-button>
              <el-button size="small" text type="info" @click="setAllCardActions('skip')">
                全部跳过
              </el-button>
            </div>
          </div>
          <el-table :data="cardConflicts" size="small" class="conflict-table">
            <el-table-column prop="incoming.title" label="卡片标题" min-width="140" />
            <el-table-column prop="incoming.domain" label="领域" width="90" />
            <el-table-column label="操作" width="150" align="center">
              <template #default="{ row }">
                <el-radio-group v-model="row.action" size="small">
                  <el-radio value="overwrite">覆盖</el-radio>
                  <el-radio value="skip">跳过</el-radio>
                </el-radio-group>
              </template>
            </el-table-column>
          </el-table>
        </template>

        <el-alert
          v-if="planConflicts.length === 0 && cardConflicts.length === 0"
          type="success"
          :closable="false"
          title="没有检测到同名计划或卡片，可直接导入"
        />
      </template>

      <template #footer>
        <el-button @click="conflictVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmImport">开始导入</el-button>
      </template>
    </el-dialog>

    <!-- 导入结果 -->
    <el-dialog v-model="resultVisible" title="导入完成" width="480px">
      <template v-if="resultStats">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="计划">
            新增 {{ resultStats.plansAdded }}，覆盖 {{ resultStats.plansOverwritten }}，跳过
            {{ resultStats.plansSkipped }}
          </el-descriptions-item>
          <el-descriptions-item label="卡片">
            新增 {{ resultStats.cardsAdded }}，覆盖 {{ resultStats.cardsOverwritten }}，跳过
            {{ resultStats.cardsSkipped }}
          </el-descriptions-item>
          <el-descriptions-item label="日志">
            新增 {{ resultStats.logsAdded }}，跳过重复 {{ resultStats.logsSkipped }}
          </el-descriptions-item>
          <el-descriptions-item label="成就">
            新增解锁 {{ resultStats.achievementsAdded }}
          </el-descriptions-item>
        </el-descriptions>
        <el-alert
          v-if="droppedTotal(resultStats.dropped) > 0"
          type="warning"
          :closable="false"
          class="result-warning"
          :title="`另有 ${droppedTotal(resultStats.dropped)} 条异常记录被跳过（计划 ${resultStats.dropped.plans} / 日志 ${resultStats.dropped.logs} / 卡片 ${resultStats.dropped.cards} / 成就 ${resultStats.dropped.achievements}）`"
        />
      </template>
      <template #footer>
        <el-button type="primary" @click="resultVisible = false">知道了</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.backup-card {
  margin-top: 20px;
}

.backup-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.backup-info {
  display: flex;
  align-items: center;
  gap: 14px;
}

.backup-icon {
  font-size: 32px;
}

.backup-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2d3d;
}

.backup-desc {
  margin-top: 4px;
  font-size: 13px;
  color: #909399;
  max-width: 520px;
}

.backup-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.file-input {
  display: none;
}

.conflict-alert {
  margin-bottom: 12px;
}

.summary-line {
  margin: 0 0 16px;
  font-size: 14px;
  color: #303133;
}

.conflict-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.batch-ops {
  display: flex;
  gap: 4px;
}

.conflict-table {
  margin-bottom: 16px;
}

.result-warning {
  margin-top: 14px;
}
</style>
