import {
  type CancelWorkInput,
  type ConfigureCredentialInput,
  type CreateSystemInput,
  type FeedbackAction,
  type CandidateDecisionInput,
  type CompareCandidateInput,
  type PrepareCandidateInput,
  type RollbackMethodInput,
  type SelectModelInput,
  type StartWorkInput,
  type SubmitFeedbackInput,
} from '../shared/ipc.js'

const MODEL_CHOICES = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])
const FEEDBACK_ACTIONS = new Set<FeedbackAction>(['edit', 'keep', 'reject', 'rewrite'])
const RUN_ID_PATTERN = /^run-[0-9a-f-]+$/u
const KEBAB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export function validateCredentialInput(value: unknown): ConfigureCredentialInput {
  const record = exactRecord(value, ['apiKey'], 'API Key')
  return { apiKey: text(record.apiKey, 'API Key', 4096, false, false) }
}

export function validateModelInput(value: unknown): SelectModelInput {
  const record = exactRecord(value, ['model'], '模型选择')
  if (typeof record.model !== 'string' || !MODEL_CHOICES.has(record.model)) {
    throw new TypeError('只支持 DeepSeek V4 Pro 或 V4 Flash。')
  }
  return { model: record.model as SelectModelInput['model'] }
}

export function validateCreateSystemInput(value: unknown): CreateSystemInput {
  const record = exactRecord(value, ['intent', 'displayName'], '创作系统')
  const intent = text(record.intent, '创作方向', 100_000, true)
  if (record.displayName === undefined) return { intent }
  return { intent, displayName: text(record.displayName, '创作系统名称', 120) }
}

export function validateStartWorkInput(value: unknown): StartWorkInput {
  const record = exactRecord(value, ['task'], '创作任务')
  return { task: text(record.task, '创作任务', 100_000, true) }
}

export function validateCancelWorkInput(value: unknown): CancelWorkInput {
  const record = exactRecord(value, ['runId'], '取消创作')
  if (record.runId !== 'active'
    && (typeof record.runId !== 'string' || !RUN_ID_PATTERN.test(record.runId))) {
    throw new TypeError('无效的运行标识。')
  }
  return { runId: record.runId as string }
}

export function validateFeedbackInput(value: unknown): SubmitFeedbackInput {
  const record = exactRecord(
    value,
    ['runId', 'action', 'feedbackText', 'editedText'],
    '创作反馈',
  )
  if (typeof record.runId !== 'string' || !RUN_ID_PATTERN.test(record.runId)) {
    throw new TypeError('无效的运行标识。')
  }
  if (typeof record.action !== 'string' || !FEEDBACK_ACTIONS.has(record.action as FeedbackAction)) {
    throw new TypeError('反馈动作无效。')
  }
  const action = record.action as FeedbackAction
  const feedbackText = record.feedbackText === undefined
    ? undefined
    : text(record.feedbackText, '文字反馈', 20_000, true)
  const editedText = record.editedText === undefined
    ? undefined
    : text(record.editedText, '修改后作品', 500_000, true)
  if (action === 'edit' && editedText === undefined) {
    throw new TypeError('直接修改必须包含修改后的作品。')
  }
  if (action !== 'edit' && editedText !== undefined) {
    throw new TypeError('只有直接修改可以提交修改后作品。')
  }
  if ((action === 'reject' || action === 'rewrite') && feedbackText === undefined) {
    throw new TypeError('拒绝或重写时请说明原因。')
  }
  return {
    runId: record.runId,
    action,
    ...(feedbackText === undefined ? {} : { feedbackText }),
    ...(editedText === undefined ? {} : { editedText }),
  }
}

export function validatePrepareCandidateInput(value: unknown): PrepareCandidateInput {
  const record = exactRecord(value, ['observationId'], '方法候选')
  return { observationId: kebabId(record.observationId, '观察标识') }
}

export function validateCompareCandidateInput(value: unknown): CompareCandidateInput {
  const record = exactRecord(value, ['candidateId', 'phase', 'choice'], '盲比选择')
  const phase = record.phase
  const choice = record.choice
  if (phase !== 'targeted' && phase !== 'regression' && phase !== 'heldout') {
    throw new TypeError('盲比阶段无效。')
  }
  if (choice !== 'A' && choice !== 'B' && choice !== 'TIE') {
    throw new TypeError('盲比选择无效。')
  }
  return { candidateId: kebabId(record.candidateId, '候选标识'), phase, choice }
}

export function validateCandidateDecisionInput(value: unknown): CandidateDecisionInput {
  const record = exactRecord(value, ['candidateId'], '候选决定')
  return { candidateId: kebabId(record.candidateId, '候选标识') }
}

export function validateRollbackMethodInput(value: unknown): RollbackMethodInput {
  const record = exactRecord(value, ['version'], '方法回滚')
  return { version: kebabId(record.version, '方法版本') }
}

function kebabId(value: unknown, label: string): string {
  const result = text(value, label, 120)
  if (!KEBAB_ID_PATTERN.test(result)) throw new TypeError(`${label}无效。`)
  return result
}

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label}输入无效。`)
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${label}包含不支持的字段。`)
  }
  return value
}

function text(
  value: unknown,
  label: string,
  maximumBytes: number,
  multiline = false,
  trim = true,
): string {
  if (typeof value !== 'string'
    || value.includes('\0')
    || (!multiline && /[\r\n]/u.test(value))
    || value.trim() === ''
    || (trim && value !== value.trim())
    || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new TypeError(`${label}为空、过长或包含非法字符。`)
  }
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}
