export type OptionValue = string | number | boolean
export type Options = Record<string, OptionValue>

interface BaseOption {
  key: string
  label: string
  help?: string
}

export interface SelectOption extends BaseOption {
  type: 'select'
  choices: { value: string; label: string }[]
  default: string
}

export interface RangeOption extends BaseOption {
  type: 'range'
  min: number
  max: number
  step: number
  default: number
  unit?: string
}

export interface NumberOption extends BaseOption {
  type: 'number'
  min?: number
  max?: number
  step?: number
  default: number
  unit?: string
}

export interface ToggleOption extends BaseOption {
  type: 'toggle'
  default: boolean
}

export interface ColorOption extends BaseOption {
  type: 'color'
  default: string
}

export type OptionDef = SelectOption | RangeOption | NumberOption | ToggleOption | ColorOption

export interface OutputFile {
  name: string
  blob: Blob
}

export interface ConvertContext {
  /** Progress between 0 and 1. */
  onProgress: (progress: number) => void
  /** Short human readable status ("Loading video engine…"). */
  onStatus: (status: string) => void
  signal: AbortSignal
}

export type Engine = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'data' | 'archive'

export interface Converter {
  id: string
  /** Input format ids. */
  from: string[]
  /** Output format id. */
  to: string
  /** Label shown in the target picker, defaults to the output format label. */
  label?: string
  description?: string
  engine: Engine
  options?: OptionDef[]
  /**
   * `each`: every input file produces its own output(s).
   * `combine`: all inputs are merged into one output (e.g. images → one PDF).
   */
  mode: 'each' | 'combine'
  /** Hidden from single-file pickers when more inputs are required (e.g. merging). */
  minInputs?: number
  /** Shown first in pickers. */
  recommended?: boolean
  run: (inputs: File[], options: Options, ctx: ConvertContext) => Promise<OutputFile[]>
}

export class ConversionError extends Error {}
export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}
