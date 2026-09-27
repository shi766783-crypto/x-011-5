import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LogInput, StudyLog } from '@/types'
import { STORAGE_KEYS } from '@/constants'
import { read, write } from '@/services/storage'
import { uid } from '@/utils/id'

export const useLogsStore = defineStore('logs', () => {
  const logs = ref<StudyLog[]>(read<StudyLog[]>(STORAGE_KEYS.logs, []))

  function persist(): void {
    write(STORAGE_KEYS.logs, logs.value)
  }

  function addLog(input: LogInput): StudyLog {
    const log: StudyLog = { ...input, id: uid(), createdAt: new Date().toISOString() }
    logs.value.unshift(log)
    persist()
    return log
  }

  function updateLog(id: string, patch: Partial<StudyLog>): void {
    const target = logs.value.find((l) => l.id === id)
    if (target) {
      Object.assign(target, patch)
      persist()
    }
  }

  function removeLog(id: string): void {
    logs.value = logs.value.filter((l) => l.id !== id)
    persist()
  }

  /** 导入恢复时整体替换（由备份流程统一调用） */
  function replaceAll(next: StudyLog[]): void {
    logs.value = next
    persist()
  }

  return { logs, addLog, updateLog, removeLog, replaceAll }
})
