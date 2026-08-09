# Codex Micro Lab verification log

This log records checks that can be reproduced on the current Mac. It is deliberately separate from the implementation notes so that an article can distinguish observed results from assumptions.

## Public-release hardening (2026-08-10)

The current source confines Codex shim/renderer roles to a `0600` Unix socket and rejects renderer WebSocket hello messages even from loopback. Authenticated Web and iPhone peers are limited to loopback or the allowlisted non-global IPv4 ranges in `SECURITY.md`; the Web role also requires the exact loopback Origin registered by the local controller. Bonjour was removed.

Pairing now uses only `codexmicro://pair#<base64url-json>`. Node and Swift negative tests reject raw tokens, arbitrary URLs, query-string credentials, unsupported versions, non-32-hex tokens, public hosts, and ports outside `1024...65535`. The QR fragment avoids query disclosure but is explicitly documented as reversible encoding, not encryption. The iOS UI requires destination confirmation before saving or connecting.

The CLI/Web integration test starts `microctl start` in a child process, reads the same-origin no-store bootstrap without exposing the token in CLI output or the page URL, and completes an authenticated WebSocket hello from the registered Origin. LAN semantic tests verify that agent title/thread key/assignment data is stripped and layout/reasoning snapshots are not broadcast. The iPhone hello no longer includes `identifierForVendor` or another device ID.

The current iOS source passes its unit and UI targets in the iPhone 17 simulator and builds for both simulator and `iphoneos` with signing disabled under `io.github.42libft.codex-micro-lab.iphone`. A physical-device install, signing, launch, and interaction replay were not performed during this hardening pass.

## Host and Codex build

- macOS: 26.4
- Codex: `26.803.41515 (6321)`
- Xcode: `26.6 (17F113)`
- Developer directory: `/Applications/Xcode.app/Contents/Developer`
- Current Codex ASAR SHA-256: `5f6e773aafd542d3cf09e10b5dca6cabd301d0a155f4b8ce870e3915fc3da25e`

`node dist/src/cli.js inspect` currently reports `compatible: true`, the expected `CodexMicroService` module is present, and Feature Gate `3207467860` occurs seven times. The Electron fuse sentinel is readable; ASAR integrity validation and ASAR-only loading are disabled in this build.

The generated Lab copy was rebuilt after checking the bundled `ConnectionEventType` enum (`CONNECTED=0`, `DISCONNECTED=1`, `ERROR=2`) and the service callback's object-shaped state (`{status, transport, model, error, ...}`). The wrapper preserves both forms, guards old transport close callbacks by socket identity/generation, maps official Agent slots without leaking unknown internal IDs, times out a silent RPC after five seconds, and the final copy passes `codesign --verify --deep --strict`. The final ASAR header hash is `d56dbd1ef8ae33675fbbbee1adaa4a8ebf5af0ff7e11d193ee067fec10a10b38`.

## Reproducible checks

```sh
npm test
xcodebuild -project ios/CodexMicroLab.xcodeproj \
  -target CodexMicroLab -sdk iphoneos -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
node dist/src/cli.js inspect
node dist/src/cli.js doctor
node dist/src/cli.js ui status
```

The Node suite is run with `npm test`, which includes TypeScript build, bridge authorization, QR validation, Web origin, CLI/Web integration, Lab wrapper, protocol, and reversible state tests. The iOS app is also built with signing disabled for simulator and device SDKs.

Xcode's iOS 26.5 runtime is installed and registered. An iPhone 17 simulator was booted after the one-time dyld cache and data migrations. A simulator build also succeeds with `CODE_SIGNING_ALLOWED=NO`.

The iOS target uses `io.github.42libft.codex-micro-lab.iphone`; the unit/UI test targets use matching `.tests` and `.uitests` suffixes. Moving away from the earlier prototype identity requires reinstalling and pairing again. The repository deliberately omits a development team ID; each Xcode user selects their own team under Signing & Capabilities. Generated design-review screenshots remain local and are not public repository assets.

