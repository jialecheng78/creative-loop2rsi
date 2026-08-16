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
