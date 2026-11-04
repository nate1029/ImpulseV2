// Everything the machine shows on its screens, painted on canvases: the AI chat,
// the editor writing the sketch, the breadboard, the simulator, the upload and the
// serial printout. One sketch runs through all of them, so every screen agrees:
// pin 13 blinks at 1 Hz and Serial prints "ready", "LED on", "LED off".

export type Fonts = { sans: string; mono: string }
type C = CanvasRenderingContext2D

// The app's dark design tokens (src/renderer/design-system.css).
export const UI = {
  canvas: '#08090a',
  s1: '#0f1011',
  s2: '#141516',
  s3: '#1c1c1f',
  line: '#23252a',
  lineStrong: '#34343a',
  text: '#f7f8f8',
  text2: '#d0d6e0',
  text3: '#9ba0a8',
  text4: '#868b93',
  green: '#71d083',
  greenDeep: '#366740',
  warn: '#e2b866',
  teal: '#0d7f87',
  ivory: '#eeece4',
  copper: '#c57e45',
}
const SYN = {
  keyword: '#bd9f65',
  comment: '#7388a4',
  string: '#a3c49a',
  number: '#d4a0c7',
  def: '#86aee8',
  type: '#7cc7c0',
  plain: '#e4e6ea',
  punct: '#8a8f98',
}
const TAU = Math.PI * 2

export const SKETCH = [
  '// Blink pin 13 and log it',
  'const int LED = 13;',
  '',
  'void setup() {',
  '  pinMode(LED, OUTPUT);',
  '  Serial.begin(9600);',
  '  Serial.println("ready");',
  '}',
  '',
  'void loop() {',
  '  digitalWrite(LED, HIGH);',
  '  Serial.println("LED on");',
  '  delay(500);',
  '  digitalWrite(LED, LOW);',
  '  Serial.println("LED off");',
  '  delay(500);',
  '}',
]
export const PROMPT = 'Blink pin 13 every 500 ms and log it to Serial.'
export const TESTS = ['serial contains "ready"', 'pin 13 toggles', 'pin 13 frequency 1Hz ±10%']
/** The sketch's LED: on for the first half of every simulated second. */
export const ledOn = (t: number) => t % 1 < 0.5
/** Every screen runs on the same 10 s loop; at this moment all of them show a finished result. */
export const STILL_FRAME = 8.5

export function text(
  c: C,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = 500,
  family: string
) {
  c.fillStyle = color
  c.font = `${weight} ${size}px ${family}`
  c.fillText(s, x, y)
}
function rr(c: C, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath()
  c.roundRect(x, y, w, h, r)
}
function check(c: C, x: number, y: number, s: number, color: string, width = 2.4) {
  c.strokeStyle = color
  c.lineWidth = width
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(x, y + s * 0.5)
  c.lineTo(x + s * 0.36, y + s * 0.85)
  c.lineTo(x + s, y + s * 0.12)
  c.stroke()
}
/** The Impulse mark: a pulse and a green dot. */
export function mark(c: C, x: number, y: number, s: number, stroke: string, dot = UI.green) {
  const p = (u: number, v: number): [number, number] => [x + (u / 1024) * s, y + (v / 1024) * s]
  c.strokeStyle = stroke
  c.lineWidth = (58 / 1024) * s
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  const pts: Array<[number, number]> = [
    [232, 512],
    [344, 512],
    [428, 260],
    [596, 764],
    [680, 512],
    [724, 512],
  ]
  pts.forEach(([u, v], i) => (i ? c.lineTo(...p(u, v)) : c.moveTo(...p(u, v))))
  c.stroke()
  c.fillStyle = dot
  c.beginPath()
  c.arc(...p(796, 512), (40 / 1024) * s, 0, TAU)
  c.fill()
}

// --- Syntax colouring, just enough for the sketch -------------------------
const KEYWORDS = new Set(['const', 'void'])
const TYPES = new Set(['int'])
const CALLS = new Set(['pinMode', 'digitalWrite', 'delay', 'begin', 'println', 'setup', 'loop'])
const CONSTANTS = new Set(['OUTPUT', 'HIGH', 'LOW', 'LED', 'Serial'])
export function tokens(line: string): Array<[string, string]> {
  const i = line.indexOf('//')
  if (i >= 0) return [[line.slice(0, i), SYN.plain], [line.slice(i), SYN.comment]]
  const out: Array<[string, string]> = []
  const re = /("[^"]*")|(\b\d+\b)|([A-Za-z_]\w*)|(\s+)|([^\sA-Za-z_\d"]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    const [s, str, num, word] = m
    let color = SYN.punct
    if (str) color = SYN.string
    else if (num) color = SYN.number
    else if (word)
      color = KEYWORDS.has(word)
        ? SYN.keyword
        : TYPES.has(word)
          ? SYN.type
          : CALLS.has(word)
            ? SYN.def
            : CONSTANTS.has(word)
              ? SYN.number
              : SYN.plain
    out.push([s, color])
  }
  return out
}
const TOTAL_CHARS = SKETCH.reduce((n, l) => n + l.length + 1, 0)