`microctl doctor` reads CoreDevice's structured inventory but reports only aggregate detection, tunnel state, and Developer Mode status; it no longer prints a device identifier. The install helper uses an identifier internally while redacting it from output.

The Debug BLE screen now reports Bluetooth state and the `0x1812` service registration result in-app; on the iPhone 17 Simulator it reported `Bluetooth unavailable (state 2)`. It still deliberately labels registration as diagnostic rather than compatibility proof. The latest Simulator UI test run passed four scenarios (primary thumb/text controls, pairing, connected Cockpit/settings, and recovering Cockpit); the iOS unit target passed five safety and pairing tests.

## UI-only result

The regular Codex application is not modified. The reversible state command writes a backup under `~/Library/Application Support/Codex Micro Lab/state-backups/`, sets the two Micro detection keys, and `ui restore` restores the original bytes and each file's mode. The user-visible Micro settings entry was confirmed in the regular Codex after enabling the state.

## Historical simulator/physical bridge result

The observations in this section were collected before the 2026-08-10 pairing and identity hardening. They establish that the input/RPC path worked, but they do not verify the current QR confirmation flow or the new bundle identity.

The corrected app installed and launched with the earlier local bundle identifier during the first PoC run. With the Mac bridge running, entering the pairing token and pressing Save produced a connected state and lighting receipt. Sending RGB and thread RPCs populated the app's ambient, key, and thread swatches. A tap on `AG00` produced press/release notifications (`act:1` and `act:0`); the dial produced `ENC_CLK` pulse; and a joystick drag produced `v.oai.rad` followed by `{a:0,d:0}` on release. Sending the app to the background removed the virtual device after the heartbeat timeout, and relaunching restored the connected state. A bridge telemetry update of 75% and charging was reflected by `device.status` as `battery:75` and `is_charging:true`. Manual token entry and Bonjour from that historical run are not present in the current source.

The same flow was previously repeated on the physical iPhone using the stable signed PoC build. `device.status` reported battery 50% and charging; `AG00`, `AG02`, and `ACT06` produced the expected press/release notifications; joystick movement produced repeated `v.oai.rad` frames and a final `{a:0,d:0}`; and encoder interaction produced `ENC_CC`/`ENC_CW` pulses. Locking the phone removed the physical controller from `device.list`; unlocking and returning to the app restored it. A `v.oai.rgbcfg` RPC with id 99 returned `{result:true}` and updated the bridge's lighting snapshot. That historical run did not use the current bundle identity or final hardened pairing flow.

The physical Debug BLE probe was also run through `devicectl` with the `--ble-probe` launch argument. CoreBluetooth reported `HID service rejected: CBErrorDomain Code=8` (`The specified UUID is not allowed for this operation`) for HID Service `0x1812`. This is evidence that the public iOS peripheral API does not provide the required direct HID path on this device; no direct BLE compatibility claim is made.

The current pairing code embeds only allowlisted non-global Mac IPv4 candidates and the WebSocket port. The iPhone tries those confirmed addresses directly and does not fall back to Bonjour. The app declares an explicit `UILaunchScreen`; without it, the iOS 26 runtime rendered the app in a letterboxed compatibility window with black bands at the top and bottom.

An interim direct-QR smoke test was performed before the final identity and pairing hardening over a user-controlled local tethering path. The bridge showed an established remote WebSocket client and the Codex-side monitor received an `AG02` press/release pair. This confirms the earlier local-only path reached the bridge, but it is not a physical verification of the current source. No observed network address is retained in this public log.

## Lab transport runtime result

The Lab transport wrapper is covered by an automated integration test: it is loaded with a mock outer service, connects to a temporary Unix bridge, returns the canonical `codex_micro` descriptor, completes `device.status` RPC with response id preservation, and emits both the numeric Work Louder connection event values (`CONNECTED=0`, `DISCONNECTED=1`) and the object-shaped device state used by the current Codex build. The generated Lab copy also passes `codesign --verify --deep --strict`.

