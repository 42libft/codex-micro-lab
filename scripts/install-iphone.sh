#!/bin/zsh
set -euo pipefail
umask 077

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
project="$repo_dir/ios/CodexMicroLab.xcodeproj"
bundle_id="io.github.42libft.codex-micro-lab.iphone"
temp_root="$(mktemp -d -t codex-micro-lab.install)"
device_json="$temp_root/devices.json"
device_list_log="$temp_root/devicectl-list.log"
build_dir="$temp_root/DerivedData"
build_log="$temp_root/xcodebuild.log"
install_log="$temp_root/devicectl-install.log"

cleanup() {
  if [[ -n "${temp_root:-}" && -d "$temp_root" ]]; then
    rm -rf -- "$temp_root"
  fi
}
trap cleanup EXIT INT TERM HUP

if ! command -v jq >/dev/null 2>&1; then
  print -u2 "jq is required. Install it or run the Xcode scheme manually."
  exit 2
fi

redact_identifiers() {
  sed -E \
    -e 's/[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{16,32}/[device-id]/g' \
    -e 's/[0-9A-Fa-f]{24,40}/[identifier]/g'
}

confirm() {
  local prompt="$1"
  local answer=""
  [[ -t 0 ]] || return 1
  read "answer?$prompt [y/N] "
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}

: > "$device_json"
chmod 600 "$device_json"
if ! xcrun devicectl list devices --quiet --json-output "$device_json" >"$device_list_log" 2>&1; then
  print -u2 "Unable to enumerate paired iPhones. Sanitized diagnostics follow:"
  tail -40 "$device_list_log" | redact_identifiers >&2
  exit 3
fi
device_count="$(jq '[.result.devices[] | select(.hardwareProperties.reality == "physical" and .hardwareProperties.deviceType == "iPhone" and .connectionProperties.pairingState == "paired")] | length' "$device_json")"
if [[ "$device_count" -eq 0 ]]; then
  print -u2 "No paired physical iPhone was found. Connect and unlock one, pair it in Xcode, and enable Developer Mode."
  exit 3
fi

selection="${CODEX_MICRO_DEVICE_INDEX:-1}"
if [[ "$device_count" -gt 1 ]]; then
  print "Found $device_count paired physical iPhones. Device identifiers are intentionally hidden."
  jq -r '.result.devices[] | select(.hardwareProperties.reality == "physical" and .hardwareProperties.deviceType == "iPhone" and .connectionProperties.pairingState == "paired") | (.hardwareProperties.productType // "iPhone")' "$device_json" \
    | awk '{ print NR ") " $0 }'
  if [[ -z "${CODEX_MICRO_DEVICE_INDEX:-}" ]]; then
    if [[ ! -t 0 ]]; then
      print -u2 "Multiple iPhones require an interactive selection or CODEX_MICRO_DEVICE_INDEX=1..$device_count."
      exit 4
    fi
    read "selection?Select device number (1-$device_count): "
  fi
fi
if [[ "$selection" != <-> || "$selection" -lt 1 || "$selection" -gt "$device_count" ]]; then
  print -u2 "Device selection must be an integer from 1 through $device_count."
  exit 4
fi

device_udid="$(jq -r '.result.devices[] | select(.hardwareProperties.reality == "physical" and .hardwareProperties.deviceType == "iPhone" and .connectionProperties.pairingState == "paired") | .hardwareProperties.udid' "$device_json" | sed -n "${selection}p")"
if [[ -z "$device_udid" || "$device_udid" == "null" ]]; then
  print -u2 "The selected iPhone is missing a usable device identifier."
  exit 4
fi

team_args=()
team_id="${CODEX_MICRO_TEAM:-}"
if [[ -z "$team_id" ]]; then
  xcode_prefs="$HOME/Library/Preferences/com.apple.dt.Xcode.plist"
  if [[ -f "$xcode_prefs" ]]; then
    team_id="$(plutil -p "$xcode_prefs" 2>/dev/null | sed -n 's/.*"teamID" => "\([A-Z0-9]*\)".*/\1/p' | head -1)"
  fi
fi
if [[ -n "$team_id" ]]; then
  team_args+=("DEVELOPMENT_TEAM=$team_id")
fi

provisioning_args=()
if [[ "${CODEX_MICRO_ALLOW_PROVISIONING_UPDATES:-0}" == "1" ]] || confirm "Allow Xcode to contact Apple and update provisioning assets for this build?"; then
  provisioning_args+=("-allowProvisioningUpdates")
else
  print "Provisioning updates are disabled; Xcode may use only already-available signing assets."
fi

print "Building $bundle_id for the selected iPhone (identifier hidden)."
if ! xcodebuild \
  -quiet \
  -project "$project" \
  -scheme CodexMicroLab \
  -destination "id=$device_udid" \
  -sdk iphoneos \
  -configuration Debug \
  -derivedDataPath "$build_dir" \
  CODE_SIGN_STYLE=Automatic \
  "${provisioning_args[@]}" \
  "${team_args[@]}" \
  build >"$build_log" 2>&1; then
  print -u2 "Xcode build failed. Sanitized diagnostics follow:"
  tail -80 "$build_log" | redact_identifiers >&2
  exit 5
fi

app_path="$build_dir/Build/Products/Debug-iphoneos/CodexMicroLab.app"
if [[ ! -d "$app_path" ]]; then
  print -u2 "Xcode did not produce the expected CodexMicroLab.app."
  exit 5
fi

if [[ "${CODEX_MICRO_CONFIRM_INSTALL:-0}" != "1" ]] && ! confirm "Install the newly built app on the selected iPhone?"; then
  print "Install cancelled. No app was installed or launched."
  exit 0
fi

if ! xcrun devicectl device install app --quiet --device "$device_udid" "$app_path" >"$install_log" 2>&1; then
  print -u2 "Install failed. Sanitized diagnostics follow:"
  tail -80 "$install_log" | redact_identifiers >&2
  exit 6
fi
print "Installed Codex Micro Lab. The helper does not launch the app; open it manually after reviewing the install result."
