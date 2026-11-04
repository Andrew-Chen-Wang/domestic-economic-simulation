/**
 * Deterministic, serializable PRNG (sfc32 with 53-bit doubles). The whole state lives in
 * `state`, so a World snapshot (structured clone / v8.serialize) captures it and replay from a
 * snapshot reproduces every draw.
 */
export interface RngState {
  s: [number, number, number, number]
  /** cached second Box-Muller deviate (NaN when empty) */
  g: number
}

export function seedRng(seed: number): RngState {
  // splitmix32 to spread the seed
  let x = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0
  const next = () => {
    x = (x + 0x9e3779b9) >>> 0
    let z = x
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
    return (z ^ (z >>> 16)) >>> 0
  }
  const st: RngState = { s: [next(), next(), next(), next()], g: Number.NaN }
  for (let i = 0; i < 12; i++) u32(st)
  return st
}

function u32(st: RngState): number {
  const s = st.s
  const t = (((s[0] + s[1]) >>> 0) + s[3]) >>> 0
  s[3] = (s[3] + 1) >>> 0
  s[0] = s[1] ^ (s[1] >>> 9)
  s[1] = (s[2] + (s[2] << 3)) >>> 0
  s[2] = ((s[2] << 21) | (s[2] >>> 11)) >>> 0
  s[2] = (s[2] + t) >>> 0
  return t
}

/** Uniform [0, 1). */
export function random(st: RngState): number {
  const a = u32(st) >>> 5
  const b = u32(st) >>> 6
  return (a * 67108864 + b) / 9007199254740992
}

export function uniform(st: RngState, a: number, b: number): number {
  return a + (b - a) * random(st)
}

export function gauss(st: RngState, mu = 0, sigma = 1): number {
  let z = st.g
  if (Number.isNaN(z)) {
    const x2pi = random(st) * 2 * Math.PI
    const g2rad = Math.sqrt(-2 * Math.log(1 - random(st)))
    z = Math.cos(x2pi) * g2rad
    st.g = Math.sin(x2pi) * g2rad
  } else st.g = Number.NaN
  return mu + z * sigma
}

export function randint(st: RngState, a: number, b: number): number {
  return a + Math.floor(random(st) * (b - a + 1))
}

export function choice<T>(st: RngState, xs: readonly T[]): T {
  return xs[Math.floor(random(st) * xs.length)]
}

/** One weighted draw (Python's `rng.choices(xs, weights)[0]`). */
export function pick<T>(st: RngState, xs: readonly T[], weights: readonly number[]): T {
  let tot = 0
  for (const w of weights) tot += w
  let r = random(st) * tot
  for (let i = 0; i < xs.length; i++) {
    r -= weights[i]
    if (r < 0) return xs[i]
  }
  return xs[xs.length - 1]
}

export function shuffle<T>(st: RngState, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random(st) * (i + 1))
    const t = xs[i]
    xs[i] = xs[j]
    xs[j] = t
  }
  return xs
}

/** Random permutation of 0..n-1. */
export function permutation(st: RngState, n: number): number[] {
  return shuffle(
    st,
    Array.from({ length: n }, (_, i) => i),
  )
}
