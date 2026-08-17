export interface PreviewInventoryFile {
  readonly path: string
  readonly type: 'file'
  readonly bytes: number
  readonly sha256: string
  readonly mode: string | null
}

export interface PreviewInventorySymlink {
  readonly path: string
  readonly type: 'symlink'
  readonly target: string
  readonly mode: string | null
}

export interface PreviewInventoryDirectory {
  readonly path: string
  readonly type: 'directory'
  readonly mode: string | null
}

export type PreviewInventoryEntry =
  | PreviewInventoryDirectory
  | PreviewInventoryFile
  | PreviewInventorySymlink

export const MAC_BUNDLE_SHORT_VERSION: '1.0.0'
export const MAC_BUNDLE_BUILD_VERSION: '1'
export const MAC_RUNTIME_COMPONENTS_FILE: 'runtime-components.json'
export const PACKAGED_NOTICE_MAPPINGS: readonly Readonly<Record<string, any>>[]

export interface RuntimeNoticeIdentity {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface ElectronRuntimeComponent {
  readonly name: 'Chromium' | 'Electron' | 'Node.js'
  readonly version: string
  readonly license: string
  readonly notices: readonly RuntimeNoticeIdentity[]
}

export interface ElectronRuntimeEvidence {
  readonly schema_version: '1'
  readonly kind: 'StudioRuntimeComponents'
  readonly components: readonly ElectronRuntimeComponent[]
}

export interface PreviewBuildOptions {
  readonly root: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly sidecarDirectory?: string
  readonly outputRoot?: string
}

export interface PreviewBuildResult {
  readonly outputRoot: string
  readonly manifestPath: string
  readonly source: Readonly<Record<string, string>>
  readonly inventory: readonly PreviewInventoryEntry[]
  readonly treeSha256: string
}

export function buildPreview(options: PreviewBuildOptions): Promise<PreviewBuildResult>
export function resolvePnpmCli(entry: string): Promise<string>
export function previewOutputPath(root: string, platform: string, arch: string): string
export function inventoryTree(
  root: string,
  options?: { readonly platform?: NodeJS.Platform },
): Promise<readonly PreviewInventoryEntry[]>
export function removePackageManagerMetadata(root: string): Promise<void>
export function removeRuntimeBuildMetadata(root: string): Promise<void>
export function auditPackagedTree(
  root: string,
  options?: {
    readonly platform?: NodeJS.Platform
    readonly packageStorePaths?: readonly string[]
  },
): Promise<readonly PreviewInventoryEntry[]>
export function assertPreviewEntrypoints(root: string, platform: NodeJS.Platform): Promise<void>
export function removeUnusedMacPrivacyDeclarations(plist: string): Promise<void>
export function installPackagedWorkspaceLicenses(deployed: string, root: string): Promise<void>
export function installPackagedDependencyNotices(
  deployed: string,
  workspace: string,
  options?: {
    readonly sourceStore?: string
    readonly mappings?: readonly Readonly<Record<string, any>>[]
  },
): Promise<void>
export function installElectronRuntimeEvidence(options: {
  readonly electronDist: string
  readonly resources: string
  readonly executable: string
  readonly runtimeVersions?: {
    readonly electron: string
    readonly node: string
    readonly chrome: string
  }
}): Promise<ElectronRuntimeEvidence>
export function validateElectronRuntimeEvidence(
  resources: string,
  evidence?: unknown,
): Promise<ElectronRuntimeEvidence>
export function sealMacBundle(bundle: string): Promise<void>
export function removePnpmWorkspaceSelfReference(root: string): Promise<boolean>
export function restoreLegacyWorkspaceRuntimeDependencies(deployed: string, workspace: string): Promise<void>
export function verifyDeployedRuntimeResolution(deployed: string): Promise<void>
export function probeDeployedRuntime(deployed: string): Promise<void>
export function validateSidecarEvidence(
  directory: string,
  evidence: unknown,
  options: {
    readonly root: string
    readonly source: Readonly<Record<string, string>>
    readonly platform: NodeJS.Platform
    readonly arch: string
  },
): Promise<void>
export function validateSidecarRuntimeComponents(
  directory: string,
  components: unknown,
  versions: { readonly python: string; readonly pyinstaller: string },
): Promise<void>
