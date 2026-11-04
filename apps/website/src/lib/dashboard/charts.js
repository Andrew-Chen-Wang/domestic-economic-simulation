// Minimal SVG charting for the simulation dashboard (no dependencies).
// Every chart has a hover layer; colors come from CSS custom properties.
const NS = "http://www.w3.org/2000/svg"
export const SERIES = [
  "--series-1",
  "--series-2",
  "--series-3",
  "--series-4",
  "--series-5",
  "--series-6",
  "--series-7",
  "--series-8",
]
export const seriesColor = (i) => `var(${SERIES[i % SERIES.length]})`

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (parent) parent.appendChild(e)
  return e
}

// ---------------------------------------------------------------- formatting
const P = (x, d) => String(Number(x.toPrecision(d)))
export function fmtMoney(v, digits = 3) {
  if (v === null || v === undefined || isNaN(v)) return "–"
  const a = Math.abs(v)
  const s = v < 0 ? "-" : ""
  if (a >= 1e12) return s + "$" + P(a / 1e12, digits) + "T"
  if (a >= 1e9) return s + "$" + P(a / 1e9, digits) + "B"
  if (a >= 1e6) return s + "$" + P(a / 1e6, digits) + "M"
  if (a >= 1e3) return s + "$" + P(a / 1e3, digits) + "k"
  if (a === 0) return "$0"
  return s + "$" + P(a, digits)
}
export function fmtNum(v, digits = 3) {
  if (v === null || v === undefined || isNaN(v)) return "–"
  const a = Math.abs(v)
  const s = v < 0 ? "-" : ""
  if (a >= 1e9) return s + P(a / 1e9, digits) + "B"
  if (a >= 1e6) return s + P(a / 1e6, digits) + "M"
  if (a >= 1e4) return s + P(a / 1e3, digits) + "k"
  if (a >= 100) return s + a.toFixed(0)
  if (a >= 1) return s + a.toFixed(2)
  if (a === 0) return "0"
  return s + P(a, 2)
}
export const fmtPct = (v, d = 1) =>
  v === null || v === undefined || isNaN(v) ? "–" : (v * 100).toFixed(d) + "%"

// ---------------------------------------------------------------- tooltip
let tip
function tooltip() {
  if (!tip) {
    tip = document.createElement("div")
    tip.className = "viz-tip"
    document.body.appendChild(tip)
  }
  return tip
}
export function showTip(html, x, y) {
  const t = tooltip()
  t.innerHTML = html
  t.style.display = "block"
  const r = t.getBoundingClientRect()
  let left = x + 14
  let top = y + 14
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14
  t.style.left = Math.max(8, left) + "px"
  t.style.top = Math.max(8, top) + "px"
}
export function hideTip() {
  if (tip) tip.style.display = "none"
}

function niceTicks(lo, hi, n = 5) {
  if (!isFinite(lo) || !isFinite(hi)) return [0]
  if (hi === lo) hi = lo + 1
  const span = hi - lo
  const mag = Math.pow(10, Math.floor(Math.log10(span / n)))
  const steps = [1, 2, 2.5, 5, 10].map((m) => m * mag)
  const step = steps.find((s) => span / s <= n) || steps[steps.length - 1]
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12))
  return out
}

let defaultXticks = null
/** Set how x ticks are placed for time charts (e.g. on year boundaries). */
export function setDefaultXticks(f) {
  defaultXticks = f
}
function xTicks(opts, x0, x1, w) {
  const n = Math.max(2, Math.floor(w / 90))
  return opts.xticks ? opts.xticks(x0, x1, n) : niceTicks(x0, x1, n)
}

function frame(container, height) {
  container.innerHTML = ""
  const w = Math.max(240, container.clientWidth || 600)
  const svg = el(
    "svg",
    { width: w, height, viewBox: `0 0 ${w} ${height}`, class: "viz" },
    container,
  )
  return { svg, w, h: height }
}

