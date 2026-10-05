import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useCatalog } from '@/hooks/useCatalog';
import type { CatalogBackdrop } from '@/api/client';
import { backdropSwatchStyle } from '@/lib/backdrop';

function Swatch({
  item,
  size = 28,
}: {
  item?: CatalogBackdrop | null;
  size?: number;
}) {
  const style: CSSProperties = item
    ? {
        ...backdropSwatchStyle(item.colorsCenterColor, item.colorsEdgeColor),
        width: size,
        height: size,
        borderRadius: 6,
        flexShrink: 0,
        border: '1px solid rgba(255,255,255,0.12)',
      }
    : {
        width: size,
        height: size,
        borderRadius: 6,
        flexShrink: 0,
        background: 'var(--surface-2)',
        border: '1px dashed var(--border)',
      };
  return <span className="backdrop-swatch" style={style} aria-hidden />;
}

interface BackdropSelectProps {
  collection: string;
  value: string;
  onChange: (backdropName: string) => void;
  optional?: boolean;
  disabled?: boolean;
}

export default function BackdropSelect({
  collection,
  value,
  onChange,
  optional = false,
  disabled = false,
}: BackdropSelectProps) {
  const catalog = useCatalog();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const items = useMemo(() => {
    if (!catalog.data || !collection) return [];
    return catalog.data.backdrops[collection] ?? [];
  }, [catalog.data, collection]);

  const selected = items.find((b) => b.backdropName === value);

  useEffect(() => {
    if (!value) return;
    if (!items.some((b) => b.backdropName === value)) onChange('');
  }, [collection, items, value, onChange]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const emptyLabel = optional ? 'Любой фон' : '—';
  const placeholder =
    items.length === 0
      ? 'Нет фонов — parse --catalog'
      : emptyLabel;

  return (
    <div className="form-field image-select" ref={rootRef}>
      <label id={`${listId}-label`}>Фон{optional ? ' (опц.)' : ''}</label>
      <button
        type="button"
        className="image-select__trigger"
        disabled={disabled || !collection || items.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${listId}-label`}
        onClick={() => setOpen((v) => !v)}
      >
        <Swatch item={selected} />
        <span className="image-select__label">
          {selected?.backdropName ?? (value ? value : placeholder)}
        </span>
        <span className="image-select__caret" aria-hidden>▾</span>
      </button>

      {open && (
        <ul
          className="image-select__list"
          role="listbox"
          aria-labelledby={`${listId}-label`}
        >
          {optional && (
            <li role="option" aria-selected={value === ''}>
              <button
                type="button"
                className={
                  value === ''
                    ? 'image-select__option image-select__option--active'
                    : 'image-select__option'
                }
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                <Swatch item={null} />
                <span>{emptyLabel}</span>
              </button>
            </li>
          )}
          {items.map((b) => (
            <li
              key={b.backdropName}
              role="option"
              aria-selected={b.backdropName === value}
            >
              <button
                type="button"
                className={
                  b.backdropName === value
                    ? 'image-select__option image-select__option--active'
                    : 'image-select__option'
                }
                onClick={() => {
                  onChange(b.backdropName);
                  setOpen(false);
                }}
              >
                <Swatch item={b} />
                <span>{b.backdropName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