/** The editor at the Write station: the agent types the sketch, then compiles it. */
export function paintCode(c: C, w: number, h: number, t: number, F: Fonts) {
  const cycle = 10,
    p = t % cycle
  c.fillStyle = UI.s1
  c.fillRect(0, 0, w, h)
  c.fillStyle = UI.s2
  c.fillRect(0, 0, w, 50)
  c.fillStyle = UI.line
  c.fillRect(0, 50, w, 1)
  c.fillStyle = UI.s1
  c.fillRect(14, 10, 150, 41)
  c.fillStyle = UI.green
  c.fillRect(14, 48, 150, 3)
  c.beginPath()
  c.arc(32, 31, 5, 0, TAU)
  c.fill()
  text(c, 'blink.ino', 46, 37, 17, UI.text, 500, F.sans)
  text(c, 'Arduino Uno', w - 118, 37, 15, UI.text4, 500, F.sans)

  const typed = Math.floor(Math.min(1, p / 6.2) * TOTAL_CHARS)
  let left = typed,
    cursor: [number, number] | null = null
  const x0 = 50,
    y0 = 88,
    lh = 25
  c.font = `450 15px ${F.mono}`
  const cw = c.measureText('M').width
  SKETCH.forEach((line, i) => {
    const y = y0 + i * lh
    if (left <= 0 && cursor) return
    c.textAlign = 'right'
    text(c, String(i + 1), 34, y, 13, '#4d525a', 450, F.mono)
    c.textAlign = 'left'
    const shown = Math.max(0, Math.min(line.length, left))
    let x = x0,
      budget = shown
    for (const [s, color] of tokens(line)) {
      if (budget <= 0) break
      const part = s.slice(0, budget)
      text(c, part, x, y, 15, color, 450, F.mono)
      x += part.length * cw
      budget -= part.length
    }
    if (left <= line.length && !cursor) cursor = [x0 + shown * cw, y]
    left -= line.length + 1
  })
  if (cursor && p < 6.4 && Math.floor(t * 2.6) % 2 === 0) {
    const [cx, cy] = cursor as [number, number]
    c.fillStyle = UI.green
    c.fillRect(cx + 1, cy - 14, 2, 18)
  }

  // The status strip: writing, compiling, compiled.
  const sy = h - 92
  c.fillStyle = UI.s2
  c.fillRect(0, sy, w, 92)
  c.fillStyle = UI.line
  c.fillRect(0, sy, w, 1)
  if (p < 6.4) {
    spinner(c, 30, sy + 34, 8, t)
    text(c, 'Writing blink.ino', 50, sy + 40, 17, UI.text2, 500, F.sans)
    const line = Math.min(SKETCH.length, 1 + SKETCH.findIndex((_, i) => charsBefore(i + 1) > typed))
    text(c, `line ${line || SKETCH.length} of ${SKETCH.length}`, 50, sy + 66, 13, UI.text4, 450, F.mono)
  } else if (p < 7.6) {
    spinner(c, 30, sy + 34, 8, t)
    text(c, 'Compiling for Uno…', 50, sy + 40, 17, UI.text2, 500, F.sans)
    c.fillStyle = UI.line
    rr(c, 50, sy + 56, w - 80, 6, 3)
    c.fill()
    c.fillStyle = UI.green
    rr(c, 50, sy + 56, (w - 80) * ((p - 6.4) / 1.2), 6, 3)
    c.fill()
  } else {
    check(c, 22, sy + 27, 17, UI.green, 3)
    text(c, 'Compiled', 50, sy + 40, 17, UI.green, 600, F.sans)
    text(c, '2,014 bytes · 6% of flash', 50, sy + 66, 13, UI.text4, 450, F.mono)
  }
}
function charsBefore(line: number) {
  let n = 0
  for (let i = 0; i < line; i++) n += SKETCH[i].length + 1
  return n
}
function spinner(c: C, x: number, y: number, r: number, t: number) {
  c.lineWidth = 2.2
  c.strokeStyle = UI.line
  c.beginPath()
  c.arc(x, y, r, 0, TAU)
  c.stroke()
  c.strokeStyle = UI.green
  c.beginPath()
  c.arc(x, y, r, t * 5, t * 5 + 1.7)
  c.stroke()
}

