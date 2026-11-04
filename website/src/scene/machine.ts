// The Impulse machine: one prompt rides a conveyor through five stations
// (Ask, Write, Wire, Simulate, Ship) on a metal plate. Four modes (Assembled,
// Cutaway, Stations, One prompt), five cameras, hover and click stations.
// Procedural three.js: no models, no images. The construction, the belt and
// the camera follow the Agentic Factory 3D component this page is modelled on;
// the stations, screens and cargo are Impulse's own workflow.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import * as P from './paint'

export type StationId = 'ask' | 'write' | 'wire' | 'simulate' | 'ship'
export type MachineMode = 'assembled' | 'cutaway' | 'stations' | 'order'
export type MachineCamera = 'overview' | 'side' | 'top' | 'station' | 'flight'
/** Where the machine sits in a narrow frame: below the hero copy, or above a step card. */
export type Framing = 'hero' | 'tour'

export type MachineApi = {
  setMode: (name: string) => boolean
  setCamera: (name: string) => boolean
  focusStation: (id: string) => boolean
  overview: () => boolean
  setFraming: (framing: Framing) => void
  play: () => boolean
  pause: () => boolean
}
export type MachineOptions = {
  /** In a page: panels hidden, the wheel and the finger scroll the page. */
  embedded: boolean
  fonts: P.Fonts
  onStation?: (id: StationId) => void
  onReady?: () => void
}

declare global {
  interface Window {
    __machine?: MachineApi
    __machineDebug?: { getState: () => Record<string, unknown> }
  }
}

type Vec3 = [number, number, number]
type StationDef = {
  id: StationId
  name: string
  step: number
  output: string
  pos: Vec3
  desc: string
  /** Camera target height above the station and distance, for the Station view. */
  focus: [number, number]
  /** Where the Station view looks from: each station's screen faces the camera. */
  view: Vec3
}

// Left to right along the belt; `step` is the station's place in the workflow.
const DEFINITIONS: StationDef[] = [
  {
    id: 'write',
    name: 'Write',
    step: 2,
    output: 'sketch',
    pos: [-4.15, 0.29, -0.65],
    desc: 'The agent writes the sketch and compiles it with arduino-cli.',
    focus: [1.45, 10.5],
    view: [7, 8.5, 17],
  },
  {
    id: 'wire',
    name: 'Wire',
    step: 3,
    output: 'circuit',
    pos: [-1.65, 0.29, -2.03],
    desc: 'Parts go on the breadboard, wires to the pins, then a circuit check.',
    focus: [1.0, 9.5],
    view: [6, 12, 14],
  },
  {
    id: 'simulate',
    name: 'Simulate',
    step: 4,
    output: 'tests',
    pos: [1.5, 0.29, -2.08],
    desc: 'The real firmware runs on an emulated board. The tests pass or fail.',
    focus: [1.8, 8.6],
    view: [2.5, 7.5, 17],
  },
  {
    id: 'ask',
    name: 'Ask',
    step: 1,
    output: 'prompt',
    pos: [4.03, 0.29, 0.12],
    desc: 'Say what you want in plain words. Claude, OpenAI or Gemini.',
    focus: [1.55, 10],
    view: [3, 7, 17],
  },
  {
    id: 'ship',
    name: 'Ship',
    step: 5,
    output: 'board',
    pos: [0.93, 0.29, 1.85],
    desc: 'Uploaded to your board once you approve. Serial starts talking.',
    focus: [1.0, 9.5],
    view: [5, 12, 14],
  },
]
const JOURNEY = [
  ['You ask', 'Ask · “Blink pin 13 every 500 ms and log it”'],
  ['Writing the sketch', 'Write · the agent writes it, then compiles it'],
  ['Wiring the circuit', 'Wire · LED and 220 Ω on pin 13, circuit checked'],
  ['Simulating it', 'Simulate · the firmware runs, 3 of 3 tests pass'],
  ['On your board', 'Ship · uploaded to the Uno, Serial says “ready”'],
]

