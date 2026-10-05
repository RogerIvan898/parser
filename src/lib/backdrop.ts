import type { CSSProperties } from 'react';

export function colorIntToHex(n: number): string {
  const v = (n >>> 0) & 0xffffff;
  return `#${v.toString(16).padStart(6, '0')}`;
}

export function backdropSwatchStyle(
  centerColor: number,
  edgeColor: number,
): CSSProperties {
  return {
    background: `radial-gradient(circle at 50% 45%, ${colorIntToHex(centerColor)}, ${colorIntToHex(edgeColor)})`,
  };
}