// The MorphOrb from the app's chat, as dots on a turning sphere.
const ORB_POINTS = (() => {
  const n = 190,
    pts: Array<[number, number, number]> = []
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2,
      r = Math.sqrt(1 - y * y),
      a = i * 2.39996
    pts.push([Math.cos(a) * r, y, Math.sin(a) * r])
  }
  return pts
})()
export function paintOrb(c: C, cx: number, cy: number, radius: number, t: number, done: number) {
  const spin = t * 0.7,
    breathe = 1 + Math.sin(t * 3.1) * 0.035 * (1 - done)
  for (const [x, y, z] of ORB_POINTS) {
    const rx = x * Math.cos(spin) - z * Math.sin(spin),
      rz = x * Math.sin(spin) + z * Math.cos(spin)
    const depth = (rz + 1) / 2
    // Grey at rest turning to the app's green as the work completes.
    const g = Math.round(205 + 30 * depth)
    c.fillStyle =
      done > 0
        ? `rgba(${Math.round(g - (g - 113) * done)},${Math.round(g - (g - 208) * done)},${Math.round(g - (g - 131) * done)},${0.22 + depth * 0.78})`
        : `rgba(${g},${g},${g},${0.2 + depth * 0.8})`
    c.beginPath()
    c.arc(cx + rx * radius * breathe, cy + y * radius * breathe, 1.1 + depth * 1.9, 0, TAU)
    c.fill()
  }
}

const ORB_STEPS = ['Thinking', 'Writing the sketch', 'Compiling', 'Wiring the circuit', 'Running the tests']
/** The chat at the Ask station: your prompt, the orb working, then the answer card. */
export function paintChat(c: C, w: number, h: number, t: number, F: Fonts) {
  const cycle = 10,
    p = (t % cycle) / cycle
  c.fillStyle = UI.s1
  c.fillRect(0, 0, w, h)
  c.fillStyle = UI.s2
  c.fillRect(0, 0, w, 56)
  c.fillStyle = UI.line
  c.fillRect(0, 56, w, 1)
  mark(c, 14, 6, 44, UI.text)
  text(c, 'Impulse AI', 60, 36, 19, UI.text, 600, F.sans)
  c.strokeStyle = UI.lineStrong
  c.lineWidth = 1.5
  rr(c, w - 104, 15, 88, 28, 14)
  c.stroke()
  c.fillStyle = UI.green
  c.beginPath()
  c.arc(w - 88, 29, 4, 0, TAU)
  c.fill()
  text(c, 'Claude', w - 77, 35, 15, UI.text2, 500, F.sans)

  // Your message.
  c.fillStyle = UI.s3
  rr(c, w - 352, 74, 334, 76, 16)
  c.fill()
  text(c, 'Blink pin 13 every 500 ms', w - 332, 105, 18, UI.text, 500, F.sans)
  text(c, 'and log it to Serial.', w - 332, 133, 18, UI.text, 500, F.sans)

  if (p < 0.7) {
    const step = Math.min(ORB_STEPS.length - 1, Math.floor((p / 0.7) * ORB_STEPS.length))
    paintOrb(c, w / 2, 248, 64, t, 0)
    const label = ORB_STEPS[step]
    c.font = `500 16px ${F.sans}`
    const lw = c.measureText(label).width + 40
    c.fillStyle = UI.s2
    rr(c, w / 2 - lw / 2, 334, lw, 34, 17)
    c.fill()
    c.strokeStyle = UI.line
    c.stroke()
    c.textAlign = 'center'
    text(c, label, w / 2 + 6, 357, 16, UI.text2, 500, F.sans)
    c.textAlign = 'left'
    c.fillStyle = UI.green
    c.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(t * 4))
    c.beginPath()
    c.arc(w / 2 - lw / 2 + 18, 351, 3.5, 0, TAU)
    c.fill()
    c.globalAlpha = 1
  } else {
    const k = Math.min(1, (p - 0.7) / 0.06)
    c.globalAlpha = k
    c.fillStyle = UI.s2
    rr(c, 18, 170 + (1 - k) * 12, w - 36, 208, 16)
    c.fill()
    c.strokeStyle = UI.line
    c.lineWidth = 1.5
    c.stroke()
    const y = 170 + (1 - k) * 12
    text(c, 'Pin 13 now blinks every 500 ms and', 38, y + 38, 17, UI.text, 500, F.sans)
    text(c, 'prints each change at 9600 baud.', 38, y + 63, 17, UI.text, 500, F.sans)
    c.fillStyle = UI.s1
    rr(c, 38, y + 82, w - 76, 36, 8)
    c.fill()
    text(c, 'blink.ino', 52, y + 106, 14, UI.text3, 450, F.mono)
    text(c, '17 lines', w - 108, y + 106, 14, UI.text4, 450, F.mono)
    check(c, 40, y + 136, 15, UI.green, 2.6)
    text(c, 'Simulated · 3 of 3 tests passed', 64, y + 150, 15, UI.green, 500, F.sans)
    c.fillStyle = UI.greenDeep
    rr(c, 38, y + 166, 98, 30, 8)
    c.fill()
    text(c, 'Upload', 60, y + 186, 14, UI.green, 600, F.sans)
    c.strokeStyle = UI.lineStrong
    rr(c, 146, y + 166, 130, 30, 8)
    c.stroke()
    text(c, 'Open circuit', 164, y + 186, 14, UI.text2, 500, F.sans)
    c.globalAlpha = 1
  }

  // The composer.
  c.fillStyle = UI.s2
  rr(c, 18, h - 60, w - 36, 44, 22)
  c.fill()
  c.strokeStyle = UI.line
  c.lineWidth = 1.5
  c.stroke()
  text(c, 'Ask Impulse…', 40, h - 32, 16, UI.text4, 450, F.sans)
  c.fillStyle = UI.text
  c.beginPath()
  c.arc(w - 42, h - 38, 14, 0, TAU)
  c.fill()
  c.strokeStyle = UI.canvas
  c.lineWidth = 2.4
  c.beginPath()
  c.moveTo(w - 42, h - 31)
  c.lineTo(w - 42, h - 45)
  c.moveTo(w - 48, h - 39)
  c.lineTo(w - 42, h - 45)
  c.lineTo(w - 36, h - 39)
  c.stroke()
}