export function initMachineScene(root: HTMLElement, options: MachineOptions): () => void {
  const cleanups: Array<() => void> = []
  const F = options.fonts
  const frameWidth = () => root.clientWidth
  const frameHeight = () => root.clientHeight
  const listen = (target: EventTarget, type: string, handler: (event: never) => void) => {
    const fn = handler as unknown as EventListener
    target.addEventListener(type, fn)
    cleanups.push(() => target.removeEventListener(type, fn))
  }
  function $<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = root.querySelector<T>(`#${id}`)
    if (!el) throw new Error(`Machine markup is missing #${id}`)
    return el
  }
  function showError(message?: string) {
    $('loading').classList.add('done')
    $('error').style.display = 'block'
    if (message) $('error').querySelector('p')!.textContent = message
  }
  const dispose = () => {
    for (const fn of cleanups.reverse()) fn()
    cleanups.length = 0
  }
  try {
    const TAU = Math.PI * 2
    const GREEN = 0x71d083
    const embedded = options.embedded
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    const coarse = matchMedia('(pointer: coarse)').matches
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(33, frameWidth() / Math.max(1, frameHeight()), 0.1, 150)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch (e) {
      showError('WebGL is not available. Turn on hardware acceleration in your browser settings and reload the page.')
      throw e
    }
    renderer.setClearColor(0x000000, 0)
    // Full device resolution: the screens carry small text. Slow devices step down on their own (below).
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setSize(frameWidth(), frameHeight())
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.localClippingEnabled = true
    $('scene').appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.065
    controls.enablePan = false
    controls.minDistance = 7
    controls.maxDistance = 55
    controls.minPolarAngle = 0.09
    controls.maxPolarAngle = Math.PI * 0.475
    controls.rotateSpeed = 0.48
    controls.zoomSpeed = 0.7
    // In the page the wheel scrolls the page; on touch screens the finger does too.
    if (embedded) {
      controls.enableZoom = false
      if (coarse) {
        controls.enabled = false
        renderer.domElement.style.touchAction = 'pan-y'
      }
    }
    const pmrem = new THREE.PMREMGenerator(renderer),
      room = new RoomEnvironment()
    const env = pmrem.fromScene(room, 0.04)
    scene.environment = env.texture
    scene.environmentIntensity = 0.6
    room.dispose()
    pmrem.dispose()
    scene.add(new THREE.HemisphereLight(0xdbe5f4, 0x1f241f, 2))
    const key = new THREE.DirectionalLight(0xfff4e2, 4.2)
    key.position.set(-4, 12, 7)
    key.castShadow = true
    const shadowSize = frameWidth() < 900 ? 1024 : 2048
    key.shadow.mapSize.set(shadowSize, shadowSize)
    Object.assign(key.shadow.camera, { left: -10, right: 10, top: 9, bottom: -9, near: 0.5, far: 35 })
    key.shadow.normalBias = 0.035
    key.shadow.bias = -0.0002
    key.shadow.radius = 4
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xc4d4ed, 3.1)
    rim.position.set(3, 7, -8)
    scene.add(rim)
    const warm = new THREE.PointLight(0xffd29a, 22, 20, 2)
    warm.position.set(-4, 5, 3)
    scene.add(warm)
    const front = new THREE.DirectionalLight(0xffffff, 1)
    front.position.set(5, 3, 10)
    scene.add(front)

    const mat = (color: number, metalness = 0.1, roughness = 0.4, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra })
    const glow = (color: number, intensity: number) =>
      mat(color, 0.2, 0.25, { emissive: color, emissiveIntensity: intensity })
    const M = {
      body: mat(0x2c3138, 0.75, 0.3),
      base: mat(0x262b32, 0.85, 0.32),
      edge: mat(0x6c7581, 0.85, 0.24),
      chrome: mat(0xc3cad0, 0.92, 0.18),
      dark: mat(0x12161b, 0.45, 0.38),
      rubber: mat(0x0b1015, 0.1, 0.6),
      accent: mat(0x5aae6e, 0.45, 0.32),
      ivory: mat(0xe0ded6, 0.45, 0.28),
      copper: mat(0xc57e45, 0.85, 0.3),
      light: glow(GREEN, 1.5),
      status: mat(0xc9ecd0, 0.1, 0.3, { emissive: GREEN, emissiveIntensity: 0.9 }),
      pcb: mat(0x0c6f77, 0.25, 0.5),
      chip: mat(0x16181b, 0.3, 0.45),
      resistor: mat(0xd8c7a0, 0.1, 0.55),
      band1: mat(0x6b4122, 0.1, 0.5),
      band2: mat(0xa23a2b, 0.1, 0.5),
      wireRed: mat(0xc84a3e, 0.15, 0.45),
      wireBlack: mat(0x1b1e22, 0.15, 0.45),
      wireGreen: mat(0x4fa564, 0.15, 0.45),
      wireYellow: mat(0xd6b34a, 0.15, 0.45),
      // The parts that blink with the sketch get their own materials.
      ledGreen: glow(GREEN, 0.1),
      ledL: glow(0xffb547, 0.1),
      ledOn: glow(0x8be39b, 1.3),
      ledTx: glow(0xffd36b, 0.1),
    }
    const geometries = new Map<string, THREE.BufferGeometry>()
    function boxGeo(w: number, h: number, d: number, r = 0.04) {
      const k = `b${w},${h},${d},${r}`
      if (!geometries.has(k))
        geometries.set(
          k,
          r ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 3, h / 3, d / 3)) : new THREE.BoxGeometry(w, h, d)
        )
      return geometries.get(k)!
    }
    function box(
      parent: THREE.Object3D,
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      m: THREE.Material = M.body,
      r = 0.04
    ) {
      const o = new THREE.Mesh(boxGeo(w, h, d, r), m)
      o.position.set(x, y, z)
      o.castShadow = true
      o.receiveShadow = true
      parent.add(o)
      return o
    }
    function cyl(
      parent: THREE.Object3D,
      r: number,
      h: number,
      x: number,
      y: number,
      z: number,
      m: THREE.Material = M.chrome,
      r2: number = r,
      segments = 24
    ) {
      const k = `c${r},${r2},${h},${segments}`
      if (!geometries.has(k)) geometries.set(k, new THREE.CylinderGeometry(r, r2, h, segments))
      const o = new THREE.Mesh(geometries.get(k)!, m)
      o.position.set(x, y, z)
      o.castShadow = true
      o.receiveShadow = true
      parent.add(o)
      return o
    }
    function ball(parent: THREE.Object3D, r: number, x: number, y: number, z: number, m: THREE.Material = M.chrome) {
      const k = `s${r}`
      if (!geometries.has(k)) geometries.set(k, new THREE.SphereGeometry(r, 16, 10))
      const o = new THREE.Mesh(geometries.get(k)!, m)
      o.position.set(x, y, z)
      parent.add(o)
      return o
    }
    function tube(parent: THREE.Object3D, pts: Vec3[], r: number, m: THREE.Material = M.chrome) {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)))
      const o = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(12, pts.length * 7), r, 8, false), m)
      o.castShadow = true
      parent.add(o)
      return o
    }
    function screw(parent: THREE.Object3D, x: number, y: number, z: number) {
      cyl(parent, 0.055, 0.026, x, y, z, M.chrome, undefined, 12)
      box(parent, 0.068, 0.005, 0.009, x, y + 0.014, z, M.dark, 0)
    }
    type Painted = { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
    // Screens are painted above their nominal size, so text stays sharp in the
    // close-ups on high-density displays; painters keep drawing in nominal units.
    const TEXTURE_SCALE = Math.min(devicePixelRatio, 2) >= 1.5 ? 2 : 1.5
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy()
    function canvasTexture(
      w: number,
      h: number,
      draw?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
      scale = TEXTURE_SCALE
    ) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale)
      canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')!
      ctx.scale(scale, scale)
      draw?.(ctx, w, h)
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = maxAnisotropy
      return { texture, canvas, ctx } as Painted
    }
    function screen(parent: THREE.Object3D, w: number, h: number, x: number, y: number, z: number, tex: Painted) {
      const o = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex.texture, toneMapped: false })
      )
      o.position.set(x, y, z)
      parent.add(o)
      return o
    }

    const machine = new THREE.Group()
    scene.add(machine)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.ShadowMaterial({ opacity: 0.25 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.43
    floor.receiveShadow = true
    scene.add(floor)
    const shadow = canvasTexture(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(64, 64, 12, 64, 64, 64)
      g.addColorStop(0, 'rgba(0,0,0,.8)')
      g.addColorStop(0.55, 'rgba(0,0,0,.45)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = g
      c.fillRect(0, 0, w, h)
    })
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 13),
      new THREE.MeshBasicMaterial({ map: shadow.texture, transparent: true, depthWrite: false, opacity: 0.65 })
    )
    contact.rotation.x = -Math.PI / 2
    contact.position.y = -0.415
    scene.add(contact)

    // A chamfered, layered platform with an engraved nameplate and captive screws.
    box(machine, 12.8, 0.38, 8.25, 0, -0.09, 0, M.base, 0.17)
    box(machine, 12.6, 0.055, 8.08, 0, 0.13, 0, M.edge, 0.11)
    box(machine, 12.49, 0.09, 7.96, 0, 0.19, 0, M.body, 0.1)
    box(machine, 12.55, 0.027, 8.02, 0, -0.19, 0, M.dark, 0.06)
    box(machine, 11.9, 0.026, 0.032, 0, -0.17, 4.115, M.light, 0.01)
    for (const x of [-5.6, 5.6])
      for (const z of [-3.35, 3.35]) {
        cyl(machine, 0.39, 0.25, x, -0.31, z, M.rubber)
        cyl(machine, 0.29, 0.09, x, -0.4, z, M.dark)
        screw(machine, x, 0.253, z)
      }
    for (const x of [-6.02, 6.02]) for (const z of [-3.73, 3.73]) screw(machine, x, 0.255, z)
    const plateTex = canvasTexture(1536, 176, (c, w, h) => P.paintPlate(c, w, h, F))
    const plate = screen(machine, 7.35, 0.84, -0.4, 0.25, 3.51, plateTex)
    plate.rotation.x = -Math.PI / 2
    for (let i = 0; i < 16; i++)
      box(machine, 0.015, 0.009, 0.11 + (i % 4) * 0.035, -5.6 + i * 0.09, 0.249, 3.5, M.edge, 0)
    // Faint drafting rings around the machine.
    const drafting = new THREE.Group()
    scene.add(drafting)
    const draftingPoints: THREE.Vector3[] = []
    for (const r of [7.5, 8.1])
      for (let i = 0; i < 120; i++)
        for (const j of [i, i + 1]) {
          const a = (j / 120) * TAU
          draftingPoints.push(new THREE.Vector3(Math.cos(a) * r, -0.4, Math.sin(a) * r * 0.72))
        }
    for (let i = 0; i < 52; i++) {
      const a = (i / 52) * TAU,
        r = 8.1,
        tick = r + (i % 4 === 0 ? 0.16 : 0.07)
      draftingPoints.push(
        new THREE.Vector3(Math.cos(a) * r, -0.395, Math.sin(a) * r * 0.72),
        new THREE.Vector3(Math.cos(a) * tick, -0.395, Math.sin(a) * tick * 0.72)
      )
    }
    drafting.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(draftingPoints),
        new THREE.LineBasicMaterial({ color: 0x69717a, transparent: true, opacity: 0.12 })
      )
    )

    // ---- Stations ---------------------------------------------------------
    type Station = StationDef & {
      group: THREE.Group
      base: THREE.Vector3
      glowMat: THREE.MeshStandardMaterial
      label: HTMLDivElement
      index: number
      anchor: THREE.Vector3
    }
    const stations: Station[] = []
    const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 10)
    function shell<T extends THREE.Material>(m: T): T {
      const s = m.clone() as T
      s.clippingPlanes = [cutPlane]
      s.clipShadows = true
      s.side = THREE.DoubleSide
      return s
    }
    const S = { body: shell(M.body), ivory: shell(M.ivory), accent: shell(M.accent) }
    const gears: THREE.Group[] = []
    function gear(parent: THREE.Object3D, x: number, y: number, z: number, r = 0.3) {
      const g = new THREE.Group()
      g.position.set(x, y, z)
      parent.add(g)
      cyl(g, r, 0.09, 0, 0, 0, M.copper)
      cyl(g, r * 0.66, 0.105, 0, 0, 0, M.dark)
      cyl(g, r * 0.22, 0.14, 0, 0, 0, M.chrome)
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU
        box(g, r * 0.26, 0.085, r * 0.2, Math.cos(a) * r, 0, Math.sin(a) * r, M.copper, 0.008).rotation.y = -a
      }
      g.userData.moving = true
      gears.push(g)
      return g
    }
    DEFINITIONS.forEach((d, i) => {
      const group = new THREE.Group()
      group.position.fromArray(d.pos)
      machine.add(group)
      const glowMat = M.light.clone()
      glowMat.emissiveIntensity = 0.5
      box(group, 2.05, 0.12, 1.78, 0, 0.03, 0, M.dark, 0.1)
      box(group, 1.97, 0.03, 1.7, 0, 0.12, 0, glowMat, 0.09)
      box(group, 2.03, 0.17, 1.75, 0, 0.215, 0, M.body, 0.1)
      for (const x of [-0.85, 0.85]) for (const z of [-0.7, 0.7]) screw(group, x, 0.311, z)
      // The mechanics inside show when the shells are cut at deck height.
      gear(group, -0.35, 0.45, 0, 0.27)
      gear(group, 0.22, 0.45, 0.12, 0.21)
      box(group, 0.6, 0.15, 0.36, 0.52, 0.47, -0.33, M.dark)
      for (let j = 0; j < 6; j++) box(group, 0.025, 0.16, 0.37, 0.3 + j * 0.08, 0.47, -0.33, M.edge, 0.004)
      tube(
        group,
        [
          [-0.7, 0.4, -0.4],
          [-0.55, 0.48, 0.4],
          [0.35, 0.45, 0.6],
          [0.7, 0.58, 0.23],
        ],
        0.023,
        M.light
      )
      const plaque = canvasTexture(512, 116, (c, w, h) => P.paintPlaque(c, w, h, d.step, d.name, F))
      screen(group, 1.54, 0.345, 0, 0.27, 0.891, plaque)
      const number = String(d.step).padStart(2, '0')
      const label = document.createElement('div')
      label.className = 'station-label'
      label.innerHTML = `<div class="stem"></div><div class="label-card"><div class="label-title"><span>${number}</span>${d.name}</div><div class="label-meta">Step ${d.step} · ${d.output}</div></div>`
      $('labels').appendChild(label)
      cleanups.push(() => label.remove())
      stations.push({
        ...d,
        group,
        base: new THREE.Vector3(...d.pos),
        glowMat,
        label,
        index: i,
        anchor: new THREE.Vector3(0, 2.5, 0),
      })
    })
    const byId = (id: StationId) => stations.find((s) => s.id === id)!

    // 01 Ask: the chat terminal with a keyboard, and the orb above it.
    const ask = byId('ask').group
    box(ask, 1.75, 1.77, 1.02, 0, 1.24, -0.13, S.body, 0.12)
    box(ask, 1.58, 0.13, 1.09, 0, 2.16, -0.13, S.accent, 0.04)
    box(ask, 1.47, 1.38, 0.055, 0, 1.31, 0.405, M.dark, 0.025)
    const chatTex = canvasTexture(480, 460, undefined, TEXTURE_SCALE * 1.25)
    screen(ask, 1.31, 1.255, 0, 1.37, 0.44, chatTex)
    box(ask, 1.27, 0.075, 0.29, 0, 0.57, 0.55, M.chrome, 0.02)
    for (let row = 0; row < 3; row++)
      for (let k = 0; k < 11; k++)
        box(ask, 0.085, 0.032, 0.07, -0.55 + k * 0.11, 0.62, 0.465 + row * 0.085, row === 2 && k > 3 && k < 8 ? M.dark : M.ivory, 0.012)
    for (let i = 0; i < 3; i++) box(ask, 1.15, 0.021, 0.12, 0, 0.58 + i * 0.15, -0.66, M.copper, 0.006)
    tube(
      ask,
      [
        [0.69, 0.43, -0.2],
        [0.89, 0.65, -0.2],
        [0.89, 1.8, -0.2],
        [0.65, 1.99, -0.2],
      ],
      0.033,
      M.chrome
    )
    // The MorphOrb from the chat: dots on a sphere, a ring, a green core.
    const orb = new THREE.Group()
    orb.position.set(0, 2.86, -0.13)
    orb.userData.moving = true
    ask.add(orb)
    const orbPositions: number[] = []
    const ORB_N = 460
    for (let i = 0; i < ORB_N; i++) {
      const y = 1 - (i / (ORB_N - 1)) * 2,
        r = Math.sqrt(1 - y * y),
        a = i * 2.39996
      orbPositions.push(Math.cos(a) * r * 0.36, y * 0.36, Math.sin(a) * r * 0.36)
    }
    const orbGeo = new THREE.BufferGeometry()
    orbGeo.setAttribute('position', new THREE.Float32BufferAttribute(orbPositions, 3))
    const dot = canvasTexture(64, 64, (c) => {
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.45, 'rgba(255,255,255,.9)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      c.fillStyle = g
      c.fillRect(0, 0, 64, 64)
    })
    const orbMat = new THREE.PointsMaterial({
      size: 0.055,
      map: dot.texture,
      color: 0xe6f6ea,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    const ORB_REST = new THREE.Color(0xe6f6ea),
      ORB_DONE = new THREE.Color(0x8fe3a2)
    const orbPoints = new THREE.Points(orbGeo, orbMat)
    orb.add(orbPoints)
    const orbCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 24, 16),
      new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.32, toneMapped: false, depthWrite: false })
    )
    orb.add(orbCore)
    const orbRing = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.007, 6, 120), M.light)
    orbRing.rotation.x = Math.PI / 2.4
    orb.add(orbRing)
    const orbLight = new THREE.PointLight(GREEN, 4, 3.5, 2)
    orb.add(orbLight)
    // The prompt drops in from above.
    const incoming = new THREE.Group()
    incoming.userData.moving = true
    ask.add(incoming)
    box(incoming, 0.86, 0.42, 0.043, 0, 0, 0, M.light, 0.035)
    screen(incoming, 0.82, 0.39, 0, 0, 0.026, canvasTexture(432, 204, (c, w, h) => P.paintPrompt(c, w, h, F)))

    // 02 Write: a gantry that writes the sketch onto a panel, tape reels, a compiler readout.
    const write = byId('write').group
    box(write, 1.74, 0.62, 1.33, 0, 0.65, -0.05, S.ivory, 0.13)
    box(write, 1.5, 0.1, 1.16, 0, 0.99, -0.04, S.body, 0.025)
    for (const x of [-0.68, 0.68]) {
      cyl(write, 0.065, 1.73, x, 1.35, -0.18, M.chrome)
      box(write, 0.22, 1.8, 0.22, x, 1.37, -0.44, S.ivory, 0.035)
    }
    box(write, 1.82, 0.27, 0.4, 0, 2.28, -0.35, S.accent, 0.045)
    box(write, 1.55, 0.06, 0.06, 0, 2.13, -0.115, M.chrome, 0.01)
    const printhead = new THREE.Group()
    write.add(printhead)
    printhead.position.set(0, 1.9, -0.08)
    printhead.userData.moving = true
    box(printhead, 0.45, 0.36, 0.44, 0, 0, 0, M.body, 0.05)
    cyl(printhead, 0.11, 0.13, 0, -0.24, 0.03, M.chrome, 0.04)
    box(printhead, 0.24, 0.045, 0.022, 0, 0.09, 0.23, M.light, 0.01)
    tube(
      write,
      [
        [-0.68, 2.1, -0.35],
        [-0.42, 2.52, -0.4],
        [0.25, 2.5, -0.4],
        [0.35, 2.01, -0.12],
      ],
      0.032,
      M.dark
    )
    const reels: THREE.Group[] = []
    for (const [x, y] of [
      [-1.03, 1.82],
      [-0.94, 2.78],
    ]) {
      const reel = new THREE.Group()
      reel.position.set(x, y, -0.48)
      write.add(reel)
      reel.userData.moving = true
      cyl(reel, 0.4, 0.22, 0, 0, 0, M.dark).rotation.x = Math.PI / 2
      for (const z of [-0.14, 0.14]) {
        cyl(reel, 0.46, 0.045, 0, 0, z, M.chrome).rotation.x = Math.PI / 2
        for (let j = 0; j < 6; j++) {
          const a = (j / 6) * TAU
          cyl(reel, 0.1, 0.006, Math.cos(a) * 0.29, Math.sin(a) * 0.29, z + (z > 0 ? 0.026 : -0.026), M.dark, undefined, 14).rotation.x =
            Math.PI / 2
        }
      }
      cyl(reel, 0.095, 0.37, 0, 0, 0, M.accent).rotation.x = Math.PI / 2
      reels.push(reel)
    }
    tube(
      write,
      [
        [-1.36, 2.66, -0.48],
        [-1.5, 2.34, -0.48],
        [-1.34, 1.92, -0.48],
      ],
      0.045,
      M.dark
    )
    const codeTex = canvasTexture(384, 640)
    const codePanel = new THREE.Group()
    codePanel.userData.moving = true
    write.add(codePanel)
    box(codePanel, 0.62, 1.08, 0.055, 0, 1.36, 0.61, M.dark, 0.035)
    screen(codePanel, 0.56, 0.98, 0, 1.36, 0.641, codeTex)
    box(write, 1.14, 0.12, 0.2, 0, 0.83, 0.66, M.dark, 0.025)
    for (const x of [-0.42, 0.42]) cyl(write, 0.115, 0.18, x, 0.92, 0.6, M.chrome).rotation.z = Math.PI / 2
    for (let i = 0; i < 5; i++) box(write, 0.08, 0.03, 0.22, -0.38 + i * 0.19, 1.011, -0.02, M.edge, 0.005)

    // 03 Wire: a breadboard on a tilted console, parts, jumper wires and a pick-and-place arm.
    const wire = byId('wire').group
    box(wire, 1.9, 0.66, 1.36, 0, 0.67, -0.04, S.body, 0.11)
    const consoleTop = new THREE.Group()
    consoleTop.position.set(0, 1.01, -0.08)
    consoleTop.rotation.x = -0.32
    wire.add(consoleTop)
    box(consoleTop, 1.76, 0.12, 1.27, 0, 0, 0, S.ivory, 0.04)
    const breadboard = screen(
      consoleTop,
      1.53,
      0.79,
      0,
      0.067,
      -0.17,
      canvasTexture(640, 340, (c, w, h) => P.paintBreadboard(c, w, h, F))
    )
    breadboard.rotation.x = -Math.PI / 2
    // The LED (it blinks with the simulation), a 220 Ω resistor, a push button.
    cyl(consoleTop, 0.05, 0.03, -0.14, 0.085, -0.3, M.ledGreen)
    cyl(consoleTop, 0.045, 0.09, -0.14, 0.14, -0.3, M.ledGreen)
    ball(consoleTop, 0.045, -0.14, 0.185, -0.3, M.ledGreen)
    const resistor = cyl(consoleTop, 0.028, 0.2, 0.12, 0.1, -0.3, M.resistor)
    resistor.rotation.z = Math.PI / 2
    for (const [dx, m] of [
      [-0.05, M.band1],
      [-0.015, M.band1],
      [0.02, M.band2],
    ] as const)
      cyl(consoleTop, 0.031, 0.014, 0.12 + dx, 0.1, -0.3, m).rotation.z = Math.PI / 2
    tube(
      consoleTop,
      [
        [0.02, 0.07, -0.3],
        [0.0, 0.1, -0.3],
        [-0.1, 0.1, -0.3],
      ],
      0.006,
      M.chrome
    )
    box(consoleTop, 0.15, 0.045, 0.15, 0.48, 0.09, -0.04, M.dark, 0.012)
    cyl(consoleTop, 0.045, 0.04, 0.48, 0.13, -0.04, M.wireRed)
    // Jumpers: 5 V and GND to the rails, pin 13 and the button off to the board.
    tube(consoleTop, [[0.3, 0.07, -0.3], [0.38, 0.2, -0.42], [0.5, 0.2, -0.5], [0.58, 0.07, -0.52]], 0.014, M.wireRed)
    tube(consoleTop, [[-0.14, 0.07, -0.2], [-0.22, 0.18, -0.06], [-0.38, 0.18, 0.06], [-0.44, 0.07, 0.15]], 0.014, M.wireBlack)
    tube(consoleTop, [[-0.3, 0.07, -0.3], [-0.42, 0.26, -0.46], [-0.56, 0.24, -0.66], [-0.6, 0.0, -0.7]], 0.014, M.wireGreen)
    tube(consoleTop, [[0.48, 0.07, 0.06], [0.6, 0.22, 0.12], [0.78, 0.2, 0.0], [0.86, 0.0, -0.1]], 0.014, M.wireYellow)
    const toggles: THREE.Mesh[] = []
    for (let i = 0; i < 4; i++) {
      const x = -0.57 + i * 0.38
      cyl(consoleTop, 0.074, 0.035, x, 0.1, 0.45, M.dark)
      const t = cyl(consoleTop, 0.025, 0.15, x, 0.19, 0.45, M.chrome)
      t.rotation.x = -0.4
      t.userData.moving = true
      toggles.push(t)
      ball(consoleTop, 0.04, x, 0.275, 0.421, M.ivory)
    }
    // A small arm turns over the board and sets parts down.
    cyl(consoleTop, 0.06, 0.06, 0.74, 0.09, -0.56, M.dark)
    cyl(consoleTop, 0.04, 0.5, 0.74, 0.34, -0.56, M.chrome)
    const arm = new THREE.Group()
    arm.position.set(0.74, 0.6, -0.56)
    arm.userData.moving = true
    consoleTop.add(arm)
    cyl(arm, 0.07, 0.08, 0, 0, 0, M.accent)
    box(arm, 0.66, 0.06, 0.08, -0.33, 0.02, 0, M.ivory, 0.02)
    const nozzle = new THREE.Group()
    nozzle.position.set(-0.64, -0.06, 0)
    nozzle.userData.moving = true
    arm.add(nozzle)
    cyl(nozzle, 0.05, 0.12, 0, 0, 0, M.body)
    cyl(nozzle, 0.016, 0.12, 0, -0.11, 0, M.chrome)
    box(nozzle, 0.06, 0.02, 0.02, 0, 0.07, 0.05, M.light, 0.005)
    cyl(wire, 0.075, 0.06, 0.77, 1.05, -0.62, M.status)
    const checkScreen = canvasTexture(512, 160, (c, w, h) => P.paintCheck(c, w, h, F))
    box(wire, 1.0, 0.34, 0.03, 0, 0.62, 0.64, M.dark, 0.01)
    screen(wire, 0.94, 0.29, 0, 0.62, 0.657, checkScreen)

    // 04 Simulate: the simulator on a large monitor, and a test report beside it.
    const simulate = byId('simulate').group
    box(simulate, 1.35, 0.18, 0.88, 0, 0.44, 0, S.ivory, 0.045)
    cyl(simulate, 0.095, 1.04, 0, 0.93, -0.31, M.chrome)
    box(simulate, 0.56, 0.91, 0.14, 0, 0.99, -0.34, S.body, 0.04)
    box(simulate, 2.42, 1.72, 0.2, 0, 1.94, -0.17, S.ivory, 0.08)
    box(simulate, 2.28, 1.59, 0.1, 0, 1.94, -0.044, M.dark, 0.045)
    const simTex = canvasTexture(896, 592)
    screen(simulate, 2.16, 1.43, 0, 1.95, 0.011, simTex)
    ball(simulate, 0.024, 0, 2.747, -0.05, M.dark)
    box(simulate, 0.21, 0.019, 0.008, 0, 1.149, 0.013, M.light, 0.003)
    const report = new THREE.Group()
    report.userData.moving = true
    simulate.add(report)
    box(report, 0.59, 0.77, 0.045, 0.94, 0.81, 0.55, M.dark, 0.025)
    screen(report, 0.55, 0.72, 0.94, 0.81, 0.575, canvasTexture(220, 290, (c, w, h) => P.paintPostCard(c, w, h, F)))

    // 05 Ship: an Uno on a USB cable, the upload screen, and Serial printing on paper.
    const ship = byId('ship').group
    box(ship, 1.91, 0.63, 1.32, 0, 0.65, -0.06, S.ivory, 0.12)
    box(ship, 1.96, 0.19, 1.38, 0, 0.42, -0.04, S.body, 0.04)
    box(ship, 1.37, 0.09, 0.038, 0, 0.44, 0.66, M.dark, 0.01)
    box(ship, 0.37, 0.042, 0.03, 0, 0.45, 0.687, M.chrome, 0.009)
    box(ship, 1.02, 0.2, 0.91, -0.33, 1.06, -0.03, S.body, 0.045)
    // The Uno, 0.96 × 0.72 on the plinth (the PCB's top is at y 1.198).
    box(ship, 0.96, 0.035, 0.72, -0.33, 1.18, -0.03, M.pcb, 0.012)
    const pcb = screen(ship, 0.94, 0.7, -0.33, 1.199, -0.03, canvasTexture(512, 384, (c, w, h) => P.paintPcb(c, w, h, F)))
    pcb.rotation.x = -Math.PI / 2
    box(ship, 0.3, 0.08, 0.055, -0.47, 1.24, -0.355, M.dark, 0.006)
    box(ship, 0.36, 0.08, 0.055, -0.08, 1.24, -0.355, M.dark, 0.006)
    box(ship, 0.28, 0.08, 0.055, -0.39, 1.24, 0.295, M.dark, 0.006)
    box(ship, 0.24, 0.08, 0.055, -0.07, 1.24, 0.295, M.dark, 0.006)
    box(ship, 0.46, 0.05, 0.13, -0.12, 1.225, 0.1, M.chip, 0.008)
    for (let i = 0; i < 14; i++)
      for (const z of [0.025, 0.175]) box(ship, 0.016, 0.03, 0.03, -0.33 + i * 0.032, 1.212, z, M.chrome, 0)
    box(ship, 0.09, 0.02, 0.09, -0.56, 1.21, -0.17, M.chip, 0.006)
    box(ship, 0.2, 0.15, 0.19, -0.77, 1.27, -0.19, M.chrome, 0.012)
    box(ship, 0.19, 0.14, 0.17, -0.76, 1.265, 0.18, M.dark, 0.02)
    box(ship, 0.1, 0.035, 0.04, -0.43, 1.215, -0.03, M.chrome, 0.012)
    for (const z of [0.0, 0.08]) cyl(ship, 0.035, 0.09, -0.61, 1.24, z, M.chrome)
    box(ship, 0.06, 0.03, 0.06, -0.73, 1.215, -0.36, M.chrome, 0.006)
    box(ship, 0.04, 0.02, 0.025, -0.6, 1.207, -0.22, M.ledL, 0.004)
    box(ship, 0.04, 0.02, 0.025, -0.6, 1.207, -0.17, M.ledTx, 0.004)
    box(ship, 0.04, 0.02, 0.025, -0.6, 1.207, -0.13, M.ledTx, 0.004)
    box(ship, 0.04, 0.02, 0.025, -0.0, 1.207, 0.21, M.ledOn, 0.004)
    tube(
      ship,
      [
        [-0.87, 1.27, -0.19],
        [-1.04, 1.24, -0.22],
        [-1.08, 1.06, -0.44],
        [-0.86, 1.12, -0.62],
        [-0.5, 1.32, -0.6],
        [-0.4, 1.34, -0.57],
      ],
      0.034,
      M.wireBlack
    )
    box(ship, 0.64, 0.6, 0.52, 0.58, 1.04, -0.15, S.body, 0.045)
    box(ship, 0.48, 0.07, 0.09, 0.59, 1.37, -0.1, M.dark, 0.01)
    cyl(ship, 0.06, 0.65, -0.35, 1.6, -0.56, M.chrome)
    box(ship, 1.13, 0.46, 0.19, -0.35, 1.98, -0.56, S.body, 0.045)
    const uploadTex = canvasTexture(512, 176)
    screen(ship, 1.015, 0.349, -0.35, 1.98, -0.459, uploadTex)
    const tape = new THREE.Group()
    tape.position.set(0.59, 1.37, -0.1)
    tape.userData.moving = true
    ship.add(tape)
    const tapeFace = screen(tape, 0.41, 0.83, 0, 0.415, 0.01, canvasTexture(280, 540, (c, w, h) => P.paintTape(c, w, h, F)))
    ;(tapeFace.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide
    tape.rotation.x = -0.16
    const token = new THREE.Group()
    token.userData.moving = true
    ship.add(token)
    cyl(token, 0.22, 0.065, 0, 0, 0, M.accent, undefined, 32).rotation.x = Math.PI / 2
    const tokenRing = new THREE.Mesh(new THREE.TorusGeometry(0.174, 0.014, 6, 32), M.light)
    tokenRing.position.z = 0.037
    token.add(tokenRing)
    const tokenFace = screen(token, 0.26, 0.26, 0, 0, 0.04, canvasTexture(128, 128, (c, w, h) => P.paintToken(c, w, h)))
    ;(tokenFace.material as THREE.MeshBasicMaterial).transparent = true
    cyl(ship, 0.33, 0.09, 1.04, 0.39, 0.55, M.dark)
    cyl(ship, 0.26, 0.025, 1.04, 0.445, 0.55, M.copper)

    // ---- Conveyor: a closed spline, instanced slats, rails, cargo locked to the belt ----
    const path = new THREE.CatmullRomCurve3(
      (
        [
          [-3.95, 0.84, 0.65],
          [-3.1, 0.84, -0.12],
          [-1.45, 0.84, -0.79],
          [1.32, 0.84, -0.8],
          [3.3, 0.84, 0.19],
          [3.43, 0.84, 1.21],
          [1.35, 0.84, 2.7],
          [-1.4, 0.84, 2.52],
          [-3.54, 0.84, 1.65],
        ] as Vec3[]
      ).map((p) => new THREE.Vector3(...p)),
      true,
      'catmullrom',
      0.25
    )
    const belt = new THREE.Group()
    machine.add(belt)
    const frameMesh = new THREE.Mesh(new THREE.TubeGeometry(path, 150, 0.35, 8, true), M.dark)
    frameMesh.scale.y = 0.3
    frameMesh.position.y = 0.51
    belt.add(frameMesh)
    const beltCount = 148
    const beltSlats = new THREE.InstancedMesh(boxGeo(0.135, 0.065, 0.63, 0.012), M.body, beltCount)
    beltSlats.receiveShadow = true
    belt.add(beltSlats)
    beltSlats.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const dummy = new THREE.Object3D(),
      pVec = new THREE.Vector3(),
      tVec = new THREE.Vector3()
    function updateBelt(t: number) {
      for (let i = 0; i < beltCount; i++) {
        const u = (i / beltCount + t * 0.012) % 1
        path.getPointAt(u, pVec)
        path.getTangentAt(u, tVec)
        dummy.position.copy(pVec)
        dummy.rotation.set(0, -Math.atan2(tVec.z, tVec.x), 0)
        dummy.updateMatrix()
        beltSlats.setMatrixAt(i, dummy.matrix)
      }
      beltSlats.instanceMatrix.needsUpdate = true
    }
    updateBelt(0)
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 160; i++) {
        path.getPointAt(i / 160, pVec)
        path.getTangentAt(i / 160, tVec)
        pts.push(pVec.clone().add(new THREE.Vector3(-tVec.z * 0.36 * side, 0.09, tVec.x * 0.36 * side)))
      }
      belt.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.028, 6, false), M.chrome))
    }
    for (let i = 0; i < 16; i++) {
      const p = path.getPointAt(i / 16)
      cyl(belt, 0.045, 0.43, p.x, 0.53, p.z, M.chrome)
    }
    // Copper lines link the station footings.
    const pipes = new THREE.Group()
    machine.add(pipes)
    for (let i = 0; i < 4; i++) {
      const a = stations[i].base,
        b = stations[i + 1].base
      const curve = new THREE.CatmullRomCurve3([
        a.clone().add(new THREE.Vector3(0.4, 0.12, 0)),
        a.clone().lerp(b, 0.35).add(new THREE.Vector3(0, 0.1, -0.6)),
        a.clone().lerp(b, 0.65).add(new THREE.Vector3(0, 0.1, -0.6)),
        b.clone().add(new THREE.Vector3(-0.4, 0.12, 0)),
      ])
      pipes.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.054, 8, false), M.copper))
    }
    // The cargo: a prompt that becomes a sketch, a circuit, passing tests, a running board.
    const cardPainters = [P.paintPromptCard, P.paintSketchCard, P.paintCircuitCard, P.paintTestsCard, P.paintBoardCard]
    const cardTextures = cardPainters.map((paint) => canvasTexture(256, 352, (c, w, h) => paint(c, w, h, F)))
    const packets: Array<{
      group: THREE.Group
      faces: THREE.Mesh[]
      halo: THREE.Mesh
      stage: number
      phase: number
    }> = []
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group()
      g.userData.moving = true
      machine.add(g)
      box(g, 0.47, 0.71, 0.04, 0, 0, 0, M.ivory, 0.022)
      const faces = cardTextures.map((tex) => {
        const s = screen(g, 0.43, 0.665, 0, 0, 0.024, tex)
        ;(s.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide
        s.visible = false
        return s
      })
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.4, 0.414, 40),
        new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
      )
      halo.rotation.x = -Math.PI / 2
      halo.position.y = -0.37
      halo.visible = false
      g.add(halo)
      packets.push({ group: g, faces, halo, stage: -1, phase: 0 })
    }
    // Ports by arc length, so the travelling prompt stops at the actual stations.
    function nearestPort(x: number, z: number) {
      let best = 0,
        dist = Infinity
      for (let i = 0; i < 300; i++) {
        const p = path.getPointAt(i / 300),
          d = (p.x - x) ** 2 + (p.z - z) ** 2
        if (d < dist) {
          dist = d
          best = i / 300
        }
      }
      return best
    }
    const wireU = nearestPort(-1.65, -0.7),
      simU = nearestPort(1.5, -0.7),
      shipU = nearestPort(0.93, 2.65)

    // Merge static geometry per parent and material; moving assemblies stay separate.
    function compact(group: THREE.Object3D) {
      for (const child of [...group.children]) if ((child as THREE.Group).isGroup) compact(child)
      const buckets = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.Material>[]>()
      for (const object of group.children) {
        const child = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material> & { isInstancedMesh?: boolean }
        if (!child.isMesh || child.isInstancedMesh || child.userData.moving || Array.isArray(child.material)) continue
        const key = child.material.uuid
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key)!.push(child)
      }
      for (const list of buckets.values()) {
        if (list.length < 2) continue
        const geos = list.map((m) => {
          m.updateMatrix()
          const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()
          return g.applyMatrix4(m.matrix)
        })
        const merged = mergeGeometries(geos, false)
        for (const geo of geos) geo.dispose()
        if (!merged) continue
        const mesh = new THREE.Mesh(merged, list[0].material)
        mesh.castShadow = list.some((x) => x.castShadow)
        mesh.receiveShadow = list.some((x) => x.receiveShadow)
        for (const m of list) group.remove(m)
        group.add(mesh)
      }
    }
    compact(machine)
    stations.forEach((s) => s.group.traverse((o) => (o.userData.station = s.id)))
    const pickables = stations.map((s) => s.group)

    // ---- State, camera and the page API ----------------------------------
    let mode: MachineMode = 'assembled',
      cameraMode: MachineCamera = 'overview',
      playing = !reduceMotion,
      simTime = reduceMotion ? P.STILL_FRAME : 0,
      spread = 0,
      selected: StationId = 'ask',
      hovered: StationId | null = null,
      framing: Framing = 'hero'
    let width = frameWidth(),
      height = frameHeight(),
      mobile = width <= 900,
      lastInteraction = performance.now(),
      dragging = false,
      wasDragged = false,
      downX = 0,
      downY = 0
    let cameraAnimating = true,
      flightTime = 0,
      lastDraw = -1,
      visible = true,
      contextLost = false
    const desiredPosition = new THREE.Vector3(),
      desiredTarget = new THREE.Vector3(0, 1, 0)
    const viewDirection = new THREE.Vector3(10.5, 10.8, 17).normalize(),
      scratchDir = new THREE.Vector3()
    let baseDistance = 25,
      sized = false,
      readySent = false
    // The frustum shift that puts the machine beside the copy; eased, never jumped.
    const offset = { x: 0, y: 0, tx: 0, ty: 0 }
    function offsetGoal() {
      if (!embedded) {
        offset.tx = 0
        offset.ty = height * 0.025
      } else if (mobile) {
        offset.tx = 0
        offset.ty = framing === 'hero' ? -height * 0.15 : height * 0.17
      } else {
        offset.tx = -width * 0.225
        offset.ty = 0
      }
    }
    function applyOffset() {
      camera.setViewOffset(width, height, offset.x, offset.y, width, height)
    }
    // A zero-size frame would put NaN in the projection: wait for a real size.
    function layoutCamera() {
      if (!frameWidth() || !frameHeight()) return
      const first = !sized
      sized = true
      width = frameWidth()
      height = frameHeight()
      mobile = width <= 900
      renderer.setSize(width, height)
      camera.aspect = width / height
      offsetGoal()
      offset.x = offset.tx
      offset.y = offset.ty
      applyOffset()
      const aspect = width / height
      const availableWidth = mobile ? 0.91 : Math.min(0.55, aspect > 2 ? 0.54 : 0.57)
      const tan = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      const horizontalFit = 17.3 / (tan * aspect * availableWidth)
      const verticalFit = 11.5 / (tan * (embedded ? 0.85 : 0.62))
      baseDistance = (Math.max(horizontalFit, verticalFit) * (mobile ? 0.97 : 1)) / (embedded ? (mobile ? 1.12 : 1.06) : 1)
      controls.maxDistance = Math.max(55, baseDistance * 1.6)
      camera.updateProjectionMatrix()
      setCameraGoal()
      cameraAnimating = true
      if (first) {
        camera.position.copy(desiredPosition)
        controls.target.copy(desiredTarget)
        controls.update()
        cameraAnimating = false
      }
    }
    function setCameraGoal() {
      const expand = mode === 'stations' ? 1.2 : 1
      if (cameraMode === 'station') {
        const s = byId(selected)
        const [lift, distance] = s.focus
        desiredTarget.copy(s.group.position).add(new THREE.Vector3(0, lift, 0))
        desiredPosition
          .copy(desiredTarget)
          .addScaledVector(scratchDir.set(...s.view).normalize(), distance * (mobile ? 0.86 : 1))
      } else {
        desiredTarget.set(0, 1, 0)
        const distance = baseDistance * expand
        if (cameraMode === 'side') desiredPosition.set(13, 5, 20).normalize().multiplyScalar(distance).add(desiredTarget)
        else if (cameraMode === 'top') desiredPosition.set(0.01, distance, 0.8).add(desiredTarget)
        else desiredPosition.copy(viewDirection).multiplyScalar(distance).add(desiredTarget)
      }
    }
    function syncButtons() {
      root
        .querySelectorAll<HTMLElement>('[data-mode]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)))
      root
        .querySelectorAll<HTMLElement>('[data-camera]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.camera === cameraMode)))
      $('journey').classList.toggle('visible', mode === 'order')
      root.dataset.mode = mode
    }
    const MODES: MachineMode[] = ['assembled', 'cutaway', 'stations', 'order']
    const CAMERAS: MachineCamera[] = ['overview', 'side', 'top', 'station', 'flight']
    function setMode(name: string) {
      if (!MODES.includes(name as MachineMode)) return false
      mode = name as MachineMode
      lastInteraction = performance.now()
      if (mode === 'order') {
        simTime = 0
        lastDraw = -1
        play()
        cameraMode = 'overview'
      } else if (cameraMode === 'station') cameraMode = 'overview'
      setCameraGoal()
      cameraAnimating = true
      syncButtons()
      return true
    }
    function focusStation(id: string) {
      const s = stations.find((s) => s.id === id)
      if (!s) return false
      selected = s.id
      if (mode !== 'cutaway') mode = 'assembled'
      cameraMode = 'station'
      lastInteraction = performance.now()
      setCameraGoal()
      cameraAnimating = true
      syncButtons()
      return true
    }
    function setCamera(name: string) {
      if (!CAMERAS.includes(name as MachineCamera)) return false
      cameraMode = name as MachineCamera
      if (mode === 'order') mode = 'assembled'
      lastInteraction = performance.now()
      flightTime = 0
      setCameraGoal()
      cameraAnimating = true
      syncButtons()
      return true
    }
    function overview() {
      mode = 'assembled'
      cameraMode = 'overview'
      // Let the idle turn start soon after the page comes back to the top.
      lastInteraction = performance.now() - 4000
      setCameraGoal()
      cameraAnimating = true
      syncButtons()
      return true
    }
    function setFraming(next: Framing) {
      framing = next
      offsetGoal()
    }
    const pauseIcon =
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2" y="1" width="2.5" height="10" rx=".5"/><rect x="7.5" y="1" width="2.5" height="10" rx=".5"/></svg>'
    const playIcon =
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1l8 5-8 5z"/></svg>'
    function syncPlayback() {
      const b = $('play')
      b.setAttribute('aria-label', playing ? 'Pause the machine' : 'Run the machine')
      b.setAttribute('aria-pressed', String(!playing))
      b.innerHTML = playing ? pauseIcon : playIcon
      root.classList.toggle('paused', !playing)
    }
    function play() {
      playing = true
      syncPlayback()
      return true
    }
    function pause() {
      playing = false
      syncPlayback()
      return true
    }
    const api: MachineApi = { setMode, setCamera, focusStation, overview, setFraming, play, pause }
    window.__machine = api
    cleanups.push(() => {
      if (window.__machine === api) delete window.__machine
    })
    root.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => listen(b, 'click', () => setMode(b.dataset.mode ?? '')))
    root
      .querySelectorAll<HTMLElement>('[data-camera]')
      .forEach((b) => listen(b, 'click', () => setCamera(b.dataset.camera ?? '')))
    listen($('play'), 'click', () => (playing ? pause() : play()))
    syncPlayback()
    syncButtons()
    layoutCamera()
    const resizeObserver = new ResizeObserver(() => layoutCamera())
    resizeObserver.observe(root)
    cleanups.push(() => resizeObserver.disconnect())
    controls.addEventListener('start', () => {
      dragging = true
      cameraAnimating = false
      lastInteraction = performance.now()
    })
    controls.addEventListener('end', () => {
      dragging = false
      lastInteraction = performance.now()
    })
    controls.addEventListener('change', () => {
      if (dragging) lastInteraction = performance.now()
    })

    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2(),
      tooltip = $('tooltip')
    const local = (e: PointerEvent) => {
      const r = root.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top] as const
    }
    function hitStation(x: number, y: number) {
      pointer.set((x / width) * 2 - 1, (-y / height) * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(pickables, true)
      return hits.length ? (stations.find((s) => s.id === hits[0].object.userData.station) ?? null) : null
    }
    listen(renderer.domElement, 'pointermove', (e: PointerEvent) => {
      const [x, y] = local(e)
      if (Math.hypot(x - downX, y - downY) > 5) wasDragged = true
      if (dragging || e.pointerType === 'touch') return
      const s = hitStation(x, y)
      hovered = s ? s.id : null
      renderer.domElement.style.cursor = s ? 'pointer' : coarse ? '' : 'grab'
      tooltip.classList.toggle('visible', !!s)
      if (s) {
        tooltip.querySelector('strong')!.innerHTML = `<span>${String(s.step).padStart(2, '0')}</span>${s.name}`
        tooltip.querySelector('p')!.textContent = s.desc
        tooltip.style.left = Math.min(width - 255, Math.max(10, x + 16)) + 'px'
        tooltip.style.top = Math.max(10, Math.min(height - 95, y - 65)) + 'px'
      }
    })
    listen(renderer.domElement, 'pointerleave', () => {
      hovered = null
      tooltip.classList.remove('visible')
    })
    listen(renderer.domElement, 'pointerdown', (e: PointerEvent) => {
      ;[downX, downY] = local(e)
      wasDragged = false
      tooltip.classList.remove('visible')
    })
    listen(renderer.domElement, 'pointerup', (e: PointerEvent) => {
      if (wasDragged) return
      const s = hitStation(...local(e))
      if (!s) return
      focusStation(s.id)
      options.onStation?.(s.id)
    })
    let lastFrame = performance.now()
    listen(document, 'visibilitychange', () => {
      visible = !document.hidden
      lastFrame = performance.now()
    })
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting && !document.hidden
        lastFrame = performance.now()
      },
      { threshold: 0.01 }
    )
    observer.observe(renderer.domElement)
    cleanups.push(() => observer.disconnect())
    listen(renderer.domElement, 'webglcontextlost', (e: Event) => {
      e.preventDefault()
      contextLost = true
      showError('The graphics context was interrupted. The machine comes back on its own once WebGL is available again.')
    })
    listen(renderer.domElement, 'webglcontextrestored', () => {
      contextLost = false
      $('error').style.display = 'none'
      lastFrame = performance.now()
    })

    // ---- The loop ----------------------------------------------------------
    const scratch = new THREE.Vector3(),
      anchor = new THREE.Vector3()
    const LABEL_OFFSETS = {
      wide: [
        [-48, -14],
        [-8, -64],
        [30, -12],
        [30, 20],
        [-12, 40],
      ],
      narrow: [
        [-30, 25],
        [-27, -50],
        [15, -65],
        [16, -1],
        [-5, 52],
      ],
    }
    let prevJourney = -1,
      frameCount = 0,
      measureTime = 0,
      pixelRatio = renderer.getPixelRatio(),
      rafId = 0
    const askBase = byId('ask').group.position,
      writeBase = byId('write').group.position
    // The live screens and their stations. The one in the close-up repaints at
    // 15 fps; the rest, small in the frame, at 4, which keeps texture uploads light.
    const liveScreens: Array<{ tex: Painted; station: StationId; paint: (t: number) => void; last: number }> = [
      { tex: codeTex, station: 'write', paint: (t) => P.paintCode(codeTex.ctx, 384, 640, t, F), last: -1 },
      { tex: chatTex, station: 'ask', paint: (t) => P.paintChat(chatTex.ctx, 480, 460, t, F), last: -1 },
      { tex: simTex, station: 'simulate', paint: (t) => P.paintSim(simTex.ctx, 896, 592, t, F), last: -1 },
      { tex: uploadTex, station: 'ship', paint: (t) => P.paintUpload(uploadTex.ctx, 512, 176, t, F), last: -1 },
    ]
    function paintScreens(t: number, force = false) {
      for (const s of liveScreens) {
        const close = cameraMode === 'station' ? selected === s.station : mode === 'order' || cameraMode !== 'overview'
        const interval = close ? 1 / 15 : cameraMode === 'station' ? 1 / 3 : 1 / 8
        if (!force && s.last >= 0 && t >= s.last && t - s.last < interval) continue
        s.paint(t)
        s.tex.texture.needsUpdate = true
        s.last = t
      }
    }
    function animate(now: number) {
      rafId = requestAnimationFrame(animate)
      const dt = Math.max(0, Math.min((now - lastFrame) / 1000, 0.045))
      lastFrame = now
      if (!visible || contextLost || !sized) return
      if (playing) {
        simTime += dt
        flightTime += dt
      }
      const t = simTime,
        beat = (t / 4) % 1,
        tact = (t * TAU) / 4,
        smooth = 1 - Math.exp(-dt * 5)
      spread = THREE.MathUtils.lerp(spread, mode === 'stations' ? 1 : 0, smooth)
      cutPlane.constant = THREE.MathUtils.lerp(cutPlane.constant, mode === 'cutaway' ? 0.99 : 10, smooth)
      stations.forEach((s, i) => {
        s.group.position.copy(s.base)
        s.group.position.x *= 1 + spread * 0.29
        s.group.position.z *= 1 + spread * 0.37
        s.group.position.y += spread * (i % 2 ? 0.32 : 0.55)
        const pulse = Math.pow(Math.max(0, Math.sin(tact - (s.step - 1) * 0.9)), 7)
        s.glowMat.emissiveIntensity = THREE.MathUtils.lerp(
          s.glowMat.emissiveIntensity,
          hovered === s.id || (cameraMode === 'station' && selected === s.id) ? 3.2 : 0.5 + pulse * 0.7,
          smooth
        )
      })
      belt.scale.set(1 + spread * 0.12, 1, 1 + spread * 0.15)
      pipes.scale.set(1 + spread * 0.25, 1, 1 + spread * 0.3)
      gears.forEach((g, i) => (g.rotation.y = t * (i % 2 ? -1 : 1) * 1.1))
      reels.forEach((r, i) => (r.rotation.z = -t * (i ? 0.65 : 0.85)))
      printhead.position.x = Math.sin(tact) * 0.42
      printhead.position.y = 1.91 + Math.sin(tact * 2) * 0.055
      codePanel.position.y = beat * 0.25
      report.position.y = Math.sin(tact) * 0.04
      // The orb breathes while it works and turns green as each loop of the screens finishes.
      const loop = (t % 10) / 10
      orbPoints.rotation.y = t * 0.45
      orbPoints.rotation.x = Math.sin(t * 0.3) * 0.25
      orb.scale.setScalar(1 + Math.sin(t * 3.1) * 0.03)
      orbRing.rotation.z = t * 0.6
      const settled = loop > 0.7 ? 1 : 0
      orbMat.color.lerp(settled ? ORB_DONE : ORB_REST, smooth)
      ;(orbCore.material as THREE.MeshBasicMaterial).opacity = 0.18 + 0.2 * (0.5 + 0.5 * Math.sin(t * 3.1)) + 0.2 * settled
      orbLight.intensity = 2.5 + settled * 3
      // The arm swings over the board and dips to place a part.
      arm.rotation.y = 0.55 + Math.sin(tact) * 0.35
      nozzle.position.y = -0.06 - Math.max(0, Math.sin(tact * 2)) * 0.08
      // The parts blink with the sketch: pin 13 every half second, TX on each print.
      const lit = P.ledOn(t)
      M.ledGreen.emissiveIntensity = lit ? 2.6 : 0.06
      M.ledL.emissiveIntensity = lit ? 2.4 : 0.06
      M.ledTx.emissiveIntensity = t % 0.5 < 0.07 ? 2.2 : 0.06
      const orderPhase = (t / 24) % 1,
        shipBeat = mode === 'order' ? THREE.MathUtils.clamp((orderPhase - 0.88) / 0.12, 0, 1) : beat
      tape.visible = token.visible = mode !== 'order' || orderPhase > 0.88
      tape.scale.y = 0.2 + Math.min(1, shipBeat * 1.5) * 0.8
      token.position.set(1.04, 2.7 - Math.min(1, shipBeat * 1.7) ** 2 * 2.17, 0.55)
      token.rotation.y = t * 3.5
      token.scale.setScalar(shipBeat > 0.9 ? 1 - (shipBeat - 0.9) * 8 : 1)
      const incomingBeat = mode === 'order' ? Math.min(1, orderPhase / 0.15) : beat
      incoming.visible = mode !== 'order' || orderPhase < 0.15
      incoming.position.set(Math.sin(incomingBeat * Math.PI) * 0.24, 3.3 - incomingBeat * 2.25, 1.1 - incomingBeat * 0.55)
      incoming.rotation.z = Math.sin(incomingBeat * Math.PI) * -0.14
      incoming.scale.setScalar(Math.min(1, incomingBeat * 8 + 0.15, (1 - incomingBeat) * 7 + 0.1))
      toggles.forEach((o, i) => (o.rotation.x = Math.sin(tact + i) > 0 ? -0.4 : 0.4))
      paintScreens(t)
      if (t - lastDraw > 1 / 30 || lastDraw < 0 || t < lastDraw) {
        updateBelt(t)
        lastDraw = t
      }
      packets.forEach((packet, i) => {
        const phase = (t / 24 + i / 6) % 1
        packet.phase = phase
        let stage
        if (phase < 0.15) {
          // The prompt flies from the chat to the writer.
          stage = 0
          const f = phase / 0.15
          packet.group.position.copy(askBase).add(new THREE.Vector3(0, 1.6, 0.6))
          scratch.copy(writeBase).add(new THREE.Vector3(0, 1.3, 0.65))
          packet.group.position.lerp(scratch, f)
          packet.group.position.y += Math.sin(f * Math.PI) * 2
          packet.group.rotation.set(0, Math.sin(f * Math.PI) * 0.28, Math.sin(f * Math.PI) * -0.1)
        } else {
          const u = ((phase - 0.15) / 0.85) * shipU
          path.getPointAt(u, packet.group.position)
          packet.group.position.x *= 1 + spread * 0.12
          packet.group.position.z *= 1 + spread * 0.15
          packet.group.position.y += 0.43
          packet.group.rotation.set(0, 0.18, 0)
          stage = u < wireU * 0.7 ? 1 : u < simU * 0.96 ? 2 : u < shipU * 0.83 ? 3 : 4
        }
        if (packet.stage !== stage) {
          packet.faces.forEach((f, j) => (f.visible = j === stage))
          packet.stage = stage
        }
        packet.group.visible = mode !== 'order' || i === 0
        packet.halo.visible = mode === 'order' && i === 0
        packet.group.scale.setScalar(mode === 'order' ? 1.35 : 1)
        if (phase > 0.94) packet.group.scale.multiplyScalar(Math.max(0.05, (1 - phase) / 0.06))
      })
      if (mode === 'order') {
        const packet = packets[0],
          step = packet.stage
        if (step !== prevJourney) {
          $('journey-title').textContent = JOURNEY[step][0]
          $('journey-detail').textContent = JOURNEY[step][1]
          $('journey').dataset.step = String(step + 1)
          prevJourney = step
        }
        $('journey-progress').style.transform = `scaleX(${packet.phase})`
        if (!dragging && playing) {
          desiredTarget.copy(packet.group.position)
          desiredPosition.copy(desiredTarget).addScaledVector(viewDirection, mobile ? 10 : 15)
          cameraAnimating = true
        }
      } else {
        prevJourney = -1
        if (cameraMode === 'flight' && playing && !dragging) {
          const a = flightTime * 0.12,
            d = baseDistance * (mode === 'stations' ? 1.2 : 1)
          desiredTarget.set(0, 1, 0)
          desiredPosition
            .set(Math.sin(a + 0.55) * d * 0.83, d * (0.5 + Math.sin(a * 0.7) * 0.09), Math.cos(a + 0.55) * d * 0.83)
            .add(desiredTarget)
          cameraAnimating = true
        } else if (cameraMode === 'station' && cameraAnimating) setCameraGoal()
      }
      if (cameraAnimating && !dragging) {
        const speed = 1 - Math.exp(-dt * (mode === 'order' ? 2.2 : 2.6))
        camera.position.lerp(desiredPosition, speed)
        controls.target.lerp(desiredTarget, speed)
        if (
          cameraMode !== 'flight' &&
          mode !== 'order' &&
          camera.position.distanceTo(desiredPosition) < 0.015 &&
          controls.target.distanceTo(desiredTarget) < 0.015
        )
          cameraAnimating = false
      }
      if (Math.abs(offset.x - offset.tx) > 0.5 || Math.abs(offset.y - offset.ty) > 0.5) {
        const k = 1 - Math.exp(-dt * 4)
        offset.x += (offset.tx - offset.x) * k
        offset.y += (offset.ty - offset.y) * k
        applyOffset()
      }
      controls.autoRotate =
        playing &&
        !reduceMotion &&
        !dragging &&
        !cameraAnimating &&
        mode !== 'order' &&
        cameraMode === 'overview' &&
        now - lastInteraction > 6500
      controls.autoRotateSpeed = 0.24
      controls.update(dt)
      // Station callouts, projected after the camera moves and kept clear of the copy.
      const showLabels = mode === 'stations'
      stations.forEach((s, i) => {
        s.label.classList.toggle('visible', showLabels)
        if (!showLabels) return
        anchor.copy(s.group.position).add(s.anchor).project(camera)
        const [dx, dy] = (mobile ? LABEL_OFFSETS.narrow : LABEL_OFFSETS.wide)[i]
        let x = (anchor.x * 0.5 + 0.5) * width - 40 + dx,
          y = (-anchor.y * 0.5 + 0.5) * height - 52 + dy
        x = THREE.MathUtils.clamp(x, mobile || !embedded ? 9 : width * 0.425, width - (mobile ? 123 : 165))
        y = THREE.MathUtils.clamp(y, 90, height - 160)
        s.label.style.transform = `translate(${x}px,${y}px)`
      })
      renderer.render(scene, camera)
      if (!readySent) {
        readySent = true
        root.classList.add('ready')
        options.onReady?.()
      }
      // On sustained slow devices lower only the raster resolution.
      if (playing) {
        frameCount++
        measureTime += dt
        if (measureTime > 4) {
          if (frameCount / measureTime < 43 && pixelRatio > 1) {
            pixelRatio = Math.max(1, pixelRatio - 0.25)
            renderer.setPixelRatio(pixelRatio)
          }
          frameCount = 0
          measureTime = 0
        }
      }
    }
    paintScreens(simTime, true)
    rafId = requestAnimationFrame(animate)
    cleanups.push(() => {
      cancelAnimationFrame(rafId)
      controls.dispose()
      const textures = new Set<THREE.Texture>()
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const list = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []
        for (const material of list) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
          material.dispose()
        }
      })
      geometries.forEach((g) => g.dispose())
      textures.forEach((t) => t.dispose())
      env.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    })
    renderer.compile(scene, camera)
    $('loading').classList.add('done')
    $('error').style.display = 'none'
    // For automated browser checks; no production UI.
    Object.defineProperty(window, '__machineDebug', {
      value: {
        getState: () => ({
          mode,
          camera: cameraMode,
          selected,
          playing,
          time: simTime,
          spread,
          cutHeight: cutPlane.constant,
          width,
          height,
          offset: [Math.round(offset.x), Math.round(offset.y)],
          cameraAnimating,
          dragging,
          cameraPosition: camera.position.toArray().map((v) => +v.toFixed(2)),
          desiredPosition: desiredPosition.toArray().map((v) => +v.toFixed(2)),
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          pixelRatio: renderer.getPixelRatio(),
          stations: stations.map((s) => {
            const p = s.group.position.clone().add(new THREE.Vector3(0, 1, 0)).project(camera)
            return { id: s.id, x: Math.round((p.x * 0.5 + 0.5) * width), y: Math.round((-0.5 * p.y + 0.5) * height) }
          }),
        }),
      },
      configurable: true,
    })
    cleanups.push(() => {
      delete window.__machineDebug
    })
  } catch (error) {
    console.error('Machine: failed to start', error)
    showError()
  }
  return dispose
}