The generated Lab copy was launched manually with an isolated temporary `--user-data-dir` while the regular Codex process remained untouched. A temporary WebSocket controller was paired to the shared bridge. The Lab primary window then exposed the official Micro settings entry with the accessibility label `Codex Micro が接続されています。設定を開く`; opening it showed `接続済み` and the full layout/customization controls. This is the direct desktop verification of the connected settings state.

The local screenshots from this check are intentionally excluded from the public repository because the customization dialog contains the user's installed skill inventory. The automated Lab wrapper test is the reproducible public evidence for this path.

The normal `node dist/src/cli.js lab launch` command still refuses to run beside the regular Codex process. The manual check used a separate temporary profile solely to avoid terminating this work session; no regular app files or user data were changed.

With the regular Codex process still running, `node dist/src/cli.js lab launch` exits with code 1 and the explicit safety message `Close Codex before changing Micro state or launching the Lab copy.` No process was forcibly terminated.

A final binary-only launch in a separate temporary HOME reached Electron but stopped at the macOS Keychain permission prompt for the Lab bundle's Storage Key; no password was entered automatically. The earlier isolated signed-in run remains the direct UI proof.

## Semantic bridge and layout result

The bridge publishes only sanitized `agent.snapshot` and `codex.state` data to iPhone/Web controllers. Layout and reasoning metadata remain local and are not sent over LAN. The Lab wrapper uses the `0600` Unix socket for renderer semantic traffic and Codex's existing `codex_desktop:message-for-view` channel for composer delivery; every renderer WebSocket role is rejected.

The bridge is a shared per-user service. Starting a second instance now probes the Unix socket and refuses to replace a live bridge; it no longer unlinks that socket or drops another thread's Codex transport. If two Codex windows overlap during reconnection, closing one only publishes `not-detected` after the last Codex transport has gone away.

Late replies to a client that has already closed are ignored on both Unix and WebSocket transports. The bridge checks writability/readiness before every send and catches the normal close race, so reconnecting one Lab window does not turn into an `EPIPE`/`Broken pipe` crash. The iPhone client also ignores stale `URLSessionWebSocketTask` callbacks from an older connection generation, preventing an old failure callback from tearing down a newer connection.

The iPhone Cockpit uses a fixed, circular four-sector geometry for the directional pad, anchors the input dock with SwiftUI `safeAreaInset`, and sends a joystick zero frame on release, disappearance, backgrounding, and disconnect. While dragging, a visible thumb knob and center-to-knob line make the input position explicit. `AG00`/`ACT06` identifiers and pairing tokens remain hidden from the primary screen; raw values are available only in diagnostics. The selected Agent is shown with a colored ring and one short semantic status line; the primary screen does not print protocol IDs. Unassigned command positions use a plus affordance so customization is discoverable without showing raw IDs. The settings sheet now mirrors direction, command, microphone, and encoder assignments from the official Codex Micro settings source rather than presenting a second local configuration. Scene lifecycle handling disconnects only on durable backgrounding, not on transient `.inactive` sheet/keyboard transitions, so opening text or voice input does not create an artificial reconnect.

The Lab copy sets `CFBundleDisplayName` and `CFBundleIdentifier` to `Codex Micro Lab` / `com.codexmicrolab.lab`, so macOS does not show it as a second indistinguishable ChatGPT app. The original `/Applications/ChatGPT.app` bundle and ASAR remain unchanged.

## Remaining manual checks

- Build/sign/install the new `io.github.42libft...` identity on a physical iPhone, confirm a current QR, and replay Agent, Flick Pad, encoder, voice/text, lighting, lock/background release, and reconnect actions. The helper deliberately does not launch the app automatically.