/** A half-size breadboard: power rails, a-j rows, the centre channel. */
export function paintBreadboard(c: C, w: number, h: number, F: Fonts) {
  const g = c.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#f3f1ea')
  g.addColorStop(1, '#e2dfd5')
  c.fillStyle = g
  c.fillRect(0, 0, w, h)
  c.fillStyle = '#d3d0c5'
  c.fillRect(0, h / 2 - 7, w, 14)
  const hole = (x: number, y: number) => {
    c.fillStyle = '#3d3f40'
    rr(c, x - 3.6, y - 3.6, 7.2, 7.2, 1.6)
    c.fill()
  }
  for (const [y0, red] of [
    [22, true],
    [h - 46, false],
  ] as const) {
    c.fillStyle = red ? '#d8564a' : '#4c78c9'
    c.fillRect(24, y0 - 6, w - 48, 2)
    c.fillStyle = red ? '#4c78c9' : '#d8564a'
    c.fillRect(24, y0 + 30, w - 48, 2)
    for (let i = 0; i < 25; i++) {
      const x = 44 + i * 22 + Math.floor(i / 5) * 8
      hole(x, y0 + 7)
      hole(x, y0 + 19)
    }
  }
  const cols = 30
  for (let r = 0; r < 10; r++) {
    const y = r < 5 ? 84 + r * 17 : h / 2 + 22 + (r - 5) * 17
    for (let i = 0; i < cols; i++) hole(36 + i * 19.4, y)
    c.textAlign = 'center'
    text(c, 'abcdefghij'[r], 18, y + 4, 10, '#8f8c80', 600, F.mono)
  }
  for (let i = 0; i < cols; i += 5) text(c, String(i + 1), 36 + i * 19.4, 72, 9, '#9a978b', 600, F.mono)
  c.textAlign = 'left'
}

/** The circuit check on the Wire station's front. */
export function paintCheck(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#101614'
  c.fillRect(0, 0, w, h)
  text(c, 'CIRCUIT CHECK', 26, 44, 20, UI.text3, 600, F.mono)
  check(c, 28, 66, 22, UI.green, 3.4)
  text(c, '4 parts · no issues', 64, 88, 30, '#e3eadf', 550, F.sans)
  text(c, 'LED · 220 Ω · button · Uno', 28, 128, 17, '#7f948a', 450, F.mono)
}

