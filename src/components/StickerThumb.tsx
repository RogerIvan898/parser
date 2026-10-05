interface StickerThumbProps {
  src: string | null | undefined;
  alt?: string;
  size?: number;
}

export default function StickerThumb({ src, alt = '', size = 24 }: StickerThumbProps) {
  if (!src) {
    return (
      <span
        className="sticker-thumb sticker-thumb--empty"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    <img
      className="sticker-thumb"
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size }}
    />
  );
}
