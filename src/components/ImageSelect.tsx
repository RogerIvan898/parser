import { useEffect, useId, useRef, useState } from 'react';
import StickerThumb from '@/components/StickerThumb';

export interface ImageSelectOption {
  value: string;
  label: string;
  imageUrl?: string | null;
}

interface ImageSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ImageSelectOption[];
  disabled?: boolean;
  placeholder?: string;
  thumbSize?: number;
}

export default function ImageSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
  placeholder = '—',
  thumbSize = 28,
}: ImageSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="form-field image-select" ref={rootRef}>
      <label id={`${listId}-label`}>{label}</label>
      <button
        type="button"
        className="image-select__trigger"
        disabled={disabled || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${listId}-label`}
        onClick={() => setOpen((v) => !v)}
      >
        <StickerThumb
          src={selected?.imageUrl}
          alt={selected?.label ?? ''}
          size={thumbSize}
        />
        <span className="image-select__label">
          {selected?.label ?? placeholder}
        </span>
        <span className="image-select__caret" aria-hidden>▾</span>
      </button>

      {open && (
        <ul
          className="image-select__list"
          role="listbox"
          aria-labelledby={`${listId}-label`}
        >
          {options.map((opt) => (
            <li key={opt.value || '__empty__'} role="option" aria-selected={opt.value === value}>
              <button
                type="button"
                className={
                  opt.value === value
                    ? 'image-select__option image-select__option--active'
                    : 'image-select__option'
                }
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <StickerThumb
                  src={opt.imageUrl}
                  alt={opt.label}
                  size={thumbSize}
                />
                <span>{opt.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