/** The simulator at the Simulate station: the board running, the waveform, the tests. */
export function paintSim(c: C, w: number, h: number, t: number, F: Fonts) {
  c.fillStyle = UI.canvas
  c.fillRect(0, 0, w, h)
  // Title bar.
  c.fillStyle = UI.s2
  c.fillRect(0, 0, w, 46)
  c.fillStyle = UI.line
  c.fillRect(0, 46, w, 1)
  ;['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
    c.fillStyle = col
    c.beginPath()
    c.arc(22 + i * 20, 23, 6, 0, TAU)
    c.fill()
  })
  text(c, 'blink.ino — Impulse', 92, 29, 15, UI.text3, 500, F.sans)
  c.fillStyle = UI.greenDeep
  rr(c, w - 214, 10, 108, 26, 13)
  c.fill()
  c.fillStyle = UI.green
  c.beginPath()
  c.moveTo(w - 198, 17)
  c.lineTo(w - 188, 23)
  c.lineTo(w - 198, 29)
  c.fill()
  text(c, 'Running', w - 180, 28, 14, UI.green, 600, F.sans)
  const secs = t % 60
  text(c, `00:${secs < 10 ? '0' : ''}${secs.toFixed(1)}`, w - 92, 29, 14, UI.text3, 450, F.mono)

  // Canvas with the board and the breadboard.
  const cw = 548
  c.fillStyle = '#0b0c0e'
  c.fillRect(0, 47, cw, h - 47)
  c.fillStyle = '#1f2125'
  for (let x = 12; x < cw; x += 18) for (let y = 58; y < h - 128; y += 18) c.fillRect(x, y, 2, 2)
  const on = ledOn(t)
  // Uno.
  const bx = 34,
    by = 98
  c.fillStyle = '#0c6f77'
  rr(c, bx, by, 250, 186, 10)
  c.fill()
  c.strokeStyle = '#1a9aa3'
  c.lineWidth = 1.5
  c.stroke()
  c.fillStyle = '#b9bec4'
  c.fillRect(bx - 16, by + 22, 52, 46)
  c.fillStyle = '#26292d'
  c.fillRect(bx - 12, by + 120, 44, 40)
  c.fillStyle = '#1b1d20'
  c.fillRect(bx + 96, by + 102, 132, 30)
  for (let i = 0; i < 14; i++) {
    c.fillStyle = '#9aa0a6'
    c.fillRect(bx + 100 + i * 9, by + 98, 4, 4)
    c.fillRect(bx + 100 + i * 9, by + 132, 4, 4)
  }
  c.fillStyle = '#16181b'
  c.fillRect(bx + 80, by + 8, 160, 14)
  c.fillRect(bx + 104, by + 164, 130, 14)
  text(c, 'UNO', bx + 120, by + 80, 26, '#e9f6f4', 700, F.sans)
  c.fillStyle = on ? UI.warn : '#3b3420'
  c.fillRect(bx + 66, by + 40, 12, 7)
  text(c, 'L', bx + 82, by + 48, 11, '#cfe9e6', 600, F.mono)
  c.fillStyle = UI.green
  c.fillRect(bx + 210, by + 152, 10, 6)
  // Breadboard, LED and resistor.
  const qx = 330,
    qy = 116
  c.fillStyle = '#e9e6dc'
  rr(c, qx, qy, 190, 150, 6)
  c.fill()
  c.fillStyle = '#c9c5b9'
  for (let r = 0; r < 8; r++) for (let i = 0; i < 12; i++) c.fillRect(qx + 14 + i * 14.5, qy + 18 + r * 16 + (r > 3 ? 8 : 0), 4, 4)
  // Wires: pin 13 and GND.
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.lineWidth = 4
  c.strokeStyle = UI.green
  c.beginPath()
  c.moveTo(bx + 214, by + 15)
  c.lineTo(bx + 214, by - 24)
  c.lineTo(qx + 60, by - 24)
  c.lineTo(qx + 60, qy + 50)
  c.stroke()
  c.strokeStyle = '#2b2e33'
  c.beginPath()
  c.moveTo(bx + 150, by + 171)
  c.lineTo(bx + 150, qy + 196)
  c.lineTo(qx + 130, qy + 196)
  c.lineTo(qx + 130, qy + 116)
  c.stroke()
  // Resistor.
  c.strokeStyle = '#a99f8b'
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(qx + 60, qy + 50)
  c.lineTo(qx + 72, qy + 50)
  c.moveTo(qx + 108, qy + 50)
  c.lineTo(qx + 120, qy + 50)
  c.stroke()
  c.fillStyle = '#d9c9a3'
  rr(c, qx + 72, qy + 42, 36, 16, 7)
  c.fill()
  ;['#7a4b25', '#7a4b25', '#a8402f'].forEach((col, i) => {
    c.fillStyle = col
    c.fillRect(qx + 79 + i * 8, qy + 42, 4, 16)
  })
  // LED.
  c.strokeStyle = '#9aa0a6'
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(qx + 120, qy + 50)
  c.lineTo(qx + 120, qy + 86)
  c.moveTo(qx + 136, qy + 86)
  c.lineTo(qx + 130, qy + 116)
  c.stroke()
  if (on) {
    const glow = c.createRadialGradient(qx + 128, qy + 78, 4, qx + 128, qy + 78, 70)
    glow.addColorStop(0, 'rgba(113,208,131,.65)')
    glow.addColorStop(1, 'rgba(113,208,131,0)')
    c.fillStyle = glow
    c.fillRect(qx + 50, qy, 160, 160)
  }
  c.fillStyle = on ? '#b7f5c3' : '#2f5a3a'
  c.beginPath()
  c.arc(qx + 128, qy + 76, 13, Math.PI, 0)
  c.lineTo(qx + 141, qy + 90)
  c.lineTo(qx + 115, qy + 90)
  c.closePath()
  c.fill()
  text(c, 'D13', bx + 200, by - 32, 12, UI.text3, 500, F.mono)

  // Serial monitor under the canvas.
  const sy = h - 118
  c.fillStyle = UI.s1
  c.fillRect(0, sy, cw, 118)
  c.fillStyle = UI.line
  c.fillRect(0, sy, cw, 1)
  text(c, 'SERIAL MONITOR', 18, sy + 26, 12, UI.text4, 600, F.mono)
  text(c, '9600 baud', cw - 96, sy + 26, 12, UI.text4, 450, F.mono)
  const lines = serialLines(t, 3)
  lines.forEach((l, i) =>
    text(c, l, 18, sy + 54 + i * 22, 15, i === lines.length - 1 ? UI.text : UI.text3, 450, F.mono)
  )

  // Right column: logic analyzer and hardware tests.
  const rx = cw + 1
  c.fillStyle = UI.s1
  c.fillRect(rx, 47, w - rx, h - 47)
  c.fillStyle = UI.line
  c.fillRect(cw, 47, 1, h - 47)
  text(c, 'LOGIC ANALYZER', rx + 18, 78, 12, UI.text4, 600, F.mono)
  const traces: Array<[string, (u: number) => number, string]> = [
    ['D13', (u) => (ledOn(u) ? 1 : 0), UI.green],
    ['TX', (u) => (u % 0.5 < 0.06 && Math.floor(u * 160) % 3 !== 0 ? 1 : 0), '#86aee8'],
  ]
  traces.forEach(([name, f, col], k) => {
    const ty = 104 + k * 62,
      tw = w - rx - 78
    text(c, name, rx + 18, ty + 26, 13, UI.text3, 500, F.mono)
    c.strokeStyle = col
    c.lineWidth = 2
    c.beginPath()
    for (let i = 0; i <= tw; i += 1) {
      const u = t - 3 + (i / tw) * 3
      const y = ty + 36 - f(u) * 28
      if (i === 0) c.moveTo(rx + 60 + i, y)
      else c.lineTo(rx + 60 + i, y)
    }
    c.stroke()
  })
  text(c, '1.00 Hz · duty 50.0%', rx + 60, 246, 14, UI.green, 500, F.mono)

  c.fillStyle = UI.line
  c.fillRect(rx, 270, w - rx, 1)
  text(c, 'HARDWARE TESTS', rx + 18, 302, 12, UI.text4, 600, F.mono)
  const shown = Math.min(TESTS.length, Math.floor((t % 10) / 1.1))
  TESTS.forEach((name, i) => {
    const y = 330 + i * 40,
      ok = i < shown
    if (ok) check(c, rx + 18, y - 10, 14, UI.green, 2.4)
    else spinner(c, rx + 25, y - 3, 6, t)
    text(c, name, rx + 44, y + 2, 14, ok ? UI.text2 : UI.text4, 450, F.mono)
  })
  if (shown === TESTS.length) {
    c.fillStyle = UI.greenDeep
    rr(c, rx + 18, h - 74, w - rx - 36, 46, 10)
    c.fill()
    text(c, '3 of 3 passed', rx + 36, h - 44, 18, UI.green, 600, F.sans)
  }
}
/** The last few lines Serial has printed by simulated time t. */
export function serialLines(t: number, n: number) {
  const out = ['ready']
  const halves = Math.floor(t * 2)
  for (let i = Math.max(0, halves - n); i <= halves; i++) out.push(i % 2 ? 'LED off' : 'LED on')
  return out.slice(-n)
}

