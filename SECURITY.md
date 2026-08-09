# Security model

Codex Micro Lab is a local research prototype, not an OpenAI product. Do not expose its bridge to the public internet.

## Trust boundaries

- Codex shim, renderer semantic events, and probes use a Unix domain socket whose mode is set to `0600`. Renderer roles are rejected on WebSocket, including from loopback.
- iPhone and Web controllers use an authenticated WebSocket. The bearer token is 128 bits encoded as exactly 32 hexadecimal characters. The browser role is also restricted to the exact loopback origin created by `microctl start`; its HTTP bootstrap rejects non-loopback Host headers to prevent DNS rebinding. WebSocket payloads are capped at 64 KiB, and unauthenticated connections time out after five seconds.
- The WebSocket listener rejects source addresses outside loopback, RFC1918 private IPv4, IPv4 link-local `169.254.0.0/16`, and the non-forwardable `192.0.0.0/29` service-continuity prefix used by the tested Personal Hotspot path. The wider `192.0.0.0/24` block is not accepted. IPv6 LAN clients are not supported by this PoC.
- Bonjour discovery and its former token hint are disabled. The iPhone reconnects only to allowlisted non-global IPv4 addresses supplied by a validated QR.
- LAN snapshots contain controller slot, state, selection, and color. Thread keys, task titles, skill/command names, layout assignments, reasoning labels, and raw Codex error text stay on the local Unix side.

## Pairing

The scanner accepts only `codexmicro://pair#<payload>`. The fragment is base64url-encoded JSON containing protocol version `1`, the 32-character token, one to eight allowlisted IPv4 addresses, and a port from `1024` through `65535`. Query-string tokens, raw token QR codes, arbitrary URLs, public IP addresses, and unsupported versions are rejected. The iPhone shows the addresses and port and requires confirmation before saving the credential to Keychain.

The fragment prevents the token from appearing in URL query logs or browser history fields used by this project. Base64url is encoding, not encryption: anyone who can read or photograph the QR can recover the bearer token. Do not share or retain QR screenshots.

`microctl start` does not print the token or put it in the Web controller URL. The loopback page obtains it from a no-store, same-origin bootstrap response. A process already running as the same macOS user can read the `0600` token file and is inside this prototype's trust boundary.

## No transport encryption

The iPhone bridge uses `ws://`, not TLS, and does not provide end-to-end encryption. The pairing token authenticates a controller; it does not make text, input events, telemetry, or lighting confidential. Use only a trusted, isolated LAN or your own Personal Hotspot, keep the macOS firewall enabled, and never configure port forwarding. Do not send passwords, credentials, private source text, personal data, or other sensitive text through the iPhone composer.

## Never publish

- pairing tokens, QR images/URLs, bridge logs, or screenshots containing a token
- Codex application bundles or ASAR files
- keychain exports, provisioning profiles, signing certificates, or private keys
- personal device identifiers or private network details

## Reporting a problem

Use a private GitHub security report if the repository enables it. Do not include live credentials or identifiers in the report.
