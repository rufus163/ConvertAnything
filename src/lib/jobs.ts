import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { detectFormat } from '../converters/formats'
import { applyPreset, combineConvertersFor, CONVERTERS_BY_ID, convertersFor, defaultOptions } from '../converters/registry'
import { ConversionError, type OptionValue, type Options, type OutputFile, type QualityPreset } from '../converters/types'
import { formatBytes } from './format'
import { getSettings, useSettings } from './settings'

export type JobStatus = 'ready' | 'queued' | 'working' | 'done' | 'error'

export interface Job {
  id: string
  inputs: File[]
  formatId?: string
  converterId?: string
  preset: QualityPreset
  options: Options
  status: JobStatus
  progress: number
  statusText: string
  /** Engine-reported speed ("48 fps · 2.1× realtime"); otherwise the UI shows MB/s. */
  speed?: string
  startedAt?: number
  finishedAt?: number
  outputs: OutputFile[]
  error?: string
  /** Saved state of the PDF editor, so reopening it keeps earlier edits. */
  editState?: unknown
  /** Extra information shown with the results. */
  note?: string
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
    case 'update': {
      const i = state.findIndex((j) => j.id === action.id)
      if (i < 0) return state
      const next = state.slice()
      next[i] = { ...state[i], ...action.patch }
      return next
    }
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

function makeJob(inputs: File[], converterId: string | undefined, preset: QualityPreset): Job {
  const converter = converterId ? CONVERTERS_BY_ID.get(converterId) : undefined
  return {
    id: newId(),
    inputs,
    formatId: detectFormat(inputs[0])?.id,
    converterId,
    preset,
    options: converter ? defaultOptions(converter, preset) : {},
    status: 'ready',
    progress: 0,
    statusText: '',
    outputs: [],
  }
}

const isMediaJob = (j: Job) => {
  const engine = j.converterId ? CONVERTERS_BY_ID.get(j.converterId)?.engine : undefined
  return engine === 'video' || engine === 'audio'
}

/** Patch that sends a job back to "ready" with no results. */
const RESET: Partial<Job> = { status: 'ready', outputs: [], error: undefined, progress: 0, statusText: '', speed: undefined, startedAt: undefined, finishedAt: undefined, note: undefined }

export function useJobs() {
  const [jobs, dispatch] = useReducer(reducer, [])
  const { settings } = useSettings()
  const controllers = useRef(new Map<string, AbortController>())
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  const addFiles = useCallback((files: File[], preferredConverter?: string) => {
    const { quality, maxFileSizeMB } = getSettings()
    const limit = maxFileSizeMB * 1024 * 1024
    const tooBig = (f: File) => limit > 0 && f.size > limit
    const accepted = files.filter((f) => !tooBig(f))
    const rejected = files.filter(tooBig).map((f) => ({
      ...makeJob([f], undefined, quality),
      status: 'error' as const,
      error: `${formatBytes(f.size)} is over the ${formatBytes(limit)} limit set in Settings.`,
    }))

    // Shortcuts like "Merge PDFs" with several files go straight to one combined job.
    const preferred = preferredConverter ? CONVERTERS_BY_ID.get(preferredConverter) : undefined
    if (preferred?.mode === 'combine' && accepted.length > 1 && combineConvertersFor(accepted).includes(preferred)) {
      dispatch({ type: 'add', jobs: [makeJob(accepted, preferred.id, quality), ...rejected] })
      return
    }
    const added = accepted.map((file) => {
      const options = convertersFor(detectFormat(file)?.id)
      const match = options.find((c) => c.id === preferredConverter)
      return makeJob([file], (match ?? options[0])?.id, quality)
    })
    dispatch({ type: 'add', jobs: [...added, ...rejected] })
  }, [])

  const setConverter = useCallback((id: string, converterId: string) => {
    const c = CONVERTERS_BY_ID.get(converterId)
    const job = jobsRef.current.find((j) => j.id === id)
    if (!c || !job) return
    dispatch({ type: 'update', id, patch: { ...RESET, converterId, options: defaultOptions(c, job.preset) } })
  }, [])

  const setOption = useCallback((id: string, key: string, value: OptionValue) => {
    const job = jobsRef.current.find((j) => j.id === id)
    if (!job) return
    const finished = job.status === 'done' || job.status === 'error'
    dispatch({ type: 'update', id, patch: { ...(finished ? RESET : {}), options: { ...job.options, [key]: value } } })
  }, [])

  const setPreset = useCallback((id: string, preset: QualityPreset) => {
    const job = jobsRef.current.find((j) => j.id === id)
    const c = job?.converterId ? CONVERTERS_BY_ID.get(job.converterId) : undefined
    if (!job || !c) return
    const finished = job.status === 'done' || job.status === 'error'
    dispatch({ type: 'update', id, patch: { ...(finished ? RESET : {}), preset, options: applyPreset(c, job.options, preset) } })
  }, [])

  const start = useCallback((ids: string[]) => {
    for (const id of ids) dispatch({ type: 'update', id, patch: { ...RESET, status: 'queued', statusText: 'Waiting…' } })
  }, [])

  /** Back to the "ready" state, keeping the chosen format and options. */
  const reset = useCallback((id: string) => dispatch({ type: 'update', id, patch: RESET }), [])

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort()
    dispatch({ type: 'update', id, patch: RESET })
  }, [])

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort()
    dispatch({ type: 'remove', id })
  }, [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  /** Marks a job finished with results produced outside the queue (e.g. the PDF editor). */
  const complete = useCallback((id: string, outputs: OutputFile[], patch: Partial<Job> = {}) => {
    const now = Date.now()
    dispatch({ type: 'update', id, patch: { ...RESET, ...patch, status: 'done', outputs, progress: 1, startedAt: now, finishedAt: now } })
  }, [])

  /** Called after results were saved; frees their memory if the user asked for that. */
  const saved = useCallback((id: string) => {
    if (getSettings().autoRemoveSaved) dispatch({ type: 'remove', id })
  }, [])

  /** Replaces several single-file jobs with one combined job (e.g. images → one PDF). */
  const combine = useCallback((sourceIds: string[], converterId: string) => {
    const sources = jobsRef.current.filter((j) => sourceIds.includes(j.id))
    const job = makeJob(
      sources.flatMap((j) => j.inputs),
      converterId,
      sources[0]?.preset ?? getSettings().quality,
    )
    dispatch({ type: 'replace', ids: sourceIds, job: { ...job, status: 'queued', statusText: 'Waiting…' } })
  }, [])

  // Scheduler: start queued jobs while there are free slots. Video/audio jobs have their own,
  // usually smaller, limit because each one needs a separate media engine and lots of memory.
  useEffect(() => {
    const working = jobs.filter((j) => j.status === 'working')
    let free = Math.max(1, settings.concurrency) - working.length
    let mediaFree = Math.max(1, settings.mediaConcurrency) - working.filter(isMediaJob).length
    for (const next of jobs) {
      if (free <= 0) break
      if (next.status !== 'queued') continue
      if (isMediaJob(next)) {
        if (mediaFree <= 0) continue
        mediaFree--
      }
      free--
      run(next)
    }

    function run(next: Job) {
      const converter = next.converterId ? CONVERTERS_BY_ID.get(next.converterId) : undefined
      if (!converter) {
        dispatch({ type: 'update', id: next.id, patch: { status: 'error', error: 'Pick a format to convert to.' } })
        return
      }
      const ctl = new AbortController()
      controllers.current.set(next.id, ctl)
      dispatch({ type: 'update', id: next.id, patch: { status: 'working', statusText: 'Starting…', progress: 0, startedAt: Date.now() } })

      // Throttle progress re-renders to 1% steps and at most ~8 per second.
      let lastProgress = 0
      let lastAt = 0
      const live = () => !ctl.signal.aborted
      converter
        .run(next.inputs, next.options, {
          signal: ctl.signal,
          onProgress: (p) => {
            const now = performance.now()
            if (!live() || Math.abs(p - lastProgress) < 0.01 || (now - lastAt < 120 && p < 1)) return
            lastProgress = p
            lastAt = now
            dispatch({ type: 'update', id: next.id, patch: { progress: p } })
          },
          onStatus: (s) => live() && dispatch({ type: 'update', id: next.id, patch: { statusText: s } }),
          onSpeed: (speed) => live() && dispatch({ type: 'update', id: next.id, patch: { speed } }),
        })
        .then((outputs) => {
          if (!live()) return
          dispatch({ type: 'update', id: next.id, patch: { status: 'done', outputs, progress: 1, statusText: '', finishedAt: Date.now() } })
        })
        .catch((e: unknown) => {
          if (!live()) return
          console.error(e)
          const message =
            e instanceof ConversionError
              ? e.message
              : e instanceof RangeError || (e instanceof Error && /memory|allocation/i.test(e.message))
                ? 'This file is too large for this device to convert. Try the Compact quality or a smaller size.'
                : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`
          dispatch({ type: 'update', id: next.id, patch: { status: 'error', error: message, statusText: '', finishedAt: Date.now() } })
        })
        .finally(() => controllers.current.delete(next.id))
    }
  }, [jobs, settings.concurrency, settings.mediaConcurrency])

  const actions = useMemo(
    () => ({ addFiles, setConverter, setOption, setPreset, start, reset, cancel, remove, clear, combine, complete, saved }),
    [addFiles, setConverter, setOption, setPreset, start, reset, cancel, remove, clear, combine, complete, saved],
  )
  return { jobs, actions }
}

export type JobActions = ReturnType<typeof useJobs>['actions']
