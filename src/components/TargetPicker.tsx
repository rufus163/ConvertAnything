import { useEffect, useMemo, useRef, useState } from 'react'
import { CATEGORY_LABELS, FORMATS, type Category } from '../converters/formats'
import { converterLabel } from '../converters/registry'
import type { Converter } from '../converters/types'
import { Icon } from './Icon'

const VISIBLE = 4

export function TargetPicker({ converters, value, onChange, disabled }: { converters: Converter[]; value?: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  // Keep the selected target visible among the chips even if it's not in the top few.
  const chips = useMemo(() => {
    const top = converters.slice(0, VISIBLE)
    const selected = converters.find((c) => c.id === value)
    if (selected && !top.includes(selected)) top[VISIBLE - 1] = selected
    return top
  }, [converters, value])

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groups = new Map<Category, Converter[]>()
    for (const c of converters) {
      const label = converterLabel(c).toLowerCase()
      if (q && !label.includes(q) && !c.to.includes(q) && !(c.description ?? '').toLowerCase().includes(q)) continue
      const cat = FORMATS[c.to]?.category ?? 'archive'
      groups.set(cat, [...(groups.get(cat) ?? []), c])
    }
    return [...groups.entries()]
  }, [converters, query])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    // Don't pop the keyboard up on phones.
    if (window.matchMedia('(pointer: fine)').matches) search.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!converters.length) return <p className="muted small">No conversions available for this file type.</p>

  const pick = (id: string) => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="picker">
      <div className="chips" role="radiogroup" aria-label="Convert to">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === value}
            className={`chip ${c.id === value ? 'chip--active' : ''}`}
            onClick={() => pick(c.id)}
            disabled={disabled}
            title={c.description}
          >
            {converterLabel(c)}
          </button>
        ))}
        {converters.length > VISIBLE && (
          <div className="picker__more" ref={panel}>
            <button type="button" className="chip chip--ghost" onClick={() => setOpen((o) => !o)} disabled={disabled} aria-expanded={open}>
              More <Icon name="chevron" size={14} />
            </button>
            {open && <div className="sheet-backdrop" onClick={() => setOpen(false)} />}
            {open && (
              <div className="popover" role="dialog" aria-label="All formats">
                <div className="popover__search">
                  <Icon name="search" size={16} />
                  <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search formats" aria-label="Search formats" />
                </div>
                <div className="popover__list">
                  {grouped.map(([cat, list]) => (
                    <div key={cat} className="popover__group">
                      <div className="popover__heading">{CATEGORY_LABELS[cat]}</div>
                      {list.map((c) => (
                        <button key={c.id} type="button" className={`popover__item ${c.id === value ? 'is-active' : ''}`} onClick={() => pick(c.id)}>
                          <span>{converterLabel(c)}</span>
                          {c.description && <small>{c.description}</small>}
                          {c.id === value && <Icon name="check" size={16} className="popover__check" />}
                        </button>
                      ))}
                    </div>
                  ))}
                  {!grouped.length && <p className="muted small popover__empty">No matching formats</p>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
