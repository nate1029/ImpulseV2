# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security › Report a vulnerability** on https://github.com/Meet-1010/Impulse-IDE-v2/security. Don't open a public issue for them.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an answer within a week, and we'll agree on a disclosure date once a fix is ready.

## Supported versions

Security fixes go into the latest release and the latest beta.

## What's in scope

- The Electron app: the main process, the preload bridge, IPC handlers, file access outside approved folders, the renderer's content security policy.
- Handling of AI API keys and the data sent to AI providers.
- The toolchain download (arduino-cli is verified against a pinned SHA-256) and auto-update.

Out of scope: vulnerabilities in arduino-cli, board cores, libraries or AI provider services themselves (report those upstream), and attacks that need an already-compromised computer.

## How the app is hardened

- The renderer is sandboxed with context isolation and no Node.js access; its content security policy allows only the app's own resources.
- Every IPC input is validated; file access is limited to folders you opened through a system dialog.
- API keys are encrypted with the operating system's credential store.
- arduino-cli and other external tools run with argument arrays, never through a shell.
- The AI agent can't run shell commands, and every upload to hardware needs your confirmation.
