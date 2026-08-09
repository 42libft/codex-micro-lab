# Codex Micro Lab protocol notes

## Discovery

The current Codex desktop build filters HID interfaces by:

| field | value |
| --- | --- |
| Vendor ID | `0x303A` |
| Codex Micro Product ID | `0x8360` |
| Creator Micro V2 Product IDs | `0x8297`, `0x8298` |
| Usage Page | `0xFF00` |
| HID report ID | `6` |

The Lab shim returns the same logical `codex_micro` descriptor used by Work Louder's `DeviceType` enum. Work Louder's internal `ConnectionType.hid` value is `1` for the HID transport enum; `isUsbConnection:false` distinguishes the bridge's Bluetooth-like path from USB.

## RPC

Current Work Louder/OAI RPC uses newline-delimited JSON objects. Requests have `method`, `params`, and `id`; the current client does not add a `jsonrpc` property.

- `device.status` → firmware, battery, charging state
- `sys.version` → firmware version
- `v.oai.rgbcfg` → ambient/key lighting
- `v.oai.thstatus` → per-thread lighting
- `v.oai.hid` notification → `{k, act, ag?}`
- `v.oai.rad` notification → `{a, d}`

The low-level HID framing documented by FreeMicro is retained in `src/protocol.ts`: report ID 6, channel 2, length byte, and up to 61 UTF-8 payload bytes per report.

## Transport and pairing

The Codex shim and renderer use a `0600` Unix domain socket. `codex-shim`, `codex-probe`, and `codex-renderer` roles are accepted only there; a WebSocket hello claiming any of those roles is rejected. The LAN WebSocket accepts only authenticated `iphone` and `web` roles from the address ranges listed in [`SECURITY.md`](../SECURITY.md). The browser role must also send the exact loopback Origin registered by the local Web controller.

The project does not advertise a Bonjour service. Pairing uses only `codexmicro://pair#<base64url-json>`, with this decoded shape:

```json
{
  "version": 1,
  "token": "32 hexadecimal characters",
  "hosts": ["allowlisted non-global IPv4 address"],
  "port": 47831
}
```

The fragment avoids query-string disclosure but is not encrypted. The scanner rejects other schemes/hosts, query parameters, raw tokens, public addresses, more than eight hosts, ports outside `1024...65535`, and versions other than `1`.

## Bridge envelope

Both transports use versioned JSON envelopes, but authorization is transport-specific. `device.list`, `topology.subscribe`, `rpc.request`, `rpc.response`, and renderer semantic messages remain on the Unix transport. Authenticated controllers can send `input.hid`, `input.joystick`, `input.text`, iPhone telemetry, and heartbeat messages. They receive lighting, connection state, input acknowledgements, and sanitized agent-slot state.

LAN snapshots do not include thread keys, titles, command/skill names, layout assignments, reasoning labels, or raw Codex error strings. Thread lighting is reduced to slot, color, and coarse state before broadcast. The bridge expires iPhone/web clients after 30 seconds without activity; both clients send a heartbeat every 10 seconds.

The LAN path is plain `ws://` without TLS or end-to-end encryption. The bearer token authenticates the peer but does not provide confidentiality. Sensitive text must not be sent over this PoC transport.

## Evidence and scope

The descriptor and framing values are carried over from the public [FreeMicro protocol notes](https://github.com/eliBenven/freemicro/blob/64258eb6cc3312a43f9f9f86d87e55e0b609ccc5/docs/PROTOCOL.md) and the Codex Micro product context in [OpenAI's Work Louder announcement](https://openai.com/supply/co-lab/work-louder/). The local implementation is intentionally pinned to the inspected Codex `26.803.41515 (6321)` build; `microctl inspect` refuses to patch a different ASAR hash.

The iPhone path is a bridge client, not a USB HID impersonator. The Debug-only `BLEHidProbe` records whether iOS accepts a `0x1812` GATT service, but that result is not sufficient to claim Codex compatibility. A true OS-level virtual HID backend remains conditional on Apple's [virtual HID entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.hid.virtual.device).