/** The screen over the Ship station: the upload, then the board running. */
export function paintUpload(c: C, w: number, h: number, t: number, F: Fonts) {
  const p = (t % 10) / 10
  c.fillStyle = '#0d1612'
  c.fillRect(0, 0, w, h)
  if (p < 0.5) {
    const k = p / 0.5
    text(c, 'UPLOADING', 24, 42, 17, '#8fa697', 600, F.mono)
    text(c, `${Math.round(k * 100)}%`, w - 78, 42, 17, '#8fa697', 500, F.mono)
    text(c, 'blink.ino → Uno', 24, 100, 36, '#e7efe6', 550, F.sans)
    c.fillStyle = '#22322a'
    rr(c, 24, 128, w - 48, 10, 5)
    c.fill()
    c.fillStyle = UI.green
    rr(c, 24, 128, (w - 48) * k, 10, 5)
    c.fill()
  } else {
    text(c, 'UPLOAD COMPLETE', 24, 42, 17, UI.green, 600, F.mono)
    check(c, 24, 70, 28, UI.green, 4)
    text(c, 'Running on your Uno', 66, 100, 34, '#e7efe6', 550, F.sans)
    text(c, 'avrdude: 2014 bytes written and verified', 24, 146, 15, '#7f948a', 450, F.mono)
  }
}

