# Security & Trust Model

LLM Fusion is a **local developer tool**. Understand this before running it.

## It runs code on your machine, on purpose

The harness spawns terminal (PTY) sessions and launches LLM CLI agents with
edit and shell permissions. The autopilot classifies a goal and runs those
agents autonomously against a workspace you choose. **Anyone who can reach the
HTTP API can execute commands as your user account.**

The only thing standing between "your local tool" and "remote code execution"
is the network binding.

## The controls

- **Loopback by default.** The server binds `127.0.0.1`. It is not reachable
  from your network.
- **Explicit opt-in for exposure.** Binding a non-loopback host requires
  `LLM_FUSION_ALLOW_UNSAFE_HOST=1`. Do not set this unless you fully understand
  that it exposes command execution to anyone who can reach the host.
- **WebSocket origin guard.** Cross-origin browser WebSocket connections are
  rejected; only same-origin loopback pages (and non-browser clients) may
  attach to a terminal.
- **Random session ids.** Session identifiers are UUIDs, so a cross-origin page
  cannot guess a terminal to attach to.

## Operating guidance

- **Run it only on a trusted machine you control.** Never expose it to a shared
  or public network.
- **Point the autopilot only at repositories you trust.** Agents act on the
  code in the workspace; a hostile repo can contain instructions that attempt to
  steer an agent (prompt injection). Treat an untrusted workspace like untrusted
  code.
- **The folder browser (`/api/fs/dirs`) lists directory names anywhere on the
  machine.** This is intentional for the workspace picker and is bounded by the
  same loopback + same-origin controls above.
- **Runtime state under `data/`** (session logs, transcripts) may contain
  whatever your agents printed. It is git-ignored; keep it that way.

## Reporting a vulnerability

Open a GitHub issue for non-sensitive reports. For anything you would not want
public, contact the maintainer directly before disclosing.
