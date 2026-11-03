/**
 * Zero-dependency 3D force-directed graph for the MemStack console.
 *
 * Layout runs in world space; the camera is an orbit rig with perspective
 * projection onto a 2D canvas. Node sprites are pre-rendered once per kind, so a
 * few hundred nodes stay smooth without WebGL or a build step.
 */

const TAU = Math.PI * 2
const DEFAULTS = {
  autoRotate: true,
  mode: '3d',
  distance: 1050,
  focal: 980,
  minDistance: 340,
  maxDistance: 2600,
  damping: 0.88,
  cooling: 0.985,
}

const REST_LENGTH = {
  contains: 96,
  supersede: 112,
  relation: 140,
  topic: 118,
  tag: 104,
  'bank-link': 300,
}

const EDGE_ALPHA = {
  contains: 0.34,
  supersede: 0.58,
  relation: 0.64,
  topic: 0.42,
  tag: 0.34,
  'bank-link': 0.72,
}

/**
 * Base stroke width per edge type. Structural edges (contains / topic) carry a
 * small force weight, so a width derived from weight alone lands under one
 * device pixel and disappears on a dark canvas.
 */
const EDGE_WIDTH = {
  contains: 2.3,
  supersede: 3.7,
  relation: 3.4,
  topic: 2,
  tag: 1.9,
  'bank-link': 4.2,
}

function depthAlpha(depth) {
  return Math.min(1, Math.max(0.55, 1.35 - depth / 1700))
}

/**
 * Alpha and stroke width of one edge, in CSS pixels. Exported so `node --test`
 * can hold the legibility floor: an edge thinner than ~1.4px or dimmer than the
 * canvas reads as "no edges at all", which is exactly the 2026-11-03 report.
 */
export function edgeStyle(edge, { scale = 1, depth = 0 } = {}) {
  const type = edge?.type ?? 'contains'
  const weight = Number.isFinite(edge?.weight) ? Math.max(0.25, edge.weight) : 1
  const grow = Math.min(1.55, 0.75 + weight * 0.55)
  return {
    alpha: Math.min(1, (EDGE_ALPHA[type] ?? 0.3) * depthAlpha(depth)),
    width: Math.max(1.4, Math.min(6.4, (EDGE_WIDTH[type] ?? 2.2) * grow * Math.max(0.7, scale))),
    dashed: type === 'topic' || type === 'tag',
  }
}

export const GRAPH_KIND_COLORS = {
  decision: '#60a5fa',
  constraint: '#fbbf24',
  gotcha: '#f87171',
  preference: '#a78bfa',
  'open-question': '#34d399',
}

const EDGE_COLORS = {
  contains: '#64748b',
  supersede: '#fb923c',
  relation: '#38bdf8',
  topic: '#64748b',
  tag: '#2dd4bf',
  'bank-link': '#22d3ee',
}

const RELATION_COLORS = {
  related: '#38bdf8',
  refines: '#a78bfa',
  depends: '#f472b6',
  contradicts: '#ef4444',
}

