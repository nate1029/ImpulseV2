import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { initMachineScene, type StationId } from './scene/machine'

// The release the download buttons point at. Bump with each release.
const RELEASE = { version: '2.0.0-beta.2', repo: 'Meet-1010/Impulse-IDE-v2' }
const tag = `v${RELEASE.version}`
const asset = (name: string) => `https://github.com/${RELEASE.repo}/releases/download/${tag}/${name}`
const DOWNLOADS: Record<string, string> = {
  macArm: asset(`Impulse-IDE-${RELEASE.version}-arm64.dmg`),
  macIntel: asset(`Impulse-IDE-${RELEASE.version}-x64.dmg`),
  win: asset(`Impulse-IDE-Setup-${RELEASE.version}.exe`),
  appImage: asset(`Impulse-IDE-${RELEASE.version}-x86_64.AppImage`),
  deb: asset(`impulse-ide_${RELEASE.version}_amd64.deb`),
  notes: `https://github.com/${RELEASE.repo}/releases/tag/${tag}`,
}
const FONTS = {
  sans: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
}
const PARTS = [
  'LEDs',
  'Push buttons',
  'Potentiometers',
  'LCD 16×2',
  'SSD1306 OLED',
  'TFT displays',
  'NeoPixels',
  '7-segment',
  'TM1637',
  'LED matrix',
  'HC-SR04',
  'DHT22',
  'DS18B20',
  'PIR sensor',
  'IMU',
  'RTC',
  'Load cell',
  'Keypads',
  'Rotary encoder',
  'IR remote',
  'Servos',
  'NEMA 17',
  '28BYJ-48',
  'A4988',
  'L298N',
  'Relays',
  '74HC595',
  'MOSFETs',
  'Capacitors',
  'Logic gates',
]
const STATIONS: StationId[] = ['ask', 'write', 'wire', 'simulate', 'ship']
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

function setupDownloads() {
  document.querySelectorAll<HTMLAnchorElement>('[data-download]').forEach((a) => {
    const href = DOWNLOADS[a.dataset.download ?? '']
    if (href) a.href = href
  })
  document.querySelectorAll('[data-version]').forEach((el) => (el.textContent = RELEASE.version))
  const ua = navigator.userAgent
  const os = /Mac/.test(ua) && !/iPhone|iPad/.test(ua) ? 'mac' : /Win/.test(ua) ? 'win' : /Linux/.test(ua) && !/Android/.test(ua) ? 'linux' : null
  if (!os) return
  const label = { mac: 'Download for macOS', win: 'Download for Windows', linux: 'Download for Linux' }[os]
  document.querySelector('#hero-download span')!.textContent = label
  document.querySelectorAll<HTMLElement>(`.dl[data-os="${os}"]`).forEach((el) => el.classList.add('is-yours'))
}

function setupParts() {
  const track = document.getElementById('parts')!
  // Two copies so the marquee loops without a seam; one, wrapped, without motion.
  const items = PARTS.map((p) => `<span>${p}</span>`).join('')
  track.innerHTML = reduceMotion ? items : items + items
}

function setupWaves() {
  const svg = document.getElementById('waves')!
  const traces: Array<[string, string, (x: number) => number]> = [
    ['D13', '#71d083', (x) => (Math.floor(x / 40) % 2 ? 0 : 1)],
    ['D9', '#86aee8', (x) => (x % 20 < 5 ? 1 : 0)],
    ['TX', '#e2b866', (x) => (x % 80 < 14 && Math.floor(x / 3) % 3 !== 0 ? 1 : 0)],
  ]
  svg.innerHTML = traces
    .map(([name, color, f], i) => {
      const y0 = 14 + i * 42
      let d = ''
      for (let x = 0; x <= 280; x++) {
        const y = y0 + (1 - f(x)) * 22
        d += x === 0 ? `M40 ${y}` : ` L${40 + x} ${y}`
      }
      return `<text x="0" y="${y0 + 16}">${name}</text><path d="${d}" stroke="${color}" />`
    })
    .join('')
}

function setupNav() {
  const nav = document.getElementById('nav')!
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8)
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()
  document.getElementById('year')!.textContent = String(new Date().getFullYear())
}

/** The tour: whichever panel crosses the middle of the screen drives the machine. */
function setupTour() {
  const stage = document.getElementById('workflow')!
  const panels = [...document.querySelectorAll<HTMLElement>('.stage [data-step]')]
  const rail = [...document.querySelectorAll<HTMLButtonElement>('.rail [data-goto]')]
  let active = ''
  function activate(step: string) {
    if (step === active) return
    active = step
    stage.dataset.active = step
    stage.classList.toggle('touring', STATIONS.includes(step as StationId))
    panels.forEach((p) => p.classList.toggle('is-active', p.dataset.step === step))
    rail.forEach((b) => b.toggleAttribute('aria-current', b.dataset.goto === step))
    const machine = window.__machine
    if (!machine) return
    if (step === 'hero') {
      machine.overview()
      machine.setFraming('hero')
    } else if (step === 'all') {
      machine.setMode('stations')
      machine.setFraming('tour')
    } else {
      machine.focusStation(step)
      machine.setFraming('tour')
    }
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) activate((e.target as HTMLElement).dataset.step ?? 'hero')
    },
    { rootMargin: '-50% 0px -50% 0px' }
  )
  panels.forEach((p) => io.observe(p))
  const goTo = (step: string) =>
    document.getElementById(`step-${step}`)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
  rail.forEach((b) => b.addEventListener('click', () => goTo(b.dataset.goto!)))
  document.getElementById('watch')!.addEventListener('click', () => {
    window.__machine?.setMode('order')
    window.__machine?.play()
  })
  return {
    // A click on a station takes you to its part of the story.
    onStation: (id: StationId) => {
      if (active !== id) goTo(id)
    },
    // The machine came up after the first panel was already chosen: apply it now.
    sync: () => {
      const step = active
      active = ''
      if (step) activate(step)
    },
  }
}

async function startMachine(tour: ReturnType<typeof setupTour>) {
  const root = document.getElementById('machine')!
  // The machine's screens are painted on canvases, so the fonts must be loaded first.
  await Promise.all(
    ['500 20px "Inter Variable"', '700 20px "Inter Variable"', '500 20px "JetBrains Mono Variable"'].map((f) =>
      document.fonts.load(f).catch(() => [])
    )
  )
  initMachineScene(root, {
    embedded: true,
    fonts: FONTS,
    onStation: tour.onStation,
    onReady: () => document.documentElement.classList.add('machine-ready'),
  })
  tour.sync()
}

setupDownloads()
setupParts()
setupWaves()
setupNav()
const tour = setupTour()
startMachine(tour)
