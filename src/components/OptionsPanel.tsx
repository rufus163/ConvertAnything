import { useId } from 'react'
import type { OptionDef, OptionValue, Options } from '../converters/types'

export function OptionsPanel({ defs, values, onChange, disabled }: { defs: OptionDef[]; values: Options; onChange: (key: string, value: OptionValue) => void; disabled?: boolean }) {
  const base = useId()
  // The trace detail only matters when tracing.
  const visible = defs.filter((d) => !(d.key === 'trace' && values.svgMode === 'embed'))
  return (
    <div className="options">
      {visible.map((d) => {
        const id = `${base}-${d.key}`
        const v = values[d.key] ?? d.default
        return (
          <div key={d.key} className={`option option--${d.type}`}>
            <label htmlFor={id} className="option__label">
              {d.label}
              {d.type === 'range' && (
                <span className="option__value">
                  {String(v)}
                  {d.unit}
                </span>
              )}
            </label>
            {d.type === 'select' && (
              <div className="select">
                <select id={id} value={String(v)} onChange={(e) => onChange(d.key, e.target.value)} disabled={disabled}>
                  {d.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {d.type === 'range' && (
              <input id={id} type="range" min={d.min} max={d.max} step={d.step} value={Number(v)} onChange={(e) => onChange(d.key, Number(e.target.value))} disabled={disabled} />
            )}
            {d.type === 'number' && (
              <div className="number">
                <input
                  id={id}
                  type="number"
                  inputMode="decimal"
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  value={Number(v)}
                  onChange={(e) => onChange(d.key, Math.max(d.min ?? -Infinity, Number(e.target.value) || 0))}
                  disabled={disabled}
                />
                {d.unit && <span>{d.unit}</span>}
              </div>
            )}
            {d.type === 'toggle' && (
              <button
                id={id}
                type="button"
                role="switch"
                aria-checked={Boolean(v)}
                className={`switch ${v ? 'switch--on' : ''}`}
                onClick={() => onChange(d.key, !v)}
                disabled={disabled}
              >
                <span />
              </button>
            )}
            {d.type === 'color' && <input id={id} type="color" value={String(v)} onChange={(e) => onChange(d.key, e.target.value)} disabled={disabled} />}
            {d.help && <small className="option__help">{d.help}</small>}
          </div>
        )
      })}
    </div>
  )
}