export function createGraphView(canvas, options = {}) {
  const ctx = canvas.getContext('2d', { alpha: true })
  const {
    onSelect = () => {},
    onHover = () => {},
    formatTooltip = () => '',
    palette = {},
  } = options

  let width = 1
  let height = 1
  let dpr = 1
  let running = true
  let data = { nodes: [], edges: [] }
  let nodeById = new Map()
  let adjacency = new Map()
  let positions = new Map()
  let screen = new Map()
  let alpha = 0
  let hovered = null
  let selected = null
  let highlight = null
  let needsRepaint = true
  let pointer = { x: 0, y: 0, inside: false }
  let insetRight = 0
  let drag = null
  let pointers = new Map()
  let pinch = null
  let camera = {
    yaw: -0.42,
    pitch: 0.24,
    distance: DEFAULTS.distance,
    panX: 0,
    panY: 0,
    autoRotate: DEFAULTS.autoRotate,
    mode: DEFAULTS.mode,
  }
  let paletteNow = buildPalette(palette)
  let sprites = new Map()
  let lastTopology = ''
  let positionsSized = false
  let animation = 0
  let resizeObserver = null
  let disposed = false
  let topicTimer = null

  function buildPalette(input = {}) {
    return {
      kinds: { ...GRAPH_KIND_COLORS, ...(input.kinds ?? {}) },
      edges: { ...EDGE_COLORS, ...(input.edges ?? {}) },
      relations: { ...RELATION_COLORS, ...(input.relations ?? {}) },
      bank: input.bank ?? '#7dd3fc',
      bankArchived: input.bankArchived ?? '#475569',
      label: input.label ?? 'rgba(232, 238, 247, 0.92)',
      labelMuted: input.labelMuted ?? 'rgba(148, 163, 184, 0.85)',
      labelPanel: input.labelPanel ?? 'rgba(8, 11, 17, 0.82)',
      labelShadow: input.labelShadow ?? 'rgba(0, 0, 0, 0.75)',
      hoverRing: input.hoverRing ?? 'rgba(255, 255, 255, 0.85)',
      selectRing: input.selectRing ?? '#ffffff',
      pinned: input.pinned ?? '#fbbf24',
      dimAlpha: input.dimAlpha ?? 0.16,
    }
  }

  function hash(text) {
    let value = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index)
      value = Math.imul(value, 16777619)
    }
    return (value >>> 0) / 4294967296
  }

  function initialPosition(node, index, total) {
    if (node.type === 'bank') {
      const banks = data.nodes.filter((item) => item.type === 'bank')
      const at = banks.indexOf(node)
      const angle = (at / Math.max(1, banks.length)) * TAU
      const radius = 130 + Math.min(banks.length, 8) * 34
      return { x: Math.cos(angle) * radius, y: Math.sin(angle * 1.7) * 60, z: Math.sin(angle) * radius }
    }
    const bankPos = positions.get(node.bankId) ?? { x: 0, y: 0, z: 0 }
    const seed = hash(node.id) * TAU
    const ring = 90 + (index % 5) * 26
    const lean = 0.6 + hash(`${node.id}:r`) * 0.8
    return {
      x: bankPos.x + Math.cos(seed) * ring + (index / Math.max(1, total)) * 40,
      y: (hash(`${node.id}:y`) - 0.5) * 200 * lean,
      z: bankPos.z + Math.sin(seed) * ring,
    }
  }

  function ensurePositions() {
    const total = Math.max(1, data.nodes.length)
    data.nodes.forEach((node, index) => {
      if (positions.has(node.id)) return
      positions.set(node.id, { ...initialPosition(node, index, total), vx: 0, vy: 0, vz: 0 })
    })
  }

  function reheat(amount = 1) {
    alpha = Math.max(alpha, amount)
  }

  function setData(next) {
    const nodes = Array.isArray(next?.nodes) ? next.nodes : []
    const edges = Array.isArray(next?.edges) ? next.edges : []
    const topology = `${nodes.map((node) => node.id).sort().join(',')}|${edges.length}`
    const changedShape = topology !== lastTopology
    lastTopology = topology
    data = { nodes, edges }
    nodeById = new Map(nodes.map((node) => [node.id, node]))
    adjacency = new Map(nodes.map((node) => [node.id, new Set()]))
    for (const edge of edges) {
      adjacency.get(edge.source)?.add(edge.target)
      adjacency.get(edge.target)?.add(edge.source)
    }
    ensurePositions()
    rebuildSprites()
    if (!positionsSized && data.nodes.length) {
      // Small graphs read better a little closer; large ones need the whole cluster on screen.
      const count = data.nodes.length
      camera.distance = count < 10 ? 780 : count < 22 ? 940 : count < 40 ? 1080 : 1220
      positionsSized = true
    }
    if (changedShape) reheat(1)
    else reheat(0.28)
    needsRepaint = true
  }

  function rebuildSprites() {
    sprites = new Map()
    const kinds = new Set(['bank', 'archived-bank'])
    for (const node of data.nodes) if (node.type === 'entry') kinds.add(node.kind)
    for (const kind of kinds) {
      const color =
        kind === 'bank'
          ? paletteNow.bank
          : kind === 'archived-bank'
            ? paletteNow.bankArchived
            : paletteNow.kinds[kind] ?? '#94a3b8'
      sprites.set(kind, makeSprite(color))
    }
  }

  function makeSprite(color) {
    const size = 96
    const sprite = document.createElement('canvas')
    sprite.width = size
    sprite.height = size
    const g = sprite.getContext('2d')
    const center = size / 2
    const core = size * 0.2
    const halo = size * 0.47
    const gradient = g.createRadialGradient(center, center, core * 0.2, center, center, halo)
    gradient.addColorStop(0, 'rgba(255,255,255,0.98)')
    gradient.addColorStop(0.42, color)
    gradient.addColorStop(0.55, hexAlpha(color, 0.72))
    gradient.addColorStop(0.78, hexAlpha(color, 0.16))
    gradient.addColorStop(1, hexAlpha(color, 0))
    g.fillStyle = gradient
    g.beginPath()
    g.arc(center, center, halo, 0, TAU)
    g.fill()
    g.fillStyle = 'rgba(255,255,255,0.92)'
    g.beginPath()
    g.arc(center - core * 0.3, center - core * 0.32, core * 0.3, 0, TAU)
    g.fill()
    return sprite
  }

  function hexAlpha(hex, alphaValue) {
    const value = String(hex).replace('#', '')
    const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
    const number = Number.parseInt(full, 16)
    const red = (number >> 16) & 255
    const green = (number >> 8) & 255
    const blue = number & 255
    return `rgba(${red},${green},${blue},${alphaValue})`
  }

  function nodeColor(node) {
    if (node.type === 'bank') return node.status === 'archived' ? paletteNow.bankArchived : paletteNow.bank
    return paletteNow.kinds[node.kind] ?? '#94a3b8'
  }

  function nodeRadius(node) {
    if (node.type === 'bank') return 15 + Math.sqrt(Math.max(1, node.entryCount ?? 1)) * 3.4
    const base = 5.2 + Math.log2(1 + Math.max(0, node.degree ?? 0)) * 1.5
    return base + (node.pinned ? 1.6 : 0) + (node.retention ?? 0.5) * 1.4
  }

  function simulate() {
    if (alpha < 0.003) return
    const nodes = data.nodes
    const forces = new Map(nodes.map((node) => [node.id, { x: 0, y: 0, z: 0 }]))
    const push = (node, x, y, z) => {
      const force = forces.get(node.id)
      force.x += x
      force.y += y
      force.z += z
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]
      const pa = positions.get(a.id)
      if (!pa) continue
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]
        const pb = positions.get(b.id)
        if (!pb) continue
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let dz = pa.z - pb.z
        let dist2 = dx * dx + dy * dy + dz * dz
        if (dist2 < 60) {
          const seed = hash(`${a.id}:${b.id}`) * TAU
          pa.x += Math.cos(seed) * 4
          pa.y += Math.sin(seed) * 4
          pa.z += Math.cos(seed * 1.7) * 4
          dx = pa.x - pb.x
          dy = pa.y - pb.y
          dz = pa.z - pb.z
          dist2 = dx * dx + dy * dy + dz * dz + 40
        }
        const chargeA = a.type === 'bank' ? 4200 : 900
        const chargeB = b.type === 'bank' ? 4200 : 900
        const strength = Math.min(48, (chargeA * chargeB) / (dist2 * 28))
        const distance = Math.sqrt(dist2) || 1
        const fx = (dx / distance) * strength
        const fy = (dy / distance) * strength
        const fz = (dz / distance) * strength
        push(a, fx, fy, fz)
        push(b, -fx, -fy, -fz)
      }
    }

    for (const edge of data.edges) {
      const a = positions.get(edge.source)
      const b = positions.get(edge.target)
      if (!a || !b) continue
      const rest = REST_LENGTH[edge.type] ?? 120
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      const weight = Math.min(2.4, edge.weight ?? 1)
      const force = ((distance - rest) / distance) * 0.012 * weight
      const fx = dx * force
      const fy = dy * force
      const fz = dz * force
      const sourceNode = nodeById.get(edge.source)
      const targetNode = nodeById.get(edge.target)
      if (!sourceNode || !targetNode) continue
      push(sourceNode, fx, fy, fz)
      push(targetNode, -fx, -fy, -fz)
    }

    for (const node of nodes) {
      const point = positions.get(node.id)
      const force = forces.get(node.id)
      if (!point || !force) continue
      // Banks anchor to their ring slot; entries drift toward the centre.
      if (node.type === 'bank') {
        point.ax ??= point.x
        point.ay ??= point.y
        point.az ??= point.z
        force.x += (point.ax - point.x) * 0.05
        force.y += (point.ay - point.y) * 0.05
        force.z += (point.az - point.z) * 0.05
      } else {
        force.x += -point.x * 0.0011
        force.y += -point.y * 0.0016
        force.z += -point.z * 0.0011
      }
      const cooling = alpha
      point.vx = (point.vx + force.x * cooling) * DEFAULTS.damping
      point.vy = (point.vy + force.y * cooling) * DEFAULTS.damping
      point.vz = (point.vz + force.z * cooling) * DEFAULTS.damping
      const speed = Math.sqrt(point.vx * point.vx + point.vy * point.vy + point.vz * point.vz)
      const limit = 12
      if (speed > limit) {
        point.vx = (point.vx / speed) * limit
        point.vy = (point.vy / speed) * limit
        point.vz = (point.vz / speed) * limit
      }
      point.x += point.vx
      point.y += point.vy
      point.z += point.vz
    }
    alpha *= DEFAULTS.cooling
    if (alpha < 0.003) alpha = 0
  }

  function cameraAngle() {
    if (camera.mode === '2d') return { yaw: 0, pitch: 0 }
    return { yaw: camera.yaw, pitch: camera.pitch }
  }

  function projectPoint(point) {
    const { yaw, pitch } = cameraAngle()
    const cosYaw = Math.cos(yaw)
    const sinYaw = Math.sin(yaw)
    const cosPitch = Math.cos(pitch)
    const sinPitch = Math.sin(pitch)
    const x1 = point.x * cosYaw - point.z * sinYaw
    const z1 = point.x * sinYaw + point.z * cosYaw
    const y1 = point.y * cosPitch - z1 * sinPitch
    const z2 = point.y * sinPitch + z1 * cosPitch
    const depth = z2 + camera.distance
    const scale = DEFAULTS.focal / Math.max(120, depth)
    return {
      x: (width - insetRight) / 2 + (x1 + camera.panX) * scale,
      y: height / 2 + (y1 + camera.panY) * scale,
      scale,
      depth,
    }
  }

  function focusIds() {
    if (!selected) return null
    const set = new Set([selected, ...(adjacency.get(selected) ?? [])])
    return set
  }

  function edgeColor(edge) {
    if (edge.type === 'relation') return paletteNow.relations[edge.subtype] ?? paletteNow.edges.relation ?? EDGE_COLORS.relation
    return paletteNow.edges[edge.type] ?? EDGE_COLORS[edge.type] ?? '#64748b'
  }

  function drawEdge(edge, a, b, focus) {
    let color = edgeColor(edge)
    const style = edgeStyle(edge, { scale: (a.scale + b.scale) / 2, depth: (a.depth + b.depth) / 2 })
    let alphaValue = style.alpha
    if (focus) {
      const connected = focus.has(edge.source) && focus.has(edge.target)
      if (!connected) alphaValue *= 0.3
      else alphaValue = Math.min(1, alphaValue * 2.1)
    }
    if (highlight && !(highlight.has(edge.source) && highlight.has(edge.target))) alphaValue *= 0.08
    ctx.globalAlpha = alphaValue
    ctx.strokeStyle = color
    ctx.lineWidth = style.width
    if (style.dashed) {
      ctx.setLineDash([4 * Math.max(0.7, a.scale), 6 * Math.max(0.7, a.scale)])
    } else {
      ctx.setLineDash([])
    }
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    const midX = (a.x + b.x) / 2 + (a.y - b.y) * 0.035
    const midY = (a.y + b.y) / 2 + (b.x - a.x) * 0.035
    ctx.quadraticCurveTo(midX, midY, b.x, b.y)
    ctx.stroke()
    ctx.setLineDash([])

    if (edge.directed) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy) || 1
      const size = Math.max(5, Math.min(10, 5.8 * a.scale))
      const ux = dx / length
      const uy = dy / length
      const tipX = b.x - ux * (nodeRadius(nodeById.get(edge.target) ?? {}) * a.scale + 2)
      const tipY = b.y - uy * (nodeRadius(nodeById.get(edge.target) ?? {}) * a.scale + 2)
      ctx.globalAlpha = alphaValue * 0.9
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(tipX, tipY)
      ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55)
      ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55)
      ctx.closePath()
      ctx.fill()
    }
  }

  function drawNode(node, point, focus) {
    const radius = nodeRadius(node) * point.scale
    const isBank = node.type === 'bank'
    const sprite = sprites.get(isBank ? (node.status === 'archived' ? 'archived-bank' : 'bank') : node.kind) ?? sprites.get('bank')
    let alphaValue = depthAlpha(point.depth)
    if (node.status === 'superseded') alphaValue *= 0.42
    if (node.status === 'archived') alphaValue *= 0.26
    if (focus && !focus.has(node.id)) alphaValue *= 0.42
    if (highlight && !highlight.has(node.id)) alphaValue *= 0.12
    ctx.globalAlpha = Math.max(0.05, alphaValue)
    const size = (radius / 0.2) * 0.96
    if (size > 0.5) ctx.drawImage(sprite, point.x - size / 2, point.y - size / 2, size, size)

    if (node.pinned) {
      ctx.globalAlpha = Math.max(0.15, alphaValue * 0.9)
      ctx.strokeStyle = paletteNow.pinned
      ctx.lineWidth = Math.max(1, 1.4 * point.scale)
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius + 3.6, 0, TAU)
      ctx.stroke()
    }
    if (node.id === hovered || node.id === selected) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = node.id === selected ? paletteNow.selectRing : paletteNow.hoverRing
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius + 6.2, 0, TAU)
      ctx.stroke()
    }

    ctx.globalAlpha = 1
  }

  function drawLabels(items, focus) {
    const boxes = []
    const candidates = []
    for (const { node, point } of items) {
      const isBank = node.type === 'bank'
      const show =
        isBank ||
        node.id === selected ||
        node.id === hovered ||
        (point.scale > 1.02 && (node.degree ?? 0) >= 4) ||
        point.scale > 1.45
      if (!show) continue
      const priority = node.id === selected ? 3 : node.id === hovered ? 3 : isBank ? 2 : 1
      candidates.push({ node, point, isBank, priority })
    }
    candidates.sort((left, right) => right.priority - left.priority)

    for (const { node, point, isBank } of candidates) {
      const text = isBank ? node.label : node.topic ?? node.label
      const fontSize = isBank ? 12.5 : 10.5
      const label = truncate(text, isBank ? 28 : 34)
      ctx.font = `${isBank ? 600 : 500} ${fontSize}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`
      const textWidth = ctx.measureText(label).width
      const radius = nodeRadius(node) * point.scale
      const forced = node.id === selected || node.id === hovered
      const box = isBank
        ? { x: point.x - textWidth / 2 - 6, y: point.y - radius - 9 - fontSize - 4, w: textWidth + 12, h: fontSize + 7 }
        : { x: point.x - textWidth / 2 - 3, y: point.y + radius + 7, w: textWidth + 6, h: fontSize + 4 }
      if (!forced && boxes.some((other) => overlaps(other, box))) continue
      boxes.push(box)

      let alphaValue = depthAlpha(point.depth)
      if (node.status === 'superseded') alphaValue *= 0.5
      if (node.status === 'archived') alphaValue *= 0.4
      if (focus && !focus.has(node.id)) alphaValue *= 0.5
      if (highlight && !highlight.has(node.id)) alphaValue *= 0.15
      alphaValue = Math.max(0.32, Math.min(1, alphaValue + 0.2))
      ctx.globalAlpha = alphaValue
      ctx.textAlign = 'center'
      ctx.textBaseline = isBank ? 'bottom' : 'top'
      ctx.fillStyle = isBank ? paletteNow.label : paletteNow.labelMuted
      const labelY = isBank ? point.y - radius - 9 : point.y + radius + 7
      if (isBank) {
        ctx.save()
        ctx.globalAlpha *= 0.55
        ctx.fillStyle = paletteNow.labelPanel
        roundRect(box.x, box.y, box.w, box.h, 6)
        ctx.fill()
        ctx.restore()
        ctx.fillStyle = paletteNow.label
        ctx.globalAlpha = alphaValue
      }
      ctx.shadowColor = paletteNow.labelShadow
      ctx.shadowBlur = 5
      ctx.fillText(label, point.x, labelY)
      ctx.shadowBlur = 0
    }
    ctx.globalAlpha = 1
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  function truncate(text, limit) {
    const value = String(text ?? '')
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
  }

  function render() {
    if (disposed) return
    if (!running) {
      animation = requestAnimationFrame(render)
      return
    }
    if (camera.autoRotate && camera.mode === '3d' && !drag) camera.yaw += 0.0016
    simulate()

    const ctx2 = ctx
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx2.clearRect(0, 0, width, height)

    const focus = focusIds()
    screen = new Map()
    for (const node of data.nodes) {
      const point = positions.get(node.id)
      if (!point) continue
      const projected = projectPoint(point)
      screen.set(node.id, projected)
    }

    // Edges first, far to near.
    const orderedEdges = data.edges
      .map((edge) => {
        const a = screen.get(edge.source)
        const b = screen.get(edge.target)
        return a && b ? { edge, a, b, depth: (a.depth + b.depth) / 2 } : null
      })
      .filter(Boolean)
      .sort((left, right) => right.depth - left.depth)
    for (const item of orderedEdges) drawEdge(item.edge, item.a, item.b, focus)

    // Nodes far to near.
    const orderedNodes = data.nodes
      .map((node) => {
        const point = screen.get(node.id)
        return point ? { node, point } : null
      })
      .filter(Boolean)
      .sort((left, right) => right.point.depth - left.point.depth)
    for (const item of orderedNodes) drawNode(item.node, item.point, focus)
    drawLabels(orderedNodes, focus)

    if (needsRepaint) needsRepaint = false
    scheduleTooltip()
    animation = requestAnimationFrame(render)
  }

  function hitTest(x, y) {
    let best = null
    let bestScore = Infinity
    for (const node of data.nodes) {
      const point = screen.get(node.id)
      if (!point) continue
      const radius = Math.max(7, nodeRadius(node) * point.scale) + 5
      const distance = Math.hypot(point.x - x, point.y - y)
      if (distance > radius) continue
      const score = distance - point.depth * 0.001
      if (score < bestScore) {
        bestScore = score
        best = node
      }
    }
    return best
  }

  function tooltipHtml(node) {
    const custom = formatTooltip(node)
    if (custom) return custom
    const meta = node.type === 'bank'
      ? `${node.entryCount ?? 0} 条记忆`
      : `${node.kind} · ${node.status}${node.pinned ? ' · 固定' : ''}`
    const retention = node.type === 'entry' ? `<div class="tt-meta">留存 ${Math.round((node.retention ?? 0) * 100)}% · ${node.stage ?? ''}</div>` : ''
    return `<div class="tt-topic">${escapeHtml(node.topic ?? node.label)}</div><div class="tt-claim">${escapeHtml(node.claim ?? node.label)}</div><div class="tt-meta">${escapeHtml(meta)}</div>${retention}`
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  }

  function scheduleTooltip() {
    if (!tooltip) return
    if (hovered && pointer.inside) {
      const node = nodeById.get(hovered)
      const point = node ? screen.get(node.id) : null
      if (node && point) {
        tooltip.innerHTML = tooltipHtml(node)
        tooltip.hidden = false
        const box = tooltip.getBoundingClientRect()
        let left = point.x + 14
        let top = point.y + 14
        if (left + box.width > width - 8) left = point.x - box.width - 14
        if (top + box.height > height - 8) top = point.y - box.height - 14
        tooltip.style.left = `${Math.max(8, left)}px`
        tooltip.style.top = `${Math.max(8, top)}px`
      } else {
        tooltip.hidden = true
      }
    } else {
      tooltip.hidden = true
    }
  }

  function setPointer(event) {
    const rect = canvas.getBoundingClientRect()
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true }
    return pointer
  }

  const tooltip = options.tooltip ?? null

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture?.(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    canvas.classList.add('is-dragging')
    const position = setPointer(event)
    drag = {
      id: event.pointerId,
      startX: position.x,
      startY: position.y,
      lastX: position.x,
      lastY: position.y,
      moved: 0,
      shift: event.shiftKey,
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), panX: camera.panX, panY: camera.panY }
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    const position = setPointer(event)
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()]
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1
      camera.distance = clamp(camera.distance * (pinch.distance / distance), DEFAULTS.minDistance, DEFAULTS.maxDistance)
      needsRepaint = true
      return
    }

    if (drag) {
      const dx = position.x - drag.lastX
      const dy = position.y - drag.lastY
      drag.lastX = position.x
      drag.lastY = position.y
      drag.moved += Math.abs(dx) + Math.abs(dy)
      if (drag.shift) {
        camera.panX += dx
        camera.panY += dy
      } else {
        if (camera.mode === '3d') {
          camera.yaw += dx * 0.005
          camera.pitch = clamp(camera.pitch + dy * 0.0045, -1.32, 1.32)
        } else {
          camera.panX += dx
          camera.panY += dy
        }
      }
      needsRepaint = true
      return
    }

    const hit = hitTest(position.x, position.y)
    const nextHovered = hit?.id ?? null
    if (nextHovered !== hovered) {
      hovered = nextHovered
      onHover(hit ?? null)
      needsRepaint = true
    }
    canvas.style.cursor = hit ? 'pointer' : 'grab'
  })

  function endPointer(event) {
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinch = null
    canvas.classList.remove('is-dragging')
    if (!drag || drag.id !== event.pointerId) return
    const position = setPointer(event)
    const isClick = drag.moved < 5
    drag = null
    if (isClick) {
      const hit = hitTest(position.x, position.y)
      selected = hit?.id ?? null
      onSelect(hit ?? null)
      needsRepaint = true
    }
  }

  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)
  canvas.addEventListener('pointerleave', () => {
    pointer.inside = false
    hovered = null
    if (tooltip) tooltip.hidden = true
    onHover(null)
  })

  canvas.addEventListener('dblclick', (event) => {
    const position = setPointer(event)
    const hit = hitTest(position.x, position.y)
    if (hit) focus(hit.id)
  })

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault()
    const factor = Math.exp(event.deltaY * 0.0011)
    camera.distance = clamp(camera.distance * factor, DEFAULTS.minDistance, DEFAULTS.maxDistance)
    needsRepaint = true
  }, { passive: false })

  canvas.addEventListener('contextmenu', (event) => event.preventDefault())

  function resize() {
    const rect = canvas.getBoundingClientRect()
    width = Math.max(1, rect.width)
    height = Math.max(1, rect.height)
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    needsRepaint = true
  }

  function focus(nodeId) {
    const point = positions.get(nodeId)
    if (!point) return
    selected = nodeId
    const { yaw, pitch } = cameraAngle()
    const cosYaw = Math.cos(yaw)
    const sinYaw = Math.sin(yaw)
    const cosPitch = Math.cos(pitch)
    const sinPitch = Math.sin(pitch)
    const x1 = point.x * cosYaw - point.z * sinYaw
    const z1 = point.x * sinYaw + point.z * cosYaw
    const y1 = point.y * cosPitch - z1 * sinPitch
    camera.panX = -x1
    camera.panY = -y1
    camera.distance = Math.min(camera.distance, 1000)
    reheat(0.4)
    onSelect(nodeById.get(nodeId) ?? null)
    needsRepaint = true
  }

  function select(nodeId) {
    selected = nodeId
    needsRepaint = true
  }

  function resetView() {
    camera = {
      yaw: -0.42,
      pitch: 0.24,
      distance: DEFAULTS.distance,
      panX: 0,
      panY: 0,
      autoRotate: camera.autoRotate,
      mode: camera.mode,
    }
    reheat(0.35)
    needsRepaint = true
  }

  function setActive(active) {
    running = Boolean(active)
    needsRepaint = true
  }

  function setOptions(next = {}) {
    if (next.autoRotate !== undefined) camera.autoRotate = Boolean(next.autoRotate)
    if (next.mode === '2d' || next.mode === '3d') {
      camera.mode = next.mode
      if (next.mode === '2d') {
        camera.pitch = 0
      } else {
        camera.pitch = 0.24
      }
    }
    if (next.palette) {
      paletteNow = buildPalette({ ...paletteNow, ...next.palette })
      rebuildSprites()
    }
    if (next.highlight !== undefined) {
      highlight = next.highlight ? new Set(next.highlight) : null
    }
    needsRepaint = true
  }

  function setInsetRight(pixels) {
    const next = Math.max(0, Number(pixels) || 0)
    if (next === insetRight) return
    insetRight = next
    needsRepaint = true
  }

  function destroy() {
    disposed = true
    cancelAnimationFrame(animation)
    resizeObserver?.disconnect()
    if (topicTimer) clearTimeout(topicTimer)
  }

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  resize()
  animation = requestAnimationFrame(render)

  return {
    setData,
    setOptions,
    setActive,
    setInsetRight,
    focus,
    select,
    resetView,
    resize,
    destroy,
    get camera() {
      return camera
    },
    get selected() {
      return selected
    },
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