// ---------------------------------------------------------------- line chart
// opts: {series:[{name, points:[[x,y]], color, dash}], xfmt, yfmt, height, markers:[{x,label}], zero, area}
export function lineChart(container, options) {
  const opts = { xticks: defaultXticks, ...options }
  const { svg, w, h } = frame(container, opts.height || 220)
  const m = { l: 56, r: 14, t: 12, b: 26 }
  const all = opts.series.flatMap((s) => s.points.filter((p) => p[1] !== null && isFinite(p[1])))
  if (!all.length) {
    el(
      "text",
      { x: w / 2, y: h / 2, "text-anchor": "middle", class: "viz-empty" },
      svg,
    ).textContent = "No data yet - run the simulation"
    return
  }
  const x0 = Math.min(...all.map((p) => p[0]))
  let x1 = Math.max(...all.map((p) => p[0]))
  if (x0 === x1) x1 = x0 + 1
  let y0 = Math.min(...all.map((p) => p[1]))
  let y1 = Math.max(...all.map((p) => p[1]))
  if (opts.zero !== false && y0 > 0) y0 = 0
  if (y0 === y1) y1 = y0 + Math.abs(y0 || 1) * 0.1
  const pad = (y1 - y0) * 0.06
  y1 += pad
  if (y0 < 0 || opts.zero === false) y0 -= pad
  const X = (x) => m.l + ((x - x0) / (x1 - x0)) * (w - m.l - m.r)
  const Y = (y) => h - m.b - ((y - y0) / (y1 - y0)) * (h - m.t - m.b)
  const yfmt = opts.yfmt || fmtNum
  const xfmt = opts.xfmt || ((x) => x)
  const g = el("g", { class: "viz-grid" }, svg)
  for (const t of niceTicks(y0, y1, 4)) {
    el("line", { x1: m.l, x2: w - m.r, y1: Y(t), y2: Y(t) }, g)
    el(
      "text",
      { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", class: "viz-axis" },
      svg,
    ).textContent = yfmt(t)
  }
  for (const t of xTicks(opts, x0, x1, w)) {
    el("text", { x: X(t), y: h - 8, "text-anchor": "middle", class: "viz-axis" }, svg).textContent =
      xfmt(t)
  }
  if (y0 < 0 && y1 > 0)
    el("line", { x1: m.l, x2: w - m.r, y1: Y(0), y2: Y(0), class: "viz-zero" }, svg)
  for (const mk of opts.markers || []) {
    if (mk.x < x0 || mk.x > x1) continue
    const ml = el(
      "line",
      { x1: X(mk.x), x2: X(mk.x), y1: m.t, y2: h - m.b, class: "viz-marker" },
      svg,
    )
    ml.style.pointerEvents = "none"
    const hit = el(
      "rect",
      { x: X(mk.x) - 5, y: m.t, width: 10, height: h - m.t - m.b, fill: "transparent" },
      svg,
    )
    hit.addEventListener("mousemove", (ev) =>
      showTip(`<b>${xfmt(mk.x)}</b><br>${mk.label}`, ev.clientX, ev.clientY),
    )
    hit.addEventListener("mouseleave", hideTip)
  }
  opts.series.forEach((s, i) => {
    const pts = s.points.filter((p) => p[1] !== null && isFinite(p[1]))
    if (!pts.length) return
    const d = pts
      .map((p, j) => (j ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1))
      .join("")
    const color = s.color || seriesColor(i)
    if (opts.area && opts.series.length === 1) {
      const base = Y(Math.max(y0, 0))
      el(
        "path",
        {
          d: `${d}L${X(pts[pts.length - 1][0])},${base}L${X(pts[0][0])},${base}Z`,
          fill: color,
          opacity: 0.12,
        },
        svg,
      )
    }
    el(
      "path",
      {
        d,
        fill: "none",
        stroke: color,
        "stroke-width": 2,
        "stroke-dasharray": s.dash || "",
        "stroke-linejoin": "round",
      },
      svg,
    )
  })
  // hover layer: crosshair + tooltip with every series at the hovered x
  const cross = el("line", { y1: m.t, y2: h - m.b, class: "viz-cross", visibility: "hidden" }, svg)
  const dots = opts.series.map((s, i) =>
    el(
      "circle",
      {
        r: 4,
        fill: s.color || seriesColor(i),
        stroke: "var(--surface-1)",
        "stroke-width": 2,
        visibility: "hidden",
      },
      svg,
    ),
  )
  const hit = el(
    "rect",
    { x: m.l, y: m.t, width: w - m.l - m.r, height: h - m.t - m.b, fill: "transparent" },
    svg,
  )
  const xAt = (ev) => {
    const r = svg.getBoundingClientRect()
    return x0 + ((ev.clientX - r.left - m.l) / (w - m.l - m.r)) * (x1 - x0)
  }
  hit.addEventListener("mousemove", (ev) => {
    const xv = xAt(ev)
    const rows = []
    let xs = null
    opts.series.forEach((s, i) => {
      let best = null
      for (const p of s.points)
        if (p[1] !== null && (best === null || Math.abs(p[0] - xv) < Math.abs(best[0] - xv)))
          best = p
      if (best) {
        xs = xs === null ? best[0] : xs
        dots[i].setAttribute("cx", X(best[0]))
        dots[i].setAttribute("cy", Y(best[1]))
        dots[i].setAttribute("visibility", "visible")
        rows.push(
          `<div class="tip-row"><span class="sw" style="background:${s.color || seriesColor(i)}"></span>${s.name}<b>${yfmt(best[1])}</b></div>`,
        )
      }
    })
    if (xs !== null) {
      cross.setAttribute("x1", X(xs))
      cross.setAttribute("x2", X(xs))
      cross.setAttribute("visibility", "visible")
    }
    showTip(`<div class="tip-h">${xfmt(xs)}</div>${rows.join("")}`, ev.clientX, ev.clientY)
  })
  hit.addEventListener("mouseleave", () => {
    hideTip()
    cross.setAttribute("visibility", "hidden")
    dots.forEach((d) => d.setAttribute("visibility", "hidden"))
  })
  if (opts.onClick) {
    hit.style.cursor = "pointer"
    hit.addEventListener("click", (ev) => opts.onClick(xAt(ev)))
  }
  if (opts.series.length > 1)
    legend(
      container,
      opts.series.map((s, i) => ({ name: s.name, color: s.color || seriesColor(i), dash: s.dash })),
    )
}

export function legend(container, items) {
  const d = document.createElement("div")
  d.className = "viz-legend"
  d.innerHTML = items
    .map(
      (it) =>
        `<span><i style="background:${it.color}${it.dash ? ";opacity:.6" : ""}"></i>${it.name}</span>`,
    )
    .join("")
  container.appendChild(d)
}

// ---------------------------------------------------------------- stacked area
export function stackedArea(container, options) {
  const opts = { xticks: defaultXticks, ...options }
  const { svg, w, h } = frame(container, opts.height || 240)
  const m = { l: 56, r: 14, t: 12, b: 26 }
  const xs = opts.x
  if (!xs.length) return
  const n = xs.length
  const tops = new Array(n).fill(0)
  const layers = opts.series.map((s) =>
    s.values.map((v, i) => {
      const b = tops[i]
      tops[i] += Math.max(0, v || 0)
      return [b, tops[i]]
    }),
  )
  const y1 = Math.max(...tops) * 1.05 || 1
  const x0 = xs[0]
  const x1 = xs[n - 1] === x0 ? x0 + 1 : xs[n - 1]
  const X = (x) => m.l + ((x - x0) / (x1 - x0)) * (w - m.l - m.r)
  const Y = (y) => h - m.b - (y / y1) * (h - m.t - m.b)
  const yfmt = opts.yfmt || fmtNum
  const xfmt = opts.xfmt || ((x) => x)
  const g = el("g", { class: "viz-grid" }, svg)
  for (const t of niceTicks(0, y1, 4)) {
    el("line", { x1: m.l, x2: w - m.r, y1: Y(t), y2: Y(t) }, g)
    el(
      "text",
      { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", class: "viz-axis" },
      svg,
    ).textContent = yfmt(t)
  }
  for (const t of xTicks(opts, x0, x1, w))
    el("text", { x: X(t), y: h - 8, "text-anchor": "middle", class: "viz-axis" }, svg).textContent =
      xfmt(t)
  layers.forEach((L, k) => {
    let d = ""
    for (let i = 0; i < n; i++) d += (i ? "L" : "M") + X(xs[i]) + "," + Y(L[i][1])
    for (let i = n - 1; i >= 0; i--) d += "L" + X(xs[i]) + "," + Y(L[i][0])
    el(
      "path",
      {
        d: d + "Z",
        fill: opts.series[k].color || seriesColor(k),
        stroke: "var(--surface-1)",
        "stroke-width": 1,
      },
      svg,
    )
  })
  const cross = el("line", { y1: m.t, y2: h - m.b, class: "viz-cross", visibility: "hidden" }, svg)
  const hit = el(
    "rect",
    { x: m.l, y: m.t, width: w - m.l - m.r, height: h - m.t - m.b, fill: "transparent" },
    svg,
  )
  hit.addEventListener("mousemove", (ev) => {
    const r = svg.getBoundingClientRect()
    const xv = x0 + ((ev.clientX - r.left - m.l) / (w - m.l - m.r)) * (x1 - x0)
    let i = 0
    for (let j = 0; j < n; j++) if (Math.abs(xs[j] - xv) < Math.abs(xs[i] - xv)) i = j
    cross.setAttribute("x1", X(xs[i]))
    cross.setAttribute("x2", X(xs[i]))
    cross.setAttribute("visibility", "visible")
    const rows = opts.series
      .map(
        (s, k) =>
          `<div class="tip-row"><span class="sw" style="background:${s.color || seriesColor(k)}"></span>${s.name}<b>${yfmt(s.values[i])}</b></div>`,
      )
      .reverse()
    showTip(
      `<div class="tip-h">${xfmt(xs[i])}</div>${rows.join("")}<div class="tip-row">Total<b>${yfmt(tops[i])}</b></div>`,
      ev.clientX,
      ev.clientY,
    )
  })
  hit.addEventListener("mouseleave", () => {
    hideTip()
    cross.setAttribute("visibility", "hidden")
  })
  legend(
    container,
    opts.series.map((s, k) => ({ name: s.name, color: s.color || seriesColor(k) })),
  )
}

// ---------------------------------------------------------------- horizontal bars
// items: [{label, value, color, tip, onClick}]
export function barList(container, items, opts = {}) {
  container.innerHTML = ""
  const max = Math.max(...items.map((d) => Math.abs(d.value)), 1e-12)
  const fmt = opts.fmt || fmtNum
  const wrap = document.createElement("div")
  wrap.className = "barlist"
  for (const d of items) {
    const row = document.createElement("div")
    row.className = "bar-row" + (d.onClick ? " clickable" : "")
    row.innerHTML = `<div class="bar-label" title="${d.label}">${d.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${((Math.abs(d.value) / max) * 100).toFixed(2)}%;background:${d.color || "var(--series-1)"}"></div></div>
      <div class="bar-val">${fmt(d.value)}</div>`
    row.addEventListener("mousemove", (ev) =>
      showTip(
        `<div class="tip-h">${d.label}</div>${d.tip || fmt(d.value)}`,
        ev.clientX,
        ev.clientY,
      ),
    )
    row.addEventListener("mouseleave", hideTip)
    if (d.onClick) row.addEventListener("click", d.onClick)
    wrap.appendChild(row)
  }
  container.appendChild(wrap)
}

// ---------------------------------------------------------------- treemap (squarified)
export function treemap(container, items, opts = {}) {
  const { svg, w, h } = frame(container, opts.height || 300)
  const fmt = opts.fmt || fmtMoney
  const data = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value)
  const total = data.reduce((s, d) => s + d.value, 0)
  if (!total) return
  const scale = (w * h) / total
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b, 0) * scale
    const mx = Math.max(...row) * scale
    const mn = Math.min(...row) * scale
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn))
  }
  const rects = []
  let x = 0
  let y = 0
  let W = w
  let H = h
  let rest = data.slice()
  while (rest.length) {
    const side = Math.min(W, H)
    const row = [rest[0]]
    let i = 1
    while (
      i < rest.length &&
      worst(
        [...row, rest[i]].map((d) => d.value),
        side,
      ) <=
        worst(
          row.map((d) => d.value),
          side,
        )
    ) {
      row.push(rest[i])
      i++
    }
    const sum = row.reduce((a, d) => a + d.value, 0) * scale
    if (W >= H) {
      const cw = sum / H
      let yy = y
      for (const d of row) {
        const ch = (d.value * scale) / cw
        rects.push([d, x, yy, cw, ch])
        yy += ch
      }
      x += cw
      W -= cw
    } else {
      const ch = sum / W
      let xx = x
      for (const d of row) {
        const cw = (d.value * scale) / ch
        rects.push([d, xx, y, cw, ch])
        xx += cw
      }
      y += ch
      H -= ch
    }
    rest = rest.slice(i)
  }
  rects.forEach(([d, rx, ry, rw, rh], k) => {
    const g = el("g", {}, svg)
    el(
      "rect",
      {
        x: rx + 1,
        y: ry + 1,
        width: Math.max(0, rw - 2),
        height: Math.max(0, rh - 2),
        rx: 3,
        fill: d.color || seriesColor(k),
      },
      g,
    )
    if (rw > 70 && rh > 30) {
      const t = el("text", { x: rx + 7, y: ry + 17, class: "tm-label" }, g)
      t.textContent = d.label.length > rw / 7 ? d.label.slice(0, Math.floor(rw / 7)) + "…" : d.label
      el("text", { x: rx + 7, y: ry + 33, class: "tm-value" }, g).textContent = fmt(d.value)
    }
    g.addEventListener("mousemove", (ev) =>
      showTip(
        `<div class="tip-h">${d.label}</div>${fmt(d.value)} · ${fmtPct(d.value / total)}${d.tip ? "<br>" + d.tip : ""}`,
        ev.clientX,
        ev.clientY,
      ),
    )
    g.addEventListener("mouseleave", hideTip)
    if (d.onClick) {
      g.style.cursor = "pointer"
      g.addEventListener("click", d.onClick)
    }
  })
}

