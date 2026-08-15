export interface PreviewInventoryFile {
  readonly path: string
  readonly type: 'file'
  readonly bytes: number
  readonly sha256: string
}

export interface PreviewInventorySymlink {
  readonly path: string
  readonly type: 'symlink'
  readonly target: string
}

export type PreviewInventoryEntry = PreviewInventoryFile | PreviewInventorySymlink

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
export function inventoryTree(root: string): Promise<readonly PreviewInventoryEntry[]>
export function removePnpmWorkspaceSelfReference(root: string): Promise<boolean>
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
