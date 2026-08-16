export interface GenerateMacIcnsOptions {
  readonly source?: string
}

export function generateMacIcns(output: string, options?: GenerateMacIcnsOptions): Promise<string>