// ---------------------------------------------------------------- money flow (bipartite sankey)
// links: [{source, target, value, kinds}] -> payers on the left, receivers on the right
export function moneyFlow(container, links, opts = {}) {
  const { svg, w, h } = frame(container, opts.height || 520)
  const L = {}
  const R = {}
  for (const k of links) {
    L[k.source] = (L[k.source] || 0) + k.value
    R[k.target] = (R[k.target] || 0) + k.value
  }
  const total = Object.values(L).reduce((a, b) => a + b, 0)
  if (!total) {
    el(
      "text",
      { x: w / 2, y: h / 2, "text-anchor": "middle", class: "viz-empty" },
      svg,
    ).textContent = "No flows recorded in this window"
    return
  }
  const colorOf = opts.color || ((name, i) => seriesColor(i))
  const names = [...new Set([...Object.keys(L), ...Object.keys(R)])].sort(
    (a, b) => (L[b] || 0) + (R[b] || 0) - ((L[a] || 0) + (R[a] || 0)),
  )
  const idx = Object.fromEntries(names.map((n, i) => [n, i]))
  const gap = 6
  const nodeW = 14
  const labelW = Math.min(170, w * 0.22)
  const lx = labelW
  const rx = w - labelW - nodeW
  const layout = (side) => {
    const keys = names.filter((n) => side[n])
    const usable = h - gap * (keys.length - 1) - 10
    let y = 5
    const pos = {}
    for (const k of keys) {
      const hh = Math.max(2, (side[k] / total) * usable)
      pos[k] = { y, h: hh, used: 0 }
      y += hh + gap
    }
    return [pos, usable]
  }
  const [PL, usableL] = layout(L)
  const [PR, usableR] = layout(R)
  for (const k of links.slice().sort((a, b) => idx[a.target] - idx[b.target])) {
    const a = PL[k.source]
    const b = PR[k.target]
    const th1 = (k.value / total) * usableL
    const th2 = (k.value / total) * usableR
    const y1 = a.y + a.used + th1 / 2
    const y2 = b.y + b.used + th2 / 2
    a.used += th1
    b.used += th2
    const x1 = lx + nodeW
    const x2 = rx
    const cx = (x1 + x2) / 2
    const p = el(
      "path",
      {
        d: `M${x1},${y1}C${cx},${y1} ${cx},${y2} ${x2},${y2}`,
        fill: "none",
        stroke: colorOf(k.source, idx[k.source]),
        "stroke-width": Math.max(1, (th1 + th2) / 2),
        "stroke-opacity": 0.35,
      },
      svg,
    )
    p.addEventListener("mousemove", (ev) => {
      p.setAttribute("stroke-opacity", 0.75)
      const kinds = Object.entries(k.kinds || {})
        .sort((x, y) => y[1] - x[1])
        .slice(0, 6)
        .map(([nm, v]) => `<div class="tip-row">${nm}<b>${fmtMoney(v)}</b></div>`)
        .join("")
      showTip(
        `<div class="tip-h">${k.source} → ${k.target}</div><div class="tip-row">Total<b>${fmtMoney(k.value)}</b></div>${opts.per ? opts.per(k.value) : ""}${kinds}`,
        ev.clientX,
        ev.clientY,
      )
    })
    p.addEventListener("mouseleave", () => {
      p.setAttribute("stroke-opacity", 0.35)
      hideTip()
    })
  }
  for (const [side, P_, x, anchor, tx] of [
    [L, PL, lx, "end", lx - 6],
    [R, PR, rx, "start", rx + nodeW + 6],
  ]) {
    for (const [name, p] of Object.entries(P_)) {
      el(
        "rect",
        { x, y: p.y, width: nodeW, height: p.h, rx: 2, fill: colorOf(name, idx[name]) },
        svg,
      )
      el(
        "text",
        {
          x: tx,
          y: p.y + Math.min(p.h / 2 + 4, p.h + 10),
          "text-anchor": anchor,
          class: "flow-label",
        },
        svg,
      ).textContent = `${name} ${fmtMoney(side[name], 2)}`
    }
  }
}

// ---------------------------------------------------------------- sparkline
export function sparkline(container, values, color = "var(--series-1)") {
  container.innerHTML = ""
  const w = container.clientWidth || 120
  const h = 28
  const svg = el("svg", { width: w, height: h, class: "spark" }, container)
  const v = values.filter((x) => x !== null && x !== undefined && isFinite(x))
  if (v.length < 2) return
  const lo = Math.min(...v)
  const hi = Math.max(...v) === lo ? lo + 1 : Math.max(...v)
  const d = v
    .map(
      (x, i) =>
        (i ? "L" : "M") +
        ((i / (v.length - 1)) * (w - 4) + 2).toFixed(1) +
        "," +
        (h - 3 - ((x - lo) / (hi - lo)) * (h - 6)).toFixed(1),
    )
    .join("")
  el("path", { d, fill: "none", stroke: color, "stroke-width": 2 }, svg)
}
