export interface TrustedIpcBoundary {
  readonly rendererUrl: string
  readonly webContentsId: number
}

export interface IpcSenderFacts {
  readonly sender: { readonly id: number }
  readonly senderFrame: {
    readonly parent: unknown | null
    readonly url: string
  } | null
}

export function isTrustedIpcSender(event: IpcSenderFacts, boundary: TrustedIpcBoundary): boolean {
  const frame = event.senderFrame
  return event.sender.id === boundary.webContentsId
    && frame !== null
    && frame.parent === null
    && frame.url === boundary.rendererUrl
}
