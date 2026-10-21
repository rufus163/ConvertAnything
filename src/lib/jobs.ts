import { useCallback, useEffect, useReducer, useRef } from 'react'
import { detectFormat } from '../converters/formats'
import { combineConvertersFor, CONVERTERS_BY_ID, convertersFor, defaultOptions } from '../converters/registry'
import { ConversionError, type OptionValue, type Options, type OutputFile } from '../converters/types'

export type JobStatus = 'ready' | 'queued' | 'working' | 'done' | 'error'

export interface Job {
  id: string
  inputs: File[]
  formatId?: string
  converterId?: string
  options: Options
  status: JobStatus
  progress: number
  statusText: string
  outputs: OutputFile[]
  error?: string
}

type Action =
  | { type: 'add'; jobs: Job[] }
  | { type: 'update'; id: string; patch: Partial<Job> }
  | { type: 'remove'; id: string }
  | { type: 'replace'; ids: string[]; job: Job }
  | { type: 'clear' }

function reducer(state: Job[], action: Action): Job[] {
  switch (action.type) {
    case 'add':
      return [...state, ...action.jobs]
    case 'update':
      return state.map((j) => (j.id === action.id ? { ...j, ...action.patch } : j))
    case 'remove':
      return state.filter((j) => j.id !== action.id)
    case 'replace': {
      const first = state.findIndex((j) => action.ids.includes(j.id))
      const rest = state.filter((j) => !action.ids.includes(j.id))
      rest.splice(Math.max(0, first), 0, action.job)
      return rest
    }
    case 'clear':
      return state.filter((j) => j.status === 'working')
  }
}

let nextId = 0
const newId = () => `job-${Date.now().toString(36)}-${nextId++}`

function makeJob(inputs: File[], converterId: string | undefined): Job {
  const converter = converterId ? CONVERTERS_BY_ID.get(converterId) : undefined
  return {
    id: newId(),
    inputs,
    formatId: detectFormat(inputs[0])?.id,
    converterId,
    options: converter ? defaultOptions(converter) : {},
    status: 'ready',
    progress: 0,
    statusText: '',
    outputs: [],
  }
}

export function useJobs() {
  const [jobs, dispatch] = useReducer(reducer, [])
  const controllers = useRef(new Map<string, AbortController>())
  const running = useRef(false)

  const addFiles = useCallback((files: File[], preferredConverter?: string) => {
    // Shortcuts like "Merge PDFs" with several files go straight to one combined job.
    const preferred = preferredConverter ? CONVERTERS_BY_ID.get(preferredConverter) : undefined
    if (preferred?.mode === 'combine' && files.length > 1 && combineConvertersFor(files).includes(preferred)) {
      dispatch({ type: 'add', jobs: [makeJob(files, preferred.id)] })
      return
    }
    const added = files.map((file) => {
      const options = convertersFor(detectFormat(file)?.id)
      const match = options.find((c) => c.id === preferredConverter)
      return makeJob([file], (match ?? options[0])?.id)
    })
    dispatch({ type: 'add', jobs: added })
  }, [])

  const setConverter = useCallback((id: string, converterId: string) => {
    const c = CONVERTERS_BY_ID.get(converterId)
    if (!c) return
    dispatch({ type: 'update', id, patch: { converterId, options: defaultOptions(c), status: 'ready', outputs: [], error: undefined, progress: 0 } })
  }, [])

  const setOption = useCallback((job: Job, key: string, value: OptionValue) => {
    dispatch({ type: 'update', id: job.id, patch: { options: { ...job.options, [key]: value }, ...(job.status === 'done' || job.status === 'error' ? { status: 'ready', outputs: [], error: undefined } : {}) } })
  }, [])

  const start = useCallback((ids: string[]) => {
    for (const id of ids) dispatch({ type: 'update', id, patch: { status: 'queued', progress: 0, statusText: 'Waiting…', error: undefined, outputs: [] } })
  }, [])

  /** Back to the "ready" state, keeping the chosen format and options. */
  const reset = useCallback((id: string) => {
    dispatch({ type: 'update', id, patch: { status: 'ready', outputs: [], error: undefined, progress: 0, statusText: '' } })
  }, [])

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort()
    dispatch({ type: 'update', id, patch: { status: 'ready', progress: 0, statusText: '' } })
  }, [])

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort()
    dispatch({ type: 'remove', id })
  }, [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  /** Replaces several single-file jobs with one combined job (e.g. images → one PDF). */
  const combine = useCallback((sourceIds: string[], converterId: string, autoStart = true) => {
    const sources = jobsRef.current.filter((j) => sourceIds.includes(j.id))
    const job = makeJob(sources.flatMap((j) => j.inputs), converterId)
    if (autoStart) Object.assign(job, { status: 'queued', statusText: 'Waiting…' })
    dispatch({ type: 'replace', ids: sourceIds, job })
  }, [])

  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  // Runs queued jobs one at a time, so big media jobs don't compete for memory.
  useEffect(() => {
    if (running.current) return
    const next = jobs.find((j) => j.status === 'queued')
    if (!next) return
    const converter = next.converterId ? CONVERTERS_BY_ID.get(next.converterId) : undefined
    if (!converter) {
      dispatch({ type: 'update', id: next.id, patch: { status: 'error', error: 'Pick a format to convert to.' } })
      return
    }
    running.current = true
    const ctl = new AbortController()
    controllers.current.set(next.id, ctl)
    dispatch({ type: 'update', id: next.id, patch: { status: 'working', statusText: 'Starting…', progress: 0 } })

    let lastProgress = 0
    converter
      .run(next.inputs, next.options, {
        signal: ctl.signal,
        onProgress: (p) => {
          // Throttle re-renders to ~1% steps.
          if (ctl.signal.aborted || Math.abs(p - lastProgress) < 0.01) return
          lastProgress = p
          dispatch({ type: 'update', id: next.id, patch: { progress: p } })
        },
        onStatus: (s) => !ctl.signal.aborted && dispatch({ type: 'update', id: next.id, patch: { statusText: s } }),
      })
      .then((outputs) => {
        if (ctl.signal.aborted) return
        dispatch({ type: 'update', id: next.id, patch: { status: 'done', outputs, progress: 1, statusText: '' } })
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return
        console.error(e)
        const message =
          e instanceof ConversionError
            ? e.message
            : e instanceof RangeError || (e instanceof Error && /memory|allocation/i.test(e.message))
              ? 'This file is too large for this device to convert.'
              : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`
        dispatch({ type: 'update', id: next.id, patch: { status: 'error', error: message, statusText: '' } })
      })
      .finally(() => {
        controllers.current.delete(next.id)
        running.current = false
        // Nudge the effect to pick the next queued job.
        dispatch({ type: 'update', id: '__tick__', patch: {} })
      })
  }, [jobs])

  return { jobs, addFiles, setConverter, setOption, start, reset, cancel, remove, clear, combine }
}
