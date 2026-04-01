export interface SparklineOptions {
  width?: number;
  height?: number;
  stroke?: string;
  background?: string;
}

const COLOR_UP = '#2EB88A';
const COLOR_DOWN = '#E14E4E';

/**
 * Accepts only well-formed CSS color values so that user-supplied strings
 * cannot break out of SVG attribute context and inject arbitrary markup.
 * Anything that does not match falls back to the supplied default.
 */
const CSS_COLOR_RE =
  /^(none|transparent|[a-zA-Z]+|#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s,%.\/]+\))$/;

export function sanitizeCssColor(value: string, fallback = 'none'): string {
  const trimmed = value.trim();
  return CSS_COLOR_RE.test(trimmed) ? trimmed : fallback;
}

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
  const safeStroke = sanitizeCssColor(stroke, COLOR_UP);
  const safeBg = sanitizeCssColor(background, 'none');

  const pad = 4;
  const w = width;
  const h = height;

  if (!values.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="${safeBg}"></svg>`;
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
    safeBg !== 'none'
      ? `<rect width="${w}" height="${h}" fill="${safeBg}" />`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${bg}<path d="${d}" fill="none" stroke="${safeStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
