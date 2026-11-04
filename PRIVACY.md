# Privacy

Impulse IDE runs on your computer. It has no analytics and no telemetry. This page lists everything it stores, what an Impulse account adds, and every time the app contacts the internet.

## What stays on your computer

- **Your sketches and circuits** stay in the folders you open. Chat mode's projects go into your sketchbook under `Impulse Projects`; circuits are saved as `diagram.json` next to each sketch.
- **Your chats** (what you asked, what the AI answered and the conversation it remembers) are saved in the app's data folder (`Impulse IDE` under your system's application-data location), with your settings, open tabs and approved folders. Deleting a chat deletes it from your computer; chats are never stored on our servers.
- **Your Impulse session** (a sign-in token, no password) is encrypted with your operating system's credential store (Keychain on macOS, DPAPI on Windows, libsecret on Linux). Signing out removes it.
- **Logs and crash records** are written to the app's logs and data folders and never leave the computer on their own.

## Your Impulse account (optional)

You need an account only to use the AI through Impulse Cloud; the simulator and the IDE work without one. The account exists so that nobody has to bring an API key: Impulse pays the model's vendor (OpenAI or Anthropic, depending on the model you pick) for your requests and counts them in credits.

Impulse Cloud stores: your name, email address and, for Google or GitHub sign-in, the profile picture URL they provide; for email accounts, a salted hash of your password; your sessions (when they were created and last used, the app version, the address they came from); your plan and credit ledger; and one record per AI request with its model, token counts, cost, status and time. **It never stores your prompts, your code, your circuits or the AI's answers**: they pass through the gateway to the model's vendor and are not written down.

Codes for sign-up and password reset are emailed through Resend. Impulse's admins can see the account details above, credits and request counts; they cannot see what you asked.

## Learning from fixes (on by default, one switch to turn off)

When a build or upload fails and the same sketch then succeeds, Impulse treats the pair as a fix and keeps a record of it on your computer (so the same error is recognised next time). If you are signed in and **Sharing fixes** is on (the account menu), the record is also sent to Impulse Cloud, where fixes are counted per error so that the next person with that error gets what worked before the AI guesses.

A fix record holds: the error's signature (its first error line with file paths, line numbers and port names removed), the board and core version, the names of the libraries the sketch includes, the error excerpt, a **diff of only the lines that changed** between the failing and the working sketch, whether the agent or you made the change, the model used and the app version. Before anything is stored or sent, string literals on lines that name an SSID, password, token or key are replaced, as are API keys, email addresses and home-folder paths. It never includes the whole sketch, a prompt, an answer, a circuit or serial data. Shared records belong to your account and are deleted with it.

Turn it off in the account menu (**Sharing fixes: off**): fixes then stay on this computer only. Impulse's admins see the aggregated errors and fixes, with no prompts and no sketches.

## When Impulse uses the internet

| What | Sent to | When |
|---|---|---|
| Your prompt, the open sketch and the context you include (board facts, wiring, compiler or serial output) | Impulse Cloud, which forwards it to the vendor of the model you picked (OpenAI or Anthropic) under Impulse's own key, with an opaque per-account id (never your email) and with storage at the vendor turned off | Only when you use the AI with an Impulse account. That vendor's commercial terms apply to the data. |
| Sign-in and account requests (email, password, codes, the session token) | Impulse Cloud over HTTPS; Google or GitHub sign-in happens in your browser on their pages | When you sign in, and when the app refreshes your credits |
| Update check (app version) | GitHub Releases (`Meet-1010/Impulse-IDE-v2`) | At launch and every few hours, in installed builds |
| Download of arduino-cli, the ESP32 emulator | GitHub (`arduino/arduino-cli` releases), Espressif's releases, checked against checksums built into the app | Only if you choose to set them up and they aren't installed |
| Board, core and library indexes and downloads | Arduino's servers and any board URLs you added, through arduino-cli | When you install boards or libraries, or compile with a library that isn't installed yet |
| A documentation page's address (nothing else: no code, no prompt) | The board maker's own site, from a fixed list (Arduino, Espressif, Seeed, Adafruit, PJRC, Raspberry Pi, M5Stack, Waveshare, DFRobot, Heltec, GitHub) | When the AI needs a hardware fact it is not sure of; pages are cached on your computer for a week |
| Problem reports and part requests | Your browser opens a GitHub issue form | Only when you choose to; you review the text and submit it yourself on GitHub |
| A fix record (error signature, board, core, library names, a redacted diff of the lines that changed, who fixed it) | Impulse Cloud | After a failed build or upload is followed by a success, only when signed in with Sharing fixes on |

When the AI reads a documentation page, only the address of that page is requested. Impulse will not fetch anything outside that list of documentation sites, and never sends your code, prompt or circuit with the request.

Impulse never sends your sketches, circuits, serial data or files anywhere else.

## Your control

- Use no AI at all to keep everything on your computer: the simulator and the IDE never need the internet.
- Turn **Sharing fixes** off in the account menu to keep fix records on this computer only.
- Sign out at any time (the account menu); the session token is removed from your computer.
- To delete your account and its records, open an issue at https://github.com/Meet-1010/Impulse-IDE-v2/issues (or contact the Impulse team); self-service deletion is coming.
- Delete the app's data folder to remove every chat, setting and log.

Questions: open an issue at https://github.com/Meet-1010/Impulse-IDE-v2/issues.
