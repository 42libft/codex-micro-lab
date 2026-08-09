# Codex Micro Lab iPhone client

The iOS 17+ SwiftUI client connects to the Mac bridge only after scanning and confirming a validated pairing QR. The LAN path is authenticated but uses plain `ws://`; it has no TLS or end-to-end encryption. Use only a trusted LAN or your own Personal Hotspot, and never send sensitive text through the composer.

The bundle identifier is `io.github.42libft.codex-micro-lab.iphone`. This replaces the earlier prototype identifier. The namespace change creates a different app identity and Keychain service, so an existing prototype install must be reinstalled and paired again.

## Run from Xcode

1. Start the Mac side with `node dist/src/cli.js start` and leave that terminal open. The command opens a loopback Web controller without printing the bearer token.
2. Open `../CodexMicroLab.xcodeproj` in Xcode.
3. Add your Apple Account and choose your own Team under Signing & Capabilities. The repository contains no development team ID, provisioning profile, certificate, or signing key.
4. Connect and unlock the iPhone, trust the Mac if prompted, and enable **Settings → Privacy & Security → Developer Mode**.
5. Select the physical iPhone and press Run.
6. Allow Local Network and camera access. Tap **QRを読み取る**, scan the QR, verify the allowlisted IP addresses and port shown by the app, then confirm the connection.

The scanner accepts only `codexmicro://pair#<payload>`. The decoded payload must contain version `1`, a 32-character hexadecimal token, one to eight allowlisted non-global IPv4 addresses, and a port from `1024` through `65535`. Raw token QR codes, query-string tokens, arbitrary URLs, public addresses, and unsupported versions are rejected.

Bonjour discovery is disabled. The app reconnects only to the allowlisted non-global IP addresses saved from the confirmed QR. Scan a new QR after the Mac's network address changes.

## Install helper

After choosing an Apple Account and Team once in Xcode, run:

```sh
npm run ios:install
```

The helper:

- creates its inventory, build, and diagnostic files under a `0700` temporary directory with a `077` umask and removes them with a trap;
- never prints the selected device identifier and asks for a selection when more than one paired iPhone exists;
- asks before adding `-allowProvisioningUpdates`;
- asks again before installing the built app;
- installs with quiet output and sanitized failure diagnostics;
- does not launch the app.

For an intentional non-interactive run, `CODEX_MICRO_DEVICE_INDEX`, `CODEX_MICRO_ALLOW_PROVISIONING_UPDATES=1`, and `CODEX_MICRO_CONFIRM_INSTALL=1` provide the corresponding explicit choices. `CODEX_MICRO_TEAM` may select a Team without storing it in the repository.

If signing reaches `CodeSign` and waits, review the Keychain prompt yourself. The project never supplies a Keychain password automatically.

## Runtime behavior

The app is foreground-only. Locking the device or moving the app to the background releases held keys, sends joystick zero, and disconnects. Returning to the foreground reconnects to the saved QR addresses. If none responds, scan and confirm a new QR; the app does not discover or trust a replacement bridge automatically.

The app sends high-level Agent Key, Command Key, dial, joystick, telemetry, and optional composer text. It does not send `identifierForVendor` or another persistent device ID. LAN snapshots contain only slot number, coarse status, selection, and color; task titles, thread keys, skill/command names, layout assignments, and reasoning labels are not received.

The Debug-only `BLEHidProbe` tests whether iOS accepts HID Service `0x1812`. A successful GATT registration alone would not prove Codex compatibility; macOS enumeration and an unmodified Codex RPC round trip are also required.
