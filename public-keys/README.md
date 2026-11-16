# Ed25519 Public Keys — Instinct↔Lipa Signed Request Verification

## Lipa (this box)
- File: `lipa-ed25519-pub.pem`
- SHA-256 fingerprint: `8f02b6b397a531a37e9c244813306d9f1d773af010be72cef3bf7264e3cd5a96`
- Generated: 2026-11-15
- Private key: `.keys/lipa-ed25519.pem` (mode 600, never committed)

## Instinct
- File: `instinct-ed25519-pub.pem`  
- SHA-256 fingerprint: `c9a2cbcb8c143db8a1ab1875af5b34371972ed11deaa016c478b3e22857f9207`
- Received: 2026-11-15

## Signing format (v1)
- Canonical string: `v1\n<unix_ts>\n<request_id>\n<sha256hex(exact JSON payload line)>`
- Header: `SIG: v1 <unix_ts> <base64(signature)>`
- Replay window: |now - ts| ≤ 15 min
- Transition: accept EITHER valid SIG or old AUTH token until verified cutover
