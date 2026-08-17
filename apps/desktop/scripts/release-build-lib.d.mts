import type { PreviewInventoryEntry } from './preview-build-lib.mjs'

export const RELEASE_VERSION: '1.0.0-alpha.1'
export const RELEASE_TAG: 'studio-v1.0.0-alpha.1'
export const PRODUCT_NAME: 'Creative RSI Studio'
export const MAIN_ARCHIVE_NAME: 'Creative-RSI-Studio-1.0.0-alpha.1-macos-arm64.zip'
export const EVIDENCE_ARCHIVE_NAME: 'Creative-RSI-Studio-1.0.0-alpha.1-evidence.zip'
export const CHECKSUMS_NAME: 'SHA256SUMS.txt'

export interface ReleaseArtifactIdentity {
  readonly bytes: number
  readonly sha256: string
}

export interface MacReleaseBuildOptions {
  readonly root: string
  readonly appPath?: string
  readonly appManifestPath?: string
  readonly sidecarManifestPath?: string
  readonly outputRoot?: string
}

export interface MacReleaseBuildResult {
  readonly outputRoot: string
  readonly mainArchive: string
  readonly evidenceArchive: string
  readonly checksums: string
  readonly source: { readonly git_commit: string; readonly git_tree: string }
  readonly mainArtifact: ReleaseArtifactIdentity
  readonly evidenceArtifact: ReleaseArtifactIdentity
}

export function releaseOutputPath(root: string): string
export function pinnedPnpmCli(root: string, entry?: string): Promise<string>
export function buildMacRelease(options: MacReleaseBuildOptions): Promise<MacReleaseBuildResult>
export function validateReleasePreview(options: {
  readonly root: string
  readonly app: string
  readonly appManifest: unknown
  readonly sidecarManifestPath: string
  readonly identity: { readonly git_commit: string; readonly git_tree: string }
  readonly packageStorePath: string
}): Promise<readonly PreviewInventoryEntry[]>
export function archiveMacApp(options: {
  readonly app: string
  readonly archive: string
  readonly expectedInventory: readonly PreviewInventoryEntry[]
  readonly packagedSmoke: (unpackedApp: string) => Promise<{
    readonly status: 'PASS'
    readonly app_version: string
    readonly packaged: true
    readonly credential: 'not-configured'
    readonly model_requests: 0
  }>
}): Promise<ReleaseArtifactIdentity & {
  readonly round_trip_inventory: 'PASS'
  readonly strict_codesign: 'PASS'
  readonly packaged_smoke: {
    readonly status: 'PASS'
    readonly app_version: string
    readonly packaged: true
    readonly credential: 'not-configured'
    readonly model_requests: 0
  }
}>
export function createDeliveryManifest(input: Readonly<Record<string, unknown>>): unknown
export function assertPathFreeManifest(value: unknown): void
export function renderChecksums(
  mainArtifact: ReleaseArtifactIdentity,
  evidenceArtifact: ReleaseArtifactIdentity,
): string
export function isExpectedUnsignedSpctlAssessment(code: number | null, value: string): boolean
export function classifyAdhocSpctlAssessment(
  code: number | null,
  value: string,
  diagnostic?: string,
): 'REJECTED_UNSIGNED_EXPECTED' | 'REJECTED_ADHOC_UNATTRIBUTED' | null
export function collectPackagedNodeComponents(payloadRoot: string): Promise<any[]>
export function assertRequiredDshProductionClosure(components: readonly any[]): string[]
export function buildPackagedReleaseEvidence(options: {
  readonly app: string
  readonly sidecarManifest: any
}): Promise<{ readonly licenses: any; readonly sbom: any }>
export function validatePackagedLicenseProvenance(
  app: string,
  nodePackages: readonly any[],
): Promise<{ readonly file: any; readonly sources: Map<string, any[]> }>
export function collectSharpLibvipsAggregate(app: string, nodePackages: readonly any[]): Promise<any[]>
export function createPackagedCycloneDx(input: Readonly<Record<string, any>>): any
export function assertSbomLicenseComponentParity(sbom: any, licenses: any): void
export function assertPackagedEvidenceBoundToAppManifest(licenses: any, appManifest: any): void
export function validateSourceArchiveEvidence(
  archivePath: string,
  manifestPath: string,
  identity: { readonly git_commit: string; readonly git_tree: string },
): Promise<any>
export function preparePublicEvidenceAuditTree(options: {
  readonly evidenceRoot: string
  readonly auditRoot: string
  readonly files: readonly string[]
  readonly sourceArchive: string
}): Promise<string[]>
