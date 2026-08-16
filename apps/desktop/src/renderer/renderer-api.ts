import type {
  DshModelId,
  RuntimeEvent,
  RuntimeRunHandle,
} from '@creative-loop2rsi/runtime-dsh'

import type { CreativeRsiApi, StudioStatus } from '../shared/ipc.js'
import type {
  AdoptedPrincipleSnapshot,
  MethodCandidateSnapshot,
  MethodComparisonChoice,
  MethodComparisonPhase,
  MethodHistorySnapshot,
  MethodObservationSnapshot,
} from '../shared/ipc.js'

export type MainSection = 'create' | 'learning' | 'new-methods' | 'versions'
export type FeedbackAction = 'keep' | 'rewrite' | 'reject' | 'edit'

export interface LearningView {
  readonly observations: readonly MethodObservationSnapshot[]
  readonly adoptedPrinciples: readonly AdoptedPrincipleSnapshot[]
}

export interface CurrentWorkView {
  readonly id?: string
  readonly output?: string
  readonly frozen?: boolean
}

export interface MethodView {
  readonly activeVersion: string
  readonly activeGuidance: string | null
  readonly currentName: string
  readonly stageLabel: string
  readonly history: readonly MethodHistorySnapshot[]
}

export interface StudioViewStatus extends StudioStatus {
  readonly currentWork?: CurrentWorkView
  readonly learning?: LearningView
  readonly method?: MethodView
  readonly newMethods?: readonly MethodCandidateSnapshot[]
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

export class PreviewCapabilityError extends Error {
  constructor(readonly capability: 'credential' | 'model' | 'feedback' | 'candidate' | 'rollback') {
    super(capability)
    this.name = 'PreviewCapabilityError'
  }
}

function api(): CreativeRsiApi {
  return window.creativeRsi
}

export async function getStudioStatus(): Promise<StudioViewStatus> {
  return toViewStatus(await api().getStatus())
}

export async function configureCredential(
  key: string,
  allowSessionOnly: boolean,
): Promise<StudioViewStatus> {
  const result = await api().credentials.configure({ apiKey: key, allowSessionOnly })
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

export async function prepareNewMethod(observationId: string): Promise<StudioViewStatus> {
  await api().candidates.prepare({ observationId })
  return await getStudioStatus()
}

export async function compareNewMethod(
  candidateId: string,
  phase: MethodComparisonPhase,
  choice: MethodComparisonChoice,
): Promise<StudioViewStatus> {
  await api().candidates.compare({ candidateId, phase, choice })
  return await getStudioStatus()
}

export async function adoptNewMethod(candidateId: string): Promise<StudioViewStatus> {
  await api().candidates.adopt({ candidateId })
  return await getStudioStatus()
}

export async function rejectNewMethod(candidateId: string): Promise<StudioViewStatus> {
  await api().candidates.reject({ candidateId })
  return await getStudioStatus()
}

export async function rollbackMethod(version: string): Promise<StudioViewStatus> {
  await api().releases.rollback({ version })
  return await getStudioStatus()
}

export function toViewStatus(status: StudioStatus): StudioViewStatus {
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
            activeVersion: system.method.activeVersion,
            activeGuidance: system.method.activeGuidance,
            currentName: system.method.activeVersion === 'baseline-v1'
              ? '通用起步方法'
              : '你采用的新创作方法',
            stageLabel: system.method.activeGuidance
              ?? (system.charterConfirmed
                ? '已形成由你确认的创作方法'
                : '正在从真实创作与明确反馈中了解方向'),
            history: system.method.history,
          },
          learning: {
            observations: system.observations,
            adoptedPrinciples: system.adoptedPrinciples,
          },
          newMethods: system.methodCandidates,
        }),
  }
}
