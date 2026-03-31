export interface SparklineOptions {
  width?: number;
  height?: number;
  stroke?: string;
  background?: string;
}

const COLOR_UP = '#2EB88A';
const COLOR_DOWN = '#E14E4E';

/**
 * Derive stroke color from the direction of the series (first vs last value).
 */
export function sparklineStroke(values: number[]): string {
  return values.length >= 2 && values[values.length - 1] >= values[0]
    ? COLOR_UP
    : COLOR_DOWN;
}

/**
 * Build a minimal SVG sparkline path from a numeric series.
 */
export function buildSparklineSvg(
  values: number[],
  width = 160,
  height = 60,
  stroke = COLOR_UP,
  background = 'none',
): string {
  const pad = 4;
  const w = width;
  const h = height;

  if (!values.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const n = values.length;

  const points = values.map((v, i) => {
    const x = (i / (n - 1 || 1)) * w;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as [number, number];
  });

  const d = points
    .map(
      ([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`,
    )
    .join(' ');

  const bg =
    background !== 'none'
      ? `<rect width="${w}" height="${h}" fill="${background}" />`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${bg}<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
