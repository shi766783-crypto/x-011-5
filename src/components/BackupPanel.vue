<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAchievementsStore } from '@/stores/achievements'
import { useCardsStore } from '@/stores/cards'
import { useLogsStore } from '@/stores/logs'
import { usePlansStore } from '@/stores/plans'
import {
  detectConflicts,
  downloadBackup,
  mergeBackup,
  parseBackup,
  type BackupData,
  type ConflictInfo,
  type ConflictStrategy,
} from '@/services/backup'

const plansStore = usePlansStore()
const logsStore = useLogsStore()
const cardsStore = useCardsStore()
const achievementsStore = useAchievementsStore()

/** 备份文件体积上限（localStorage 容量有限，超出即非合法备份） */
const MAX_FILE_SIZE = 20 * 1024 * 1024

function currentData(): BackupData {
  return {
    plans: plansStore.plans,
    logs: logsStore.logs,
    cards: cardsStore.cards,
    unlocked: achievementsStore.unlocked,
  }
}

// ---------- 导出 ----------

function handleExport(): void {
  downloadBackup(currentData())
  ElMessage.success('备份文件已导出，请妥善保存')
}

// ---------- 导入 ----------

const fileInput = ref<HTMLInputElement>()
const dialogVisible = ref(false)
const pendingData = ref<BackupData | null>(null)
const conflicts = ref<ConflictInfo>({ planNames: [], cardTitles: [] })
const strategy = ref<ConflictStrategy>('skip')

const hasConflict = computed(
  () => conflicts.value.planNames.length > 0 || conflicts.value.cardTitles.length > 0,
)

const pendingCounts = computed(() => {
  const data = pendingData.value
  if (!data) return { plans: 0, logs: 0, cards: 0, unlocked: 0 }
  return {
    plans: data.plans.length,
    logs: data.logs.length,
    cards: data.cards.length,
    unlocked: Object.keys(data.unlocked).length,
  }
})

function triggerPick(): void {
  fileInput.value?.click()
}

/** 选文件 → 校验 → 打开确认对话框；校验失败时只提示，不动任何现有数据 */
async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 重置，允许再次选择同一文件
  if (!file) return
  if (file.size > MAX_FILE_SIZE) {
    ElMessage.error('导入失败：文件过大，不是有效的备份文件')
    return
  }
  let text: string
  try {
    text = await file.text()
  } catch {
    ElMessage.error('导入失败：文件读取失败，请重试')
    return
  }
  const result = parseBackup(text)
  if (!result.ok) {
    ElMessage.error(`导入失败：${result.error}`)
    return
  }
  pendingData.value = result.data
  conflicts.value = detectConflicts(result.data, currentData())
  strategy.value = 'skip'
  dialogVisible.value = true
}

/** 确认导入：合并是纯函数，先算出完整结果再一次性写回各 store */
function confirmImport(): void {
  const data = pendingData.value
  if (!data) return
  const { data: merged, summary } = mergeBackup(data, currentData(), {
    planConflict: strategy.value,
    cardConflict: strategy.value,
  })
  plansStore.replaceAll(merged.plans)
  logsStore.replaceAll(merged.logs)
  cardsStore.replaceAll(merged.cards)
  achievementsStore.replaceAll(merged.unlocked)
  dialogVisible.value = false
  pendingData.value = null

  const parts = [
    `新增计划 ${summary.plansAdded} 个`,
    `日志 ${summary.logsAdded} 条`,
    `卡片 ${summary.cardsAdded} 张`,
  ]
  const overwritten = summary.plansOverwritten + summary.cardsOverwritten
  const skipped = summary.plansSkipped + summary.cardsSkipped + summary.logsSkipped
  if (overwritten > 0) parts.push(`覆盖 ${overwritten} 项`)
  if (skipped > 0) parts.push(`跳过 ${skipped} 项`)
  if (summary.achievementsAdded > 0) parts.push(`恢复成就 ${summary.achievementsAdded} 个`)
  ElMessage.success(`导入完成：${parts.join('，')}`)
}

function cancelImport(): void {
  dialogVisible.value = false
  pendingData.value = null
}

/** 列表过长时截断展示 */
function previewNames(names: string[]): string {
  const shown = names.slice(0, 5).join('、')
  return names.length > 5 ? `${shown} 等 ${names.length} 项` : shown
}
</script>

<template>
  <el-card shadow="never" class="backup-card">
    <template #header><span>数据备份</span></template>
    <div class="backup-body">
      <p class="backup-tip">
        所有数据仅保存在当前浏览器中，更换设备或清除缓存会丢失。建议定期导出备份文件，需要时可随时导入恢复。
      </p>
      <div class="backup-actions">
        <el-button type="primary" @click="handleExport">📤 导出备份</el-button>
        <el-button @click="triggerPick">📥 导入恢复</el-button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="file-input"
          @change="handleFileChange"
        />
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      title="导入备份"
      width="480px"
      :close-on-click-modal="false"
      @closed="cancelImport"
    >
      <div class="import-summary">
        <p>
          文件包含：计划 {{ pendingCounts.plans }} 个、日志 {{ pendingCounts.logs }} 条、 卡片
          {{ pendingCounts.cards }} 张、已解锁成就 {{ pendingCounts.unlocked }} 个。
        </p>
      </div>

      <template v-if="hasConflict">
        <el-alert type="warning" :closable="false" show-icon title="检测到与现有数据同名的内容" />
        <div class="conflict-list">
          <p v-if="conflicts.planNames.length > 0">
            <b>同名计划：</b>{{ previewNames(conflicts.planNames) }}
          </p>
          <p v-if="conflicts.cardTitles.length > 0">
            <b>同名卡片：</b>{{ previewNames(conflicts.cardTitles) }}
          </p>
        </div>
        <el-radio-group v-model="strategy" class="strategy-group">
          <el-radio value="skip">跳过同名数据（保留现有内容）</el-radio>
          <el-radio value="overwrite">覆盖同名数据（用备份替换现有内容）</el-radio>
        </el-radio-group>
      </template>
      <p v-else class="no-conflict">未发现同名冲突，可安全导入。</p>

      <template #footer>
        <el-button @click="cancelImport">取消</el-button>
        <el-button type="primary" @click="confirmImport">确认导入</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.backup-card {
  grid-column: 1 / -1;
}

.backup-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.backup-tip {
  margin: 0;
  font-size: 13px;
  color: #909399;
  line-height: 1.6;
}

.backup-actions {
  display: flex;
  gap: 12px;
}

.file-input {
  display: none;
}

.import-summary {
  font-size: 14px;
  color: #303133;
  margin-bottom: 12px;
}

.import-summary p {
  margin: 0;
}

.conflict-list {
  margin: 12px 0;
  font-size: 13px;
  color: #606266;
}

.conflict-list p {
  margin: 4px 0;
}

.strategy-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.no-conflict {
  font-size: 13px;
  color: #67c23a;
  margin: 0;
}
</style>
