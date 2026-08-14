import type { JsonValue, ProjectRelativePath, SchemaVersion, StatusAxes } from "./common.js";

export interface ControllerDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly evidencePaths: readonly ProjectRelativePath[];
  readonly nextAction?: string;
}

/** App-service/bridge envelope; this is not legacy loopctl stdout or governing evidence. */
export interface ControllerResponse<TData extends JsonValue = JsonValue> {
  readonly schemaVersion: SchemaVersion;
  readonly requestId: string;
  readonly ok: boolean;
  readonly statuses?: StatusAxes;
  readonly data?: TData;
  readonly diagnostics: readonly ControllerDiagnostic[];
}
