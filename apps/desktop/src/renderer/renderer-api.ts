import type {
  DshModelId,
  RuntimeEvent,
  RuntimeRunHandle,
} from '@creative-loop2rsi/runtime-dsh'

import type { CreativeRsiApi, StudioStatus } from '../shared/ipc.js'

export type MainSection = 'create' | 'learning' | 'new-methods' | 'versions'
export type FeedbackAction = 'keep' | 'rewrite' | 'reject' | 'edit'

export interface LearningView {
  readonly observations?: readonly string[]
  readonly adoptedPrinciples?: readonly string[]
}

export interface CurrentWorkView {
  readonly id?: string
  readonly output?: string
  readonly frozen?: boolean
}

export interface MethodView {
  readonly currentName?: string
  readonly stageLabel?: string
  readonly history?: readonly {
    readonly id: string
    readonly label: string
    readonly adoptedAt?: string
  }[]
}

export interface NewMethodView {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly tradeoff?: string
  readonly status?: 'ready' | 'observing'
}

export interface StudioViewStatus extends StudioStatus {
  readonly currentWork?: CurrentWorkView
  readonly learning?: LearningView
  readonly method?: MethodView
  readonly newMethods?: readonly NewMethodView[]
}

export interface FeedbackInput {
  readonly action: FeedbackAction
  readonly text: string
  readonly editedText?: string
  readonly workId?: string
}

export interface FeedbackSubmissionViewResult {
  readonly outcome: 'submitted' | 'recovered-previous'
  readonly status: StudioViewStatus
}

type ExtendedCreativeRsiApi = CreativeRsiApi & {
  readonly candidates?: {
    adopt(id: string): Promise<void>
    reject(id: string): Promise<void>
  }
  readonly releases?: {
    rollback(id: string): Promise<void>
  }
}

export class PreviewCapabilityError extends Error {
  constructor(readonly capability: 'credential' | 'model' | 'feedback' | 'candidate' | 'rollback') {
    super(capability)
    this.name = 'PreviewCapabilityError'
  }
}

function api(): ExtendedCreativeRsiApi {
  return window.creativeRsi as unknown as ExtendedCreativeRsiApi
}

export async function getStudioStatus(): Promise<StudioViewStatus> {
  return toViewStatus(await api().getStatus())
}

export async function configureCredential(key: string): Promise<StudioViewStatus> {
  const result = await api().credentials.configure({ apiKey: key })
  if (!result.configured) throw new Error('连接信息没有通过验证。')
  return await getStudioStatus()
}

export async function selectModel(model: DshModelId): Promise<StudioViewStatus> {
  const status = await getStudioStatus()
  if (status.selectedModel === model) return status
  return toViewStatus(await api().model.select({ model }))
}

export async function startWork(input: string): Promise<RuntimeRunHandle> {
  const status = await api().getStatus()
  if (status.activeSystem === null) await api().systems.create({ intent: input })
  return await api().works.start({ task: input })
}

export function cancelWork(runId: string): Promise<void> {
  return api().works.cancel({ runId })
}

export async function submitHumanFeedback(input: FeedbackInput): Promise<FeedbackSubmissionViewResult> {
  if (input.workId === undefined) throw new PreviewCapabilityError('feedback')
  const result = await api().works.submitFeedback({
    runId: input.workId,
    action: input.action,
    ...(input.text === '' ? {} : { feedbackText: input.text }),
    ...(input.editedText === undefined ? {} : { editedText: input.editedText }),
  })
  return { outcome: result.outcome, status: await getStudioStatus() }
}

export function subscribeToWorkEvents(listener: (event: RuntimeEvent) => void): () => void {
  return api().works.onEvent(listener)
}

export async function adoptNewMethod(id: string): Promise<void> {
  const adopt = api().candidates?.adopt
  if (adopt === undefined) throw new PreviewCapabilityError('candidate')
  await adopt(id)
}

export async function rejectNewMethod(id: string): Promise<void> {
  const reject = api().candidates?.reject
  if (reject === undefined) throw new PreviewCapabilityError('candidate')
  await reject(id)
}

export async function rollbackMethod(id: string): Promise<void> {
  const rollback = api().releases?.rollback
  if (rollback === undefined) throw new PreviewCapabilityError('rollback')
  await rollback(id)
}

function toViewStatus(status: StudioStatus): StudioViewStatus {
  const system = status.activeSystem
  const work = system?.lastWork
  return {
    ...status,
    ...(work === null || work === undefined
      ? {}
      : {
          currentWork: {
            id: work.runId,
            output: work.output,
            frozen: work.sealed,
          },
        }),
    ...(system === null
      ? {}
      : {
          method: {
            currentName: system.displayName,
            stageLabel: system.charterConfirmed
              ? '已形成由你确认的创作方法'
              : '正在从真实创作与明确反馈中了解方向',
            history: [],
          },
          learning: {
            observations: [],
            adoptedPrinciples: [],
          },
          newMethods: [],
        }),
  }
}
