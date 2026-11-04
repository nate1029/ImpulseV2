# Chat mode: design ledger

Chat mode is Impulse's default view: one conversation to plan, build and debug,
with the IDE one click away. This file records where each design choice came
from, so later work extends it instead of drifting back to a generic dark
developer tool. The IDE view keeps its own ledger in
`src/renderer/design-system.css` (Linear base).

## Why earlier screens all looked alike

Every Impulse surface since September was built on one locked reference
(Linear, in `design-system.css`) and on Refero searches for "developer tool,
dark". That query family returns the same cluster (Linear, Warp, Vercel,
Raycast, Langbase, GitHub): near-black, white text, one soft accent. Refero
worked fine; the inputs converged. Chat mode was researched outside that
category (hardware instruments, industrial design, generative ASCII) and locks
one primary reference with explicit rejects, below.

## Research (Refero, 2026-10-16)

- Styles read in full: Elektron (elektron.se), teenage engineering,
  Oxide Computer, Midjourney, Hyperstudio.
- Screens: ChatGPT home (dark), Factory.ai session start and model/effort
  popover, Mocha composer, Rork billing credits, Flask and Factory sign-in,
  Polar dashboard, Runway members table, Steel usage dashboard.
- Flows: Lovable sign-in and builder entry (prompt first, sign in second),
  Factory signup with email one-time code, Linear sign-in methods.
- The owner's sketch (layout) and screen recording (empty-state animation).

## Reference lock

- **Primary: Elektron** (a precision instrument console). Preserve: a near-black
  canvas with panels separated by tone, not shadow; off-white text on a strict
  gray ramp, white only for headings and active state; rectilinear controls
  (3px buttons and chips, 7px inputs; the composer is the one larger radius at
  10px because it is the main input); one amber indicator used as a signal,
  never as a fill; numbers set as readouts in JetBrains Mono.
- **Borrowed, bounded:**
  - Midjourney: a generative character field as the only hero visual (the
    owner's recording), and status tints at about 16% with bright text, used
    for LED states.
  - Factory.ai: the context sentence with inline chips, and the two-column
    model + effort popover with mono section labels.
- **Role rules:** amber = busy or attention; green = connected, passed, done;
  red = fault. White fill = the one primary action on screen (Send, Sign in).
  The field's steel blue is decorative only. Syntax colors stay in code.
- **Media:** code-native only. The character field (WebGL), line icons, an
  oscilloscope trace on sign-in. No photos, no illustrations.
- **Rejected:** indigo or violet AI gradients, glass and glows, pill buttons,
  a Linear-clone sidebar, serif or italic word swaps, emoji, sparkle icons for
  AI, cards used only to group things.

## Decision ledger

| Decision | Source | Role rule | Why |
|---|---|---|---|
| Canvas `#0c0c0d`, panel `#121213`, raised `#18181a` | Elektron surfaces | depth by tone, no shadows on panels | Instrument-console feel; separates sidebar, canvas and composer without borders everywhere |
| Text `#eeeef2`, `#b4b4b8`, `#8a8a90`; icons `#6a6a70` | Elektron text ramp | `#6a6a70` never for text (3.5:1) | Readable without pure white glare |
| Buttons 3px, inputs 7px, composer 10px, menus 8px | Elektron radii | larger radius = input surfaces | Hardware-key crispness, one inviting input |
| LED dots (amber/green/red) for state | Elektron amber indicator + Midjourney tint triad | LEDs never decorate | Embedded engineers read LEDs instantly |
| Mono silkscreen labels: 10.5px caps, +0.08em | Oxide mono, Factory labels | labels and readouts only, never prose | PCB silkscreen voice |
| Chat prose Inter 14.5/1.6 | craft rule (readability) | — | Long answers must read easily |
| Empty-state headline Inter 28px, -0.022em, weight 480 | Elektron display tracking | one per screen | Calm, engineered |
| Character field of firmware hex, lit by drifting light; a click sends a ripple of light out across it (a fast front that slows at about 340 px out, a thin band that lingers and drifts behind it in sparse swaths, grainy per character, gone in under three seconds; measured against the owner's recording: a single click lights about 1% of the pixels at its peak and spans a third of the window) | Owner's recording (the Claude desktop empty state) + Midjourney ASCII hero | only before the first message; the ripple is the one "big" motion and only on click | The "you're in a lab" moment; hex is what gets flashed to a board; the click answers the owner's ask for a flowing glow |
| Board chip top-left, Chat/IDE switch, Serial, Simulator top-right | Owner's sketch | — | Their layout |
| Folder chip above the composer | Owner's sketch | — | Where the code goes |
| Center: what's on the bench (board LED), recent builds, starters | Owner's question + Claude desktop card stack + Factory context line | interactive rows only | Answers "what goes here" with live hardware context |
| Composer row: mode, model, +, send; credits ring below right | Owner's sketch, Factory popover | ring shows remaining credits | Features one click away, not on screen |
| Prompt first, sign in when sending | Lovable flow | prompt is kept and sent after sign-in | No wall in front of the product |
| Sign-up email code (6 digits) in the app | Factory flow | — | No browser hop for email accounts |
| Credits card: plan, bar, remaining, Upgrade | Rork billing | — | Familiar AI-tool pattern |
| Admin charts on a dashed graticule with one trace | Polar dashboard + oscilloscope | one trace per chart | Same instrument language as the app |

## Field lab

`npm run field-lab` writes `docs/design/field-lab.html`: the character field
with its headline and card mock-up and a slider for every parameter in
`FIELD_DEFAULTS` (`src/renderer/vibe/char-field.js`), plus colour pickers,
"3 clicks" for overlapping ripples, and a Settings box to copy. Open the file
in a browser (no server needed), tune, then paste the settings over
`FIELD_DEFAULTS` and the colours into `--v-field-*` in `vibe.css`. Regenerate
the page after changing the module so it stays the same code.

## Tokens

Defined in `src/renderer/vibe/vibe.css` under `.vibe-root` (dark) and
`[data-theme="light"] .vibe-root`. Motion: 120ms hover/press, 200ms state
changes, 320ms panels; ease-out to enter, ease-in to leave. The field runs at
30 fps, pauses when the window is hidden, and draws one still frame under
reduced motion.