/** The serial printout tape at the Ship station. */
export function paintTape(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#f4f1ea'
  c.fillRect(0, 0, w, h)
  text(c, 'SERIAL MONITOR', 24, 50, 22, '#2f3832', 700, F.sans)
  text(c, 'Uno · 9600 baud', 24, 82, 17, '#5f6a62', 500, F.sans)
  c.strokeStyle = '#8a9189'
  c.setLineDash([5, 6])
  c.beginPath()
  c.moveTo(22, 108)
  c.lineTo(w - 22, 108)
  c.stroke()
  ;['ready', 'LED on', 'LED off', 'LED on', 'LED off', 'LED on'].forEach((l, i) =>
    text(c, l, 26, 148 + i * 34, 21, '#2f3832', 500, F.mono)
  )
  c.beginPath()
  c.moveTo(22, 368)
  c.lineTo(w - 22, 368)
  c.stroke()
  c.setLineDash([])
  c.strokeStyle = '#2f3832'
  c.lineWidth = 3
  c.beginPath()
  for (let i = 0; i < 6; i++) {
    const x = 26 + i * 38
    c.lineTo(x, i % 2 ? 440 : 400)
    c.lineTo(x + 38, i % 2 ? 440 : 400)
  }
  c.stroke()
  text(c, 'D13 · 1.00 Hz', 26, 478, 17, '#5f6a62', 500, F.mono)
  text(c, 'blink.ino  ✓', 26, 516, 19, '#2f3832', 650, F.sans)
}

/** The PCB silkscreen of the Uno at the Ship station. */
export function paintPcb(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#0c6f77'
  c.fillRect(0, 0, w, h)
  c.strokeStyle = '#0f838c'
  c.lineWidth = 3
  for (let i = 0; i < 14; i++) {
    c.beginPath()
    c.moveTo(150 + i * 22, 40)
    c.lineTo(150 + i * 22, 90 + (i % 4) * 12)
    c.lineTo(110 + i * 10, 150 + (i % 3) * 18)
    c.stroke()
  }
  c.strokeStyle = '#e6f3f1'
  c.lineWidth = 2
  c.strokeRect(6, 6, w - 12, h - 12)
  text(c, 'UNO', 300, 210, 54, '#e9f6f4', 800, F.sans)
  text(c, 'R3', 420, 210, 24, '#cfe9e6', 700, F.sans)
  text(c, 'DIGITAL (PWM ~)', 230, 70, 15, '#cfe9e6', 700, F.mono)
  text(c, 'POWER', 150, 330, 15, '#cfe9e6', 700, F.mono)
  text(c, 'ANALOG IN', 330, 330, 15, '#cfe9e6', 700, F.mono)
  text(c, 'L', 112, 92, 15, '#cfe9e6', 700, F.mono)
  text(c, 'TX', 112, 118, 13, '#cfe9e6', 700, F.mono)
  text(c, 'RX', 112, 140, 13, '#cfe9e6', 700, F.mono)
  text(c, 'ON', 424, 278, 13, '#cfe9e6', 700, F.mono)
}

