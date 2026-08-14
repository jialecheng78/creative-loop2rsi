import type { GatewayErrorCode } from "./types.js";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options: { status?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
  }
}