// --- The cards that ride the belt: prompt → sketch → circuit → tests → board ----
export function paintPromptCard(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = UI.green
  c.fillRect(0, 0, w, h)
  text(c, 'PROMPT', 22, 46, 22, '#173b21', 700, F.mono)
  c.fillStyle = '#173b21'
  rr(c, 22, 72, w - 44, 168, 14)
  c.fill()
  ;['Blink pin 13', 'every 500 ms', 'and log it.'].forEach((l, i) =>
    text(c, l, 38, 116 + i * 38, 25, '#dff7e4', 550, F.sans)
  )
  text(c, 'YOU · STEP 01', 22, 322, 16, '#24572f', 700, F.mono)
}
export function paintSketchCard(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = UI.s1
  c.fillRect(0, 0, w, h)
  text(c, 'blink.ino', 22, 46, 22, UI.text, 600, F.sans)
  text(c, '17 lines', 22, 76, 15, UI.text4, 450, F.mono)
  const cols = [SYN.comment, SYN.keyword, SYN.def, SYN.def, SYN.string, SYN.keyword, SYN.def, SYN.number, SYN.def]
  cols.forEach((col, i) => {
    c.fillStyle = col
    c.fillRect(22 + (i % 3 ? 14 : 0), 104 + i * 21, 170 - (i % 4) * 26, 7)
  })
  check(c, 22, 306, 16, UI.green, 3)
  text(c, 'COMPILED', 48, 322, 17, UI.green, 700, F.mono)
}
export function paintCircuitCard(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#eceae2'
  c.fillRect(0, 0, w, h)
  text(c, 'CIRCUIT', 22, 46, 22, '#2b302d', 700, F.mono)
  c.strokeStyle = '#2b302d'
  c.lineWidth = 4
  c.lineJoin = 'round'
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(40, 120)
  c.lineTo(80, 120)
  for (let i = 0; i < 6; i++) c.lineTo(88 + i * 10, i % 2 ? 106 : 134)
  c.lineTo(150, 120)
  c.lineTo(178, 120)
  c.lineTo(178, 150)
  c.stroke()
  c.fillStyle = UI.green
  c.beginPath()
  c.moveTo(160, 150)
  c.lineTo(196, 150)
  c.lineTo(178, 182)
  c.closePath()
  c.fill()
  c.beginPath()
  c.moveTo(160, 184)
  c.lineTo(196, 184)
  c.moveTo(178, 184)
  c.lineTo(178, 230)
  c.lineTo(40, 230)
  c.lineTo(40, 120)
  c.stroke()
  text(c, 'D13', 30, 108, 15, '#5b625d', 600, F.mono)
  text(c, '220 Ω', 92, 162, 15, '#5b625d', 600, F.mono)
  check(c, 22, 306, 16, '#2e6b39', 3)
  text(c, 'CHECKED', 48, 322, 17, '#2e6b39', 700, F.mono)
}
export function paintTestsCard(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#10201a'
  c.fillRect(0, 0, w, h)
  text(c, 'TESTS', 22, 46, 22, '#a9c2b0', 700, F.mono)
  text(c, '3/3', 22, 140, 74, UI.green, 650, F.sans)
  text(c, 'passed', 24, 176, 21, '#a9c2b0', 500, F.sans)
  c.strokeStyle = UI.green
  c.lineWidth = 4
  c.beginPath()
  for (let i = 0; i < 5; i++) {
    const x = 22 + i * 42
    c.lineTo(x, i % 2 ? 266 : 222)
    c.lineTo(x + 42, i % 2 ? 266 : 222)
  }
  c.stroke()
  text(c, 'SIMULATED · 1 Hz', 22, 322, 15, '#6f8a78', 700, F.mono)
}
export function paintBoardCard(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#0c6f77'
  c.fillRect(0, 0, w, h)
  text(c, 'ON YOUR', 22, 46, 22, '#d9f0ed', 700, F.mono)
  text(c, 'BOARD', 22, 74, 22, '#d9f0ed', 700, F.mono)
  c.fillStyle = '#1a1c1f'
  rr(c, 46, 120, 164, 62, 6)
  c.fill()
  c.fillStyle = '#b8bec4'
  for (let i = 0; i < 9; i++) {
    c.fillRect(56 + i * 17, 110, 6, 10)
    c.fillRect(56 + i * 17, 182, 6, 10)
  }
  c.fillStyle = UI.warn
  c.fillRect(46, 226, 22, 12)
  text(c, 'L', 78, 238, 16, '#d9f0ed', 700, F.mono)
  text(c, 'Uno · 9600 baud', 22, 322, 16, '#bfe2de', 600, F.mono)
}
export function paintPostCard(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#10201a'
  c.fillRect(0, 0, w, h)
  text(c, 'HARDWARE TESTS', 16, 34, 15, '#a9c2b0', 700, F.mono)
  ;['serial "ready"', 'pin 13 toggles', 'pin 13 at 1 Hz'].forEach((name, i) => {
    check(c, 16, 58 + i * 40, 14, UI.green, 2.6)
    text(c, name, 40, 72 + i * 40, 14, '#d7e6da', 500, F.mono)
  })
  c.fillStyle = UI.greenDeep
  rr(c, 16, 200, w - 32, 66, 10)
  c.fill()
  text(c, '3/3 passed', 32, 244, 26, UI.green, 650, F.sans)
}
export function paintToken(c: C, w: number, h: number) {
  c.clearRect(0, 0, w, h)
  mark(c, 0, 0, w, '#123a1d', '#123a1d')
}
export function paintPrompt(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = UI.green
  c.fillRect(0, 0, w, h)
  c.fillStyle = '#173b21'
  c.beginPath()
  c.arc(56, 100, 32, 0, TAU)
  c.fill()
  c.textAlign = 'center'
  text(c, 'You', 56, 108, 21, UI.green, 650, F.sans)
  c.textAlign = 'left'
  text(c, 'Blink pin 13 every', 104, 88, 31, '#11291a', 600, F.sans)
  text(c, '500 ms, log it  ↵', 104, 130, 31, '#11291a', 600, F.sans)
  text(c, 'NEW PROMPT', 104, 174, 17, '#2b6a3a', 700, F.mono)
}
export function paintPlate(c: C, w: number, h: number, F: Fonts) {
  c.fillStyle = '#20242a'
  c.fillRect(0, 0, w, h)
  c.strokeStyle = '#454b53'
  c.lineWidth = 2
  c.strokeRect(2, 2, w - 4, h - 4)
  mark(c, 26, 16, 96, '#e3e4df')
  text(c, 'IMPULSE', 126, 79, 40, '#e3e4df', 700, F.sans)
  text(c, '·  ask  ·  write  ·  wire  ·  simulate  ·  ship', 330, 79, 33, '#b4bac0', 450, F.sans)
  text(c, 'AI ARDUINO IDE    /    FROM AN IDEA TO A WORKING BOARD', 47, 136, 19, '#6f7a84', 600, F.mono)
  text(c, 'v2.0', 1400, 132, 24, UI.green, 600, F.mono)
}
export function paintPlaque(c: C, w: number, h: number, step: number, name: string, F: Fonts) {
  c.fillStyle = '#13171c'
  c.fillRect(0, 0, w, h)
  text(c, String(step).padStart(2, '0'), 24, 76, 42, UI.green, 600, F.mono)
  text(c, name.toUpperCase(), 116, 73, 37, '#dadcda', 600, F.sans)
}
