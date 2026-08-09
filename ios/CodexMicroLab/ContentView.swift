import AVFoundation
import Foundation
import Speech
import SwiftUI

/// The iPhone surface is intentionally a cockpit, not a miniature copy of the
/// physical Micro. Most labels are available through VoiceOver; the visual
/// surface stays quiet so a thumb can find the directional pad and input dock.
struct ContentView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @State private var showScanner = false
    @State private var showSettings = false
    @State private var showDiagnostics = false
    @State private var showComposer = false
    @State private var composerMode: ComposerMode = .text
    @State private var draft = ""
    @State private var pairingAlert: PairingAlert?
    @StateObject private var voiceInput = VoiceInputController()

    var body: some View {
        Group {
            if bridge.hasPairingToken {
                RedesignedCockpitView(
                    bridge: bridge,
                    onSettings: { showSettings = true },
                    onTextInput: {
                        composerMode = .text
                        showComposer = true
                    },
                    onVoiceInput: {
                        composerMode = .voice
                        showComposer = true
                    }
                )
            } else {
                PairingView(
                    showScanner: $showScanner,
                    bridge: bridge
                )
            }
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView { code in
                showScanner = false
                do {
                    pairingAlert = .confirmation(try PairingPayload(qrCode: code))
                } catch {
                    pairingAlert = .error(error.localizedDescription)
                }
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet(bridge: bridge, onDiagnostics: {
                showSettings = false
                showDiagnostics = true
            }, onPairAgain: {
                showSettings = false
                bridge.clearPairingToken()
            })
        }
        .sheet(isPresented: $showDiagnostics) {
            DiagnosticsSheet(bridge: bridge)
        }
        .sheet(isPresented: $showComposer) {
            ComposerSheet(
                bridge: bridge,
                mode: $composerMode,
                draft: $draft,
                voiceInput: voiceInput
            )
        }
        .alert(item: $pairingAlert) { alert in
            switch alert {
            case .confirmation(let payload):
                return Alert(
                    title: Text("このMacに接続しますか？"),
                    message: Text(payload.confirmationSummary),
                    primaryButton: .default(Text("接続")) { bridge.setPairing(payload) },
                    secondaryButton: .cancel(Text("キャンセル"))
                )
            case .error(let message):
                return Alert(title: Text("QRを使用できません"), message: Text(message), dismissButton: .default(Text("閉じる")))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private enum PairingAlert: Identifiable {
    case confirmation(PairingPayload)
    case error(String)

    var id: String {
        switch self {
        case .confirmation(let payload): return payload.id.uuidString
        case .error(let message): return "error:\(message)"
        }
    }
}

private struct PairingView: View {
    @Binding var showScanner: Bool
    @ObservedObject var bridge: BridgeClient

    var body: some View {
        ZStack {
            MicroBackground()
            VStack(spacing: 22) {
                Spacer()
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 54, weight: .light))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text("Micro")
                    .font(.system(size: 32, weight: .semibold, design: .rounded))
                Text("MacのQRを読み取って開始")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button {
                    showScanner = true
                } label: {
                    Label("QRを読み取る", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(MicroPrimaryButtonStyle())
                .accessibilityIdentifier("pairingScanButton")
                Spacer()
                Text("接続前にallowlist済みIPとポートを確認します。QR以外の文字列やURLは受け付けません。")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct CockpitView: View {
    @ObservedObject var bridge: BridgeClient
    let onSettings: () -> Void
    let onTextInput: () -> Void
    let onVoiceInput: () -> Void

    @State private var selectedAgent = 0
    @State private var reasoningIndex = 2
    @State private var lastAction = ""
    @State private var pendingDirection: Direction?
    @State private var resetTask: Task<Void, Never>?
    @State private var releaseTasks: [String: Task<Void, Never>] = [:]

    private let agentSymbols = ["cube", "magnifyingglass", "hammer", "checkmark.seal", "waveform", "doc.text"]
    private let fallbackColors: [Color] = [.blue, .purple, .green, .orange, .teal, .indigo]

    var body: some View {
        ZStack {
            MicroBackground()
            GeometryReader { proxy in
                let padSize = min(proxy.size.width - 36, max(220, proxy.size.height * 0.43))
                VStack(spacing: 0) {
                    header
                    agentStrip
                        .frame(height: 58)
                    DirectionalPad(
                        isEnabled: bridge.isConnected,
                        directionNames: directionNames,
                        onCommit: commit(direction:),
                        onCancel: { pendingDirection = nil }
                    )
                    .frame(width: padSize, height: padSize)
                    .accessibilityElement(children: .contain)
                    Spacer(minLength: 6)
                    reasoningRail
                    inputDock
                    actionStatus
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .padding(.horizontal, 18)
                .safeAreaPadding(.top, 8)
                .safeAreaPadding(.bottom, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onDisappear {
            resetTask?.cancel()
            releaseTasks.values.forEach { $0.cancel() }
            releaseTasks.removeAll()
            bridge.sendJoystick(angle: 0, distance: 0)
            releaseAllPresses()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(bridge.isConnected ? Color.green : Color.orange)
                    .frame(width: 9, height: 9)
                Text("Micro")
                    .font(.headline.weight(.semibold))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(bridge.isConnected ? "Micro、接続中" : "Micro、再接続中")
            Spacer()
            HStack(spacing: 5) {
                Circle().fill(bridge.isConnected ? Color.green : Color.secondary).frame(width: 6, height: 6)
                Circle().fill(bridge.isConnected ? Color.green.opacity(0.65) : Color.secondary.opacity(0.45)).frame(width: 6, height: 6)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(.thinMaterial, in: Capsule())
            .accessibilityLabel(bridge.isConnected ? "iPhoneとMacとCodexが接続中" : "Codexへの接続を確認中")
            Button(action: onSettings) {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settingsButton")
            .accessibilityLabel("カスタマイズと設定")
        }
        .foregroundStyle(.primary)
    }

    private var agentStrip: some View {
        HStack(spacing: 9) {
            ForEach(0..<6, id: \.self) { index in
                let snapshot = bridge.agents.first(where: { $0.id == index })
                AgentOrb(
                    id: index,
                    symbol: agentSymbols[index],
                    color: color(for: index),
                    isSelected: snapshot?.selected ?? (selectedAgent == index),
                    isEnabled: bridge.isConnected,
                    title: snapshot?.title,
                    status: snapshot?.status ?? "idle"
                ) {
                    selectAgent(index)
                }
            }
        }
        .padding(.top, 16)
        .accessibilityElement(children: .contain)
    }

    private var reasoningRail: some View {
        HStack(spacing: 10) {
            Image(systemName: "brain.head.profile")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
            if let mode = bridge.layout?.encoderMode {
                Text(encoderModeName(mode))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            ForEach(0..<5, id: \.self) { index in
                Button {
                    changeReasoning(to: index)
                } label: {
                    Circle()
                        .fill(index == effectiveReasoningIndex ? Color.accentColor : Color.secondary.opacity(0.22))
                        .frame(width: index == effectiveReasoningIndex ? 12 : 8, height: index == effectiveReasoningIndex ? 12 : 8)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .disabled(!reasoningAvailable)
                .accessibilityLabel(reasoningAvailable ? "推論レベル \(index + 1)" : "推論レベル未取得")
                .accessibilityAddTraits(index == effectiveReasoningIndex ? .isSelected : [])
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 34)
        .background(.thinMaterial, in: Capsule())
        .opacity(reasoningAvailable ? 1 : 0.55)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(reasoningAvailable ? "推論レベル" : "推論レベル未取得")
    }

    private var inputDock: some View {
        VStack(spacing: 7) {
            HStack(spacing: 8) {
                DockIconButton(systemImage: "keyboard", accessibilityLabel: "テキスト入力", isEnabled: true, action: onTextInput)
                    .accessibilityIdentifier("textInputButton")
                DockIconButton(systemImage: "waveform", accessibilityLabel: "音声入力", isEnabled: true, action: onVoiceInput)
                    .accessibilityIdentifier("voiceComposerButton")
            }
            .frame(height: 44)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(commandKeys, id: \.self) { key in
                        commandSlot(for: key)
                    }
                }
                .padding(.horizontal, 2)
            }
            .scrollClipDisabled()
        }
        .padding(7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.secondary.opacity(0.12)))
        .padding(.top, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("テキスト、音声、Microスイッチ")
    }

    private let commandKeys = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"]

    @ViewBuilder
    private func commandSlot(for key: String) -> some View {
        let assigned = bridge.layout?.actionKeys[key]
        let label = assigned ?? "未割当"
        let enabled = bridge.isConnected && assigned != nil
        // Keep the seven physical positions discoverable without squeezing
        // them into unreadable equal-width columns. The row is intentionally
        // horizontally scrollable on compact iPhones; each switch remains a
        // comfortable thumb target and its meaning is still visible.
        let slotWidth: CGFloat = 46
        if key == "ACT10" {
            HoldIconButton(
                systemImage: commandSymbol(for: key, label: label),
                accessibilityLabel: enabled ? "\(label)を長押し" : "マイクキー未割当",
                isEnabled: enabled,
                onDown: { bridge.sendKey(key, action: 1); lastAction = "送信中" },
                onUp: { bridge.sendKey(key, action: 0); lastAction = label }
            )
            .accessibilityIdentifier(key == "ACT10" ? "voiceInputButton" : "command-\(key)")
            .frame(width: slotWidth)
            .overlay(alignment: .bottom) { Text(shortCommandLabel(label)).font(.system(size: 9, weight: .medium)).lineLimit(1).minimumScaleFactor(0.75).padding(.bottom, 3) }
        } else {
            DockIconButton(
                systemImage: commandSymbol(for: key, label: label),
                accessibilityLabel: enabled ? label : "未割当",
                isEnabled: enabled
            ) {
                bridge.pulse(key)
                lastAction = "送信中"
            }
            .accessibilityIdentifier("command-\(key)")
            .frame(width: slotWidth)
            .overlay(alignment: .bottom) { Text(shortCommandLabel(label)).font(.system(size: 9, weight: .medium)).lineLimit(1).minimumScaleFactor(0.75).padding(.bottom, 3) }
        }
    }

    private func commandSymbol(for key: String, label: String) -> String {
        let lower = label.lowercased()
        if key == "ACT10" || lower.contains("音声") || lower.contains("マイク") { return "mic.fill" }
        if lower.contains("承認") || lower.contains("approve") { return "checkmark" }
        if lower.contains("却下") || lower.contains("reject") { return "xmark" }
        if lower.contains("新規") || lower.contains("new") { return "plus" }
        if lower.contains("会話") || lower.contains("chat") { return "bubble.left" }
        return "circle.dotted"
    }

    private func shortCommandLabel(_ label: String) -> String {
        guard label != "未割当" else { return "—" }
        let compact = label.replacingOccurrences(of: " ", with: "")
        return compact.count > 5 ? String(compact.prefix(5)) + "…" : compact
    }

    private var actionStatus: some View {
        let ackText: String = {
            switch bridge.lastAck?.state {
            case "codex-delivered", "confirmed": return "Codexへ届きました"
            case "unavailable": return "利用不可"
            case "failed": return "送信失敗"
            default: return lastAction
            }
        }()
        return HStack(spacing: 6) {
            Circle().fill(ackText.isEmpty ? Color.secondary.opacity(0.25) : Color.accentColor).frame(width: 5, height: 5)
            Text(ackText.isEmpty ? (bridge.isConnected ? "" : "接続を確認中") : ackText)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(height: 18)
        .opacity(ackText.isEmpty && bridge.isConnected ? 0 : 1)
        .accessibilityHidden(ackText.isEmpty && bridge.isConnected)
    }

    private var directionNames: [Direction: String] {
        guard let layout = bridge.layout else { return [:] }
        let semantic: [Direction: String] = [
            .up: layout.analogStick["up"] ?? nil,
            .right: layout.analogStick["right"] ?? nil,
            .down: layout.analogStick["down"] ?? nil,
            .left: layout.analogStick["left"] ?? nil
        ].compactMapValues { $0 }
        return semantic
    }

    private var reasoningAvailable: Bool {
        guard let reasoning = bridge.reasoning else { return false }
        return reasoning.available && reasoning.current != nil
    }

    private func encoderModeName(_ value: String) -> String {
        switch value {
        case "reasoning": return "推論"
        case "conversation-scroll": return "スクロール"
        case "composer-navigation": return "入力欄"
        case "custom": return "カスタム"
        default: return "ノブ"
        }
    }

    private func commandLabel(for key: String, fallback: String) -> String {
        bridge.layout?.actionKeys[key] ?? fallback
    }

    private var effectiveReasoningIndex: Int? {
        guard reasoningAvailable else { return nil }
        return bridge.reasoning?.current ?? reasoningIndex
    }

    private func color(for index: Int) -> Color {
        if let rgb = bridge.agents.first(where: { $0.id == index })?.rgb { return Color(microRGB: rgb) }
        let key = "AG0\(index)"
        guard let keys = bridge.lighting["keys"] as? [String: Any], let raw = keys[key] as? [String: Any], let number = raw["c"] as? NSNumber else {
            return fallbackColors[index]
        }
        return Color(microRGB: number.intValue)
    }

    private func selectAgent(_ index: Int) {
        guard bridge.isConnected else { return }
        selectedAgent = index
        let key = "AG0\(index)"
        releaseTasks[key]?.cancel()
        bridge.sendKey(key, action: 1, agent: index)
        releaseTasks[key] = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            bridge.sendKey("AG0\(index)", action: 0, agent: index)
            releaseTasks[key] = nil
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        lastAction = "送信中"
    }

    private func commit(direction: Direction) {
        guard bridge.isConnected else { return }
        pendingDirection = direction
        bridge.sendJoystick(angle: direction.angle, distance: 1)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        lastAction = "送信中"
        resetTask?.cancel()
        resetTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            bridge.sendJoystick(angle: 0, distance: 0)
            pendingDirection = nil
        }
    }

    private func changeReasoning(to value: Int) {
        guard bridge.isConnected else { return }
        guard let current = effectiveReasoningIndex else { return }
        let delta = value - current
        guard delta != 0 else { return }
        let key = delta > 0 ? "ENC_CW" : "ENC_CC"
        for step in 0..<abs(delta) {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(90 * step))
                bridge.pulse(key)
            }
        }
        lastAction = "送信中"
    }

    private func releaseAllPresses() {
        releaseTasks.values.forEach { $0.cancel() }
        releaseTasks.removeAll()
        for index in 0..<6 { bridge.sendKey("AG0\(index)", action: 0, agent: index) }
        bridge.sendKey("ACT06", action: 0)
        bridge.sendKey("ACT07", action: 0)
        bridge.sendKey("ACT08", action: 0)
        bridge.sendKey("ACT09", action: 0)
        bridge.sendKey("ACT10", action: 0)
        bridge.sendKey("ACT11", action: 0)
        bridge.sendKey("ACT12", action: 0)
        bridge.sendJoystick(angle: 0, distance: 0)
    }
}

private struct AgentOrb: View {
    let id: Int
    let symbol: String
    let color: Color
    let isSelected: Bool
    let isEnabled: Bool
    let title: String?
    let status: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(isEnabled ? color : .secondary)
                    .frame(width: 43, height: 43)
                    .background(.thinMaterial, in: Circle())
                    .overlay(Circle().stroke(isSelected ? color : .secondary.opacity(0.16), lineWidth: isSelected ? 2 : 1))
                Circle()
                    .fill(isEnabled ? color : Color.secondary.opacity(0.22))
                    .frame(width: 7, height: 7)
                    .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5))
                    .offset(x: 1, y: 1)
            }
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("agent-\(id)")
        .accessibilityLabel(title ?? "Agent")
        .accessibilityValue("\(statusName(status))、\(isSelected ? "選択中" : "待機")")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func statusName(_ value: String) -> String {
        switch value {
        case "working": return "作業中"
        case "awaiting-approval": return "承認待ち"
        case "awaiting-response": return "応答待ち"
        case "unread": return "未読"
        case "error": return "エラー"
        case "off": return "未割当"
        default: return "待機"
        }
    }
}

private enum Direction: String, CaseIterable, Hashable {
    case up, right, down, left

    var symbol: String {
        switch self {
        case .up: return "arrow.up"
        case .right: return "arrow.right"
        case .down: return "arrow.down"
        case .left: return "arrow.left"
        }
    }

    var accessibilityName: String {
        switch self {
        case .up: return "上"
        case .right: return "右"
        case .down: return "下"
        case .left: return "左"
        }
    }

    var angle: Double {
        switch self {
        case .up: return .pi / 2
        case .right: return 0
        case .down: return -.pi / 2
        case .left: return .pi
        }
    }

    static var defaultNames: [Direction: String] { [.up: "計画", .right: "実行", .down: "整理", .left: "レビュー"] }
}

private struct DirectionalPad: View {
    let isEnabled: Bool
    let directionNames: [Direction: String]
    let onCommit: (Direction) -> Void
    let onCancel: () -> Void
    @State private var activeDirection: Direction?
    @State private var dragPoint: CGPoint = .zero

    var body: some View {
        GeometryReader { proxy in
            let diameter = min(proxy.size.width, proxy.size.height)
            let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
            let radius = diameter / 2 - 2
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .overlay(Circle().stroke(.secondary.opacity(0.14), lineWidth: 1))
                ForEach(Direction.allCases, id: \.self) { direction in
                    DirectionWedge(direction: direction)
                        .fill(activeDirection == direction ? Color.accentColor.opacity(0.2) : Color.clear)
                        .overlay(DirectionWedge(direction: direction).stroke(.secondary.opacity(0.10), lineWidth: 1))
                }
                ForEach(Direction.allCases, id: \.self) { direction in
                    VStack(spacing: 5) {
                        Image(systemName: direction.symbol)
                            .font(.system(size: 23, weight: .medium))
                        Text(directionNames[direction] ?? "未取得")
                            .font(.caption2.weight(.medium))
                            .opacity(activeDirection == direction ? 1 : 0.65)
                    }
                    .foregroundStyle(activeDirection == direction ? Color.accentColor : Color.primary)
                    .position(position(for: direction, center: center, radius: radius * 0.55))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(directionNames[direction] ?? "方向の割り当て未取得")
                    .accessibilityHint(directionNames[direction] == nil ? "割り当てを取得できません" : "フリックで実行")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("direction-\(direction.rawValue)")
                }
                Circle()
                    .fill(.regularMaterial)
                    .frame(width: diameter * 0.27, height: diameter * 0.27)
                    .overlay(Circle().stroke(.secondary.opacity(0.16), lineWidth: 1))
                    .overlay(Image(systemName: activeDirection == nil ? "circle.dotted" : "xmark")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(.secondary))
                    .accessibilityLabel("中央でキャンセル")
                if dragPoint != .zero {
                    Circle()
                        .fill(Color.accentColor.opacity(0.16))
                        .frame(width: 44, height: 44)
                        .position(x: center.x + dragPoint.x, y: center.y + dragPoint.y)
                        .allowsHitTesting(false)
                }
            }
            .frame(width: diameter, height: diameter)
            .opacity(isEnabled ? 1 : 0.46)
            .contentShape(Circle())
            .gesture(dragGesture(center: center, radius: radius))
            .accessibilityLabel("方向パッド")
            .accessibilityHint(isEnabled ? "方向へフリックしてワークフローを起動" : "接続すると操作できます")
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }

    private func dragGesture(center: CGPoint, radius: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard isEnabled else { return }
                let dx = value.location.x - center.x
                let dy = value.location.y - center.y
                let distance = hypot(dx, dy)
                let maxDistance = radius * 0.72
                let scale = min(1, maxDistance / max(distance, 1))
                dragPoint = CGPoint(x: dx * scale, y: dy * scale)
                let next = direction(for: dx, dy: dy, distance: distance, maxDistance: maxDistance)
                if next != activeDirection, next != nil {
                    UISelectionFeedbackGenerator().selectionChanged()
                }
                activeDirection = next
            }
            .onEnded { _ in
                guard isEnabled else { return }
                let result = activeDirection
                activeDirection = nil
                dragPoint = .zero
                if let result { onCommit(result) } else { onCancel() }
            }
    }

    private func direction(for dx: CGFloat, dy: CGFloat, distance: CGFloat, maxDistance: CGFloat) -> Direction? {
        switch MicroInputSafety.direction(dx: dx, dy: dy, distance: distance, maxDistance: maxDistance) {
        case .up: return .up
        case .right: return .right
        case .down: return .down
        case .left: return .left
        case nil: return nil
        }
    }

    private func position(for direction: Direction, center: CGPoint, radius: CGFloat) -> CGPoint {
        switch direction {
        case .up: return CGPoint(x: center.x, y: center.y - radius)
        case .right: return CGPoint(x: center.x + radius, y: center.y)
        case .down: return CGPoint(x: center.x, y: center.y + radius)
        case .left: return CGPoint(x: center.x - radius, y: center.y)
        }
    }
}

private struct DirectionWedge: Shape {
    let direction: Direction

    func path(in rect: CGRect) -> Path {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        let range: (Double, Double)
        switch direction {
        case .up: range = (-135, -45)
        case .right: range = (-45, 45)
        case .down: range = (45, 135)
        case .left: range = (135, 225)
        }
        var path = Path()
        path.move(to: center)
        path.addArc(center: center, radius: radius, startAngle: .degrees(range.0), endAngle: .degrees(range.1), clockwise: false)
        path.closeSubpath()
        return path
    }
}

private struct DockIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: { if isEnabled { action() } }) {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .medium))
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .foregroundStyle(isEnabled ? .primary : .secondary)
        }
        .buttonStyle(.plain)
        .background(isEnabled ? Color.primary.opacity(0.05) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .opacity(isEnabled ? 1 : 0.42)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct HoldIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let isEnabled: Bool
    let onDown: () -> Void
    let onUp: () -> Void
    @State private var pressed = false

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 19, weight: .medium))
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .foregroundStyle(pressed ? Color.accentColor : (isEnabled ? .primary : .secondary))
            .background(pressed ? Color.accentColor.opacity(0.13) : Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(isEnabled ? 1 : 0.42)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard isEnabled, !pressed else { return }
                        pressed = true
                        onDown()
                    }
                    .onEnded { _ in
                        guard pressed else { return }
                        pressed = false
                        onUp()
                    }
            )
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(pressed ? "入力中" : "待機")
    }
}

private struct SettingsSheet: View {
    @ObservedObject var bridge: BridgeClient
    let onDiagnostics: () -> Void
    let onPairAgain: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Circle().fill(bridge.isConnected ? Color.green : Color.orange).frame(width: 8, height: 8)
                        Text(connectionSummary)
                        Spacer()
                        Text(bridge.transport).foregroundStyle(.secondary)
                    }
                    Label("割り当てはMacのCodex Micro設定と同期", systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("settingsAuthoritativeNote")
                }
                Section("方向") {
                    AssignmentRow(title: "上", symbol: "arrow.up", value: bridge.layout?.analogStick["up"] ?? nil)
                    AssignmentRow(title: "右", symbol: "arrow.right", value: bridge.layout?.analogStick["right"] ?? nil)
                    AssignmentRow(title: "下", symbol: "arrow.down", value: bridge.layout?.analogStick["down"] ?? nil)
                    AssignmentRow(title: "左", symbol: "arrow.left", value: bridge.layout?.analogStick["left"] ?? nil)
                }
                Section("コマンド") {
                    AssignmentRow(title: "キー1", symbol: "square.grid.2x2", value: bridge.layout?.actionKeys["ACT06"] ?? nil)
                    AssignmentRow(title: "キー2", symbol: "square.grid.2x2", value: bridge.layout?.actionKeys["ACT07"] ?? nil)
                    AssignmentRow(title: "キー3", symbol: "square.grid.2x2", value: bridge.layout?.actionKeys["ACT08"] ?? nil)
                    AssignmentRow(title: "キー4", symbol: "square.grid.2x2", value: bridge.layout?.actionKeys["ACT09"] ?? nil)
                    AssignmentRow(title: "マイク", symbol: "mic", value: bridge.layout?.actionKeys["ACT10"] ?? bridge.layout?.microphoneMode.map { $0 == "ptt" ? "音声入力" : $0 })
                    AssignmentRow(title: "キー6", symbol: "square.grid.2x2", value: bridge.layout?.actionKeys["ACT11"] ?? nil)
                    AssignmentRow(title: "キー7", symbol: "square.grid.2x2", value: bridge.layout?.actionKeys["ACT12"] ?? nil)
                }
                Section("ダイヤル") {
                    AssignmentRow(title: "左回転", symbol: "rotate.left", value: bridge.layout?.encoder["left"] ?? nil)
                    AssignmentRow(title: "クリック", symbol: "circle.dotted", value: bridge.layout?.encoder["click"] ?? nil)
                    AssignmentRow(title: "右回転", symbol: "rotate.right", value: bridge.layout?.encoder["right"] ?? nil)
                    if let mode = bridge.layout?.encoderMode {
                        LabeledContent("モード", value: encoderModeName(mode))
                    }
                }
                Section {
                    Text("割り当てを変更すると、次回の同期でこの画面にも反映されます")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("入力") {
                    Label("音声入力はマイクを長押し", systemImage: "mic")
                    Label("テキスト入力はキーボード", systemImage: "keyboard")
                }
                Section {
                    Button(action: onDiagnostics) {
                        Label("診断", systemImage: "stethoscope")
                    }
                    Button(role: .destructive, action: onPairAgain) {
                        Label("再ペアリング", systemImage: "qrcode.viewfinder")
                    }
                }
            }
            .navigationTitle("カスタマイズ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完了") { dismiss() } } }
        }
    }

    private var connectionSummary: String {
        switch bridge.phase {
        case .failed: return "認証が無効"
        case .codexConnected: return "接続中"
        case .bridgeConnected: return "Codex待機中"
        case .unpaired: return "未ペアリング"
        default: return "再接続中"
        }
    }

    private func encoderModeName(_ value: String) -> String {
        switch value {
        case "reasoning": return "推論"
        case "conversation-scroll": return "会話スクロール"
        case "composer-navigation": return "入力欄の移動"
        case "custom": return "カスタム"
        default: return value
        }
    }
}

private struct DiagnosticsSheet: View {
    @ObservedObject var bridge: BridgeClient
    @Environment(\.dismiss) private var dismiss

    private var rawLighting: String {
        String(describing: bridge.lighting)
    }

    var body: some View {
        NavigationStack {
            List {
                Section("接続") {
                    LabeledContent("状態", value: bridge.phase.rawValue)
                    LabeledContent("transport", value: bridge.transport)
                    LabeledContent("Codex", value: bridge.codexConnected ? "connected" : "not-detected")
                    LabeledContent("最終メッセージ", value: bridge.lastMessageAt.map(Self.formatDate) ?? "—")
                    LabeledContent("heartbeat", value: bridge.lastHeartbeatAt.map(Self.formatDate) ?? "—")
                    LabeledContent("最終RPC", value: bridge.lastRpcSummary ?? "—")
                }
                Section("端末") {
                    LabeledContent("battery", value: bridge.battery.map { "\($0)%" } ?? "—")
                    LabeledContent("充電", value: bridge.isCharging ? "yes" : "no")
                }
                Section("最後の応答") {
                    if let ack = bridge.lastAck {
                        LabeledContent("event", value: ack.eventId)
                        LabeledContent("state", value: ack.state)
                        LabeledContent("type", value: ack.inputType)
                        if let reason = ack.reason { LabeledContent("reason", value: reason) }
                    } else {
                        Text("まだ入力応答はありません")
                            .foregroundStyle(.secondary)
                    }
                }
                Section("照明 snapshot") {
                    Text(rawLighting)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
#if DEBUG
                Section("実験") {
                    NavigationLink("BLE HID実験") { BLEDiagnosticsView() }
                }
#endif
            }
            .navigationTitle("診断")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完了") { dismiss() } } }
        }
    }

    private static func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }
}

private struct AssignmentRow: View {
    let title: String
    let symbol: String
    let value: String?

    var body: some View {
        HStack {
            Label(title, systemImage: symbol)
            Spacer()
            Text(value ?? "未取得")
                .foregroundStyle(value == nil ? .secondary : .primary)
        }
    }
}

#if DEBUG
private struct BLEDiagnosticsView: View {
    @StateObject private var probe = BLEHidProbe()

    var body: some View {
        Form {
            Button("実験を開始") { probe.start() }
            Text(probe.status).font(.footnote).foregroundStyle(.secondary)
        }
        .navigationTitle("BLE HID")
    }
}
#endif

private enum ComposerMode: String, CaseIterable {
    case text, voice
}

private struct ComposerSheet: View {
    @ObservedObject var bridge: BridgeClient
    @Binding var mode: ComposerMode
    @Binding var draft: String
    @ObservedObject var voiceInput: VoiceInputController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Label("LAN通信はTLS/E2E暗号化されません。機密情報は送信しないでください。", systemImage: "lock.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                Picker("入力方法", selection: $mode) {
                    Label("テキスト", systemImage: "keyboard").tag(ComposerMode.text)
                    Label("音声", systemImage: "mic.fill").tag(ComposerMode.voice)
                }
                .pickerStyle(.segmented)
                if mode == .text {
                    TextEditor(text: $draft)
                        .scrollContentBackground(.hidden)
                        .padding(12)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(alignment: .topLeading) {
                            if draft.isEmpty { Text("入力…").foregroundStyle(.tertiary).padding(17) }
                        }
                    Button {
                        bridge.sendText(draft)
                        dismiss()
                    } label: {
                        Label("送信", systemImage: "arrow.up.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(MicroPrimaryButtonStyle())
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !bridge.isConnected)
                } else {
                    VStack(spacing: 18) {
                        Image(systemName: voiceInput.isRecording ? "waveform" : "mic.circle")
                            .font(.system(size: 56, weight: .light))
                            .foregroundStyle(voiceInput.isRecording ? Color.red : Color.accentColor)
                            .symbolEffect(.pulse, isActive: voiceInput.isRecording)
                        Text(voiceInput.transcript.isEmpty ? "マイクをタップ" : voiceInput.transcript)
                            .font(.body)
                            .foregroundStyle(voiceInput.transcript.isEmpty ? .secondary : .primary)
                            .multilineTextAlignment(.center)
                            .frame(minHeight: 70)
                        Button {
                            if voiceInput.isRecording {
                                voiceInput.stop()
                            } else {
                                voiceInput.start()
                            }
                        } label: {
                            Image(systemName: voiceInput.isRecording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 24, weight: .medium))
                                .frame(width: 72, height: 72)
                                .foregroundStyle(.white)
                                .background(voiceInput.isRecording ? Color.red : Color.accentColor, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(voiceInput.isRecording ? "音声入力を停止" : "音声入力を開始")
                        if !voiceInput.transcript.isEmpty {
                            Button {
                                bridge.sendText(voiceInput.transcript)
                                voiceInput.stop()
                                dismiss()
                            } label: {
                                Label("送信", systemImage: "arrow.up.circle.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(MicroPrimaryButtonStyle())
                            .disabled(!bridge.isConnected)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("入力")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { voiceInput.stop(); dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

@MainActor
private final class VoiceInputController: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var transcript = ""

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ja-JP"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func start() {
        guard !isRecording else { return }
        transcript = ""
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard status == .authorized else { return }
                self?.beginRecording()
            }
        }
    }

    func stop() {
        guard isRecording else { return }
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        isRecording = false
    }

    private func beginRecording() {
        guard let recognizer, recognizer.isAvailable else { return }
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
            let request = SFSpeechAudioBufferRecognitionRequest()
            self.request = request
            let inputNode = audioEngine.inputNode
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputNode.outputFormat(forBus: 0)) { [weak self] buffer, _ in
                self?.request?.append(buffer)
            }
            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    if let result { self?.transcript = result.bestTranscription.formattedString }
                    if error != nil { self?.stop() }
                }
            }
        } catch {
            stop()
        }
    }
}

private struct MicroPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.vertical, 13)
            .background(Color.accentColor.opacity(configuration.isPressed ? 0.78 : 1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

private struct MicroSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity)
            .background(Color(uiColor: .secondarySystemBackground).opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct MicroBackground: View {
    var body: some View {
        Color(uiColor: .systemGroupedBackground)
            .ignoresSafeArea()
    }
}

extension Color {
    init(microRGB value: Int) {
        self.init(
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255
        )
    }
}

// MARK: - Compact thumb cockpit

/// The redesigned cockpit keeps the Micro's four-way gesture model, but gives
/// it a circular thumb surface with one visible target per direction. The
/// gesture center stays aligned with the visual center and leaves room for the
/// two real inputs: text and voice.
private struct RedesignedCockpitView: View {
    @ObservedObject var bridge: BridgeClient
    let onSettings: () -> Void
    let onTextInput: () -> Void
    let onVoiceInput: () -> Void

    @State private var selectedAgent = 0
    @State private var lastAction = ""
    @State private var pendingDirection: Direction?
    @State private var resetTask: Task<Void, Never>?
    @State private var releaseTasks: [String: Task<Void, Never>] = [:]

    private let agentSymbols = ["cube", "magnifyingglass", "hammer", "checkmark.seal", "waveform", "doc.text"]
    private let fallbackColors: [Color] = [.blue, .purple, .green, .orange, .teal, .indigo]
    private let commandKeys = ["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"]

    var body: some View {
        ZStack {
            MicroBackground()
            GeometryReader { proxy in
                // Keep the primary surface in the thumb's visual field. The
                // previous version vertically centred the pad in the area
                // above the dock, which left a large dead band on 390x844.
                // A capped size also prevents the pad from becoming a giant
                // target on Max devices.
                let padSize = min(proxy.size.width - 54, 292, max(246, proxy.size.height * 0.50))
                VStack(spacing: 0) {
                    header
                    agentStrip.padding(.top, 10)
                    activeAgentLine.padding(.top, 8)
                    FlickPadCompact(
                        isEnabled: bridge.isConnected,
                        directionNames: directionNames,
                        onCommit: commit(direction:),
                        onCancel: { pendingDirection = nil }
                    )
                    .frame(width: padSize, height: padSize)
                    .padding(.top, 22)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity)
                .frame(maxHeight: .infinity, alignment: .top)
                .padding(.horizontal, 16)
                .safeAreaPadding(.top, 6)
            }
        }
        // Make the dock part of the safe-area layout instead of drawing it as
        // an overlay. This keeps the pad, home indicator, and dock aligned on
        // every device family and removes the old bottom-edge drift.
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomDock }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onDisappear {
            resetTask?.cancel()
            releaseTasks.values.forEach { $0.cancel() }
            releaseTasks.removeAll()
            bridge.sendJoystick(angle: 0, distance: 0)
            releaseAllPresses()
        }
    }

    private var bottomDock: some View {
        VStack(spacing: 0) {
            reasoningRail
            inputDock
            actionStatus
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Divider().opacity(0.25) }
        .safeAreaPadding(.bottom, 2)
    }

    private var header: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(bridge.isConnected ? Color.green : Color.orange)
                    .frame(width: 9, height: 9)
                Text("Micro")
                    .font(.title3.weight(.semibold))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(bridge.isConnected ? "Micro、接続中" : "Micro、再接続中")
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                Circle().fill(bridge.isBridgeConnected ? Color.green : Color.secondary.opacity(0.35)).frame(width: 7, height: 7)
                Circle().fill(bridge.isConnected ? Color.green : Color.orange).frame(width: 7, height: 7)
                Text(connectionLabel)
                    .font(.caption.weight(.semibold))
                    .accessibilityIdentifier("connectionStatus")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background((bridge.isConnected ? Color.green : Color.orange).opacity(0.10), in: Capsule())
            .accessibilityLabel(bridge.isConnected ? "iPhone、ブリッジ、Codexが接続中" : "再接続中")
            Button(action: onSettings) {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 38, height: 38)
                    .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settingsButton")
            .accessibilityLabel("カスタマイズと設定")
        }
        .foregroundStyle(.primary)
    }

    private var connectionLabel: String {
        switch bridge.phase {
        case .codexConnected: return "接続中"
        case .bridgeConnected: return "Codex待機"
        case .failed: return "認証エラー"
        default: return "再接続中"
        }
    }

    private var agentStrip: some View {
        HStack(spacing: 8) {
            ForEach(0..<6, id: \.self) { index in
                let snapshot = bridge.agents.first(where: { $0.id == index })
                RedesignedAgentOrb(
                    id: index,
                    symbol: agentSymbols[index],
                    color: color(for: index),
                    isSelected: snapshot?.selected ?? (selectedAgent == index),
                    isEnabled: bridge.isConnected,
                    title: snapshot?.title,
                    status: snapshot?.status ?? "idle"
                ) {
                    selectAgent(index)
                }
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.035), in: Capsule())
        .overlay(Capsule().stroke(.secondary.opacity(0.12)))
        .accessibilityElement(children: .contain)
    }

    private var activeAgentLine: some View {
        HStack(spacing: 7) {
            Circle().fill(color(for: selectedAgent)).frame(width: 7, height: 7)
            Text(activeAgentTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Text(statusName(bridge.agents.first(where: { $0.id == selectedAgent })?.status ?? "idle"))
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(activeAgentAccessibilityLabel)
    }

    private var activeAgentTitle: String {
        bridge.agents.first(where: { $0.id == selectedAgent })?.title ?? "Agent \(selectedAgent + 1)"
    }

    private var activeAgentAccessibilityLabel: String {
        let status = statusName(bridge.agents.first(where: { $0.id == selectedAgent })?.status ?? "idle")
        return "選択中 \(activeAgentTitle)、\(status)"
    }

    private var reasoningRail: some View {
        HStack(spacing: 9) {
            Image(systemName: "dial.medium")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(encoderModeName(bridge.layout?.encoderMode ?? "reasoning"))
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            ForEach(0..<5, id: \.self) { index in
                Button {
                    changeReasoning(to: index)
                } label: {
                    Circle()
                        .fill(index == effectiveReasoningIndex ? Color.accentColor : Color.secondary.opacity(0.22))
                        .frame(width: index == effectiveReasoningIndex ? 11 : 7, height: index == effectiveReasoningIndex ? 11 : 7)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .disabled(!reasoningAvailable)
                .accessibilityLabel(reasoningAvailable ? "推論レベル \(index + 1)" : "推論レベル未取得")
                .accessibilityAddTraits(index == effectiveReasoningIndex ? .isSelected : [])
            }
            if let current = effectiveReasoningIndex {
                Text("\(current + 1)/5")
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 11)
        .frame(height: 30)
        .background(Color.primary.opacity(0.035), in: Capsule())
        .overlay(Capsule().stroke(.secondary.opacity(0.10)))
        .opacity(reasoningAvailable ? 1 : 0.60)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(reasoningAvailable ? "推論レベル" : "推論レベル未取得")
    }

    private var inputDock: some View {
        VStack(spacing: 7) {
            HStack(spacing: 8) {
                RedesignedComposerAction(systemImage: "keyboard", title: "テキスト", accessibilityLabel: "テキスト入力", action: onTextInput)
                    .accessibilityIdentifier("textInputButton")
                RedesignedComposerAction(systemImage: "waveform", title: "音声", accessibilityLabel: "音声入力", action: onVoiceInput)
                    .accessibilityIdentifier("voiceComposerButton")
            }
            .frame(height: 44)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(commandKeys, id: \.self) { key in
                        commandSlot(for: key)
                    }
                }
                .padding(.horizontal, 2)
            }
            .scrollClipDisabled()
            .frame(height: 42)
        }
        .padding(6)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.secondary.opacity(0.12)))
        .padding(.top, 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("テキスト、音声、カスタム操作")
    }

    @ViewBuilder
    private func commandSlot(for key: String) -> some View {
        let assigned = bridge.layout?.actionKeys[key]
        let label = assigned ?? "未割当"
        let enabled = bridge.isConnected && assigned != nil
        if key == "ACT10" {
            RedesignedHoldButton(
                systemImage: commandSymbol(for: key, label: label),
                title: "",
                accessibilityLabel: enabled ? "\(label)を長押し" : "マイクキー未割当",
                isEnabled: enabled,
                onDown: { bridge.sendKey(key, action: 1); lastAction = "送信中" },
                onUp: { bridge.sendKey(key, action: 0); lastAction = label }
            )
            .accessibilityIdentifier("voiceInputButton")
        } else {
            RedesignedDockButton(
                systemImage: commandSymbol(for: key, label: label),
                title: "",
                accessibilityLabel: enabled ? label : "未割当",
                isEnabled: enabled
            ) {
                bridge.pulse(key)
                lastAction = "送信中"
            }
            .accessibilityIdentifier("command-\(key)")
        }
    }

    private func commandSymbol(for key: String, label: String) -> String {
        let lower = label.lowercased()
        if key == "ACT10" || lower.contains("音声") || lower.contains("マイク") { return "mic.fill" }
        if lower.contains("承認") || lower.contains("approve") { return "checkmark" }
        if lower.contains("却下") || lower.contains("reject") { return "xmark" }
        if lower.contains("新規") || lower.contains("new") { return "plus" }
        if lower.contains("会話") || lower.contains("chat") { return "bubble.left" }
        if lower.contains("実行") || lower.contains("run") { return "play.fill" }
        return label == "未割当" ? "plus" : "square.grid.2x2"
    }

    private func shortCommandLabel(_ label: String) -> String {
        guard label != "未割当" else { return "" }
        let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.count > 4 ? String(normalized.prefix(4)) + "…" : normalized
    }

    private var actionStatus: some View {
        let ackText: String = {
            switch bridge.lastAck?.state {
            case "codex-delivered", "confirmed": return "Codexへ届きました"
            case "unavailable": return "利用不可"
            case "failed": return "送信失敗"
            default: return lastAction
            }
        }()
        return HStack(spacing: 6) {
            Circle().fill(ackText.isEmpty ? Color.secondary.opacity(0.25) : Color.accentColor).frame(width: 5, height: 5)
            Text(ackText.isEmpty ? (bridge.isConnected ? "準備完了" : "再接続中") : ackText)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(height: 18)
        .accessibilityLabel(ackText.isEmpty ? (bridge.isConnected ? "準備完了" : "再接続中") : ackText)
    }

    private var directionNames: [Direction: String] {
        [
            .up: directionName("up"),
            .right: directionName("right"),
            .down: directionName("down"),
            .left: directionName("left")
        ]
    }

    private func directionName(_ key: String) -> String {
        guard let layout = bridge.layout else { return "—" }
        guard let raw = layout.analogStick[key], let value = raw else { return "—" }
        return value
    }

    private var reasoningAvailable: Bool {
        guard let reasoning = bridge.reasoning else { return false }
        return reasoning.available && reasoning.current != nil
    }

    private var effectiveReasoningIndex: Int? {
        guard reasoningAvailable else { return nil }
        return bridge.reasoning?.current
    }

    private func encoderModeName(_ value: String) -> String {
        switch value {
        case "reasoning": return "推論"
        case "conversation-scroll": return "スクロール"
        case "composer-navigation": return "入力欄"
        case "custom": return "カスタム"
        default: return "ノブ"
        }
    }

    private func color(for index: Int) -> Color {
        if let rgb = bridge.agents.first(where: { $0.id == index })?.rgb { return Color(microRGB: rgb) }
        let key = "AG0\(index)"
        guard let keys = bridge.lighting["keys"] as? [String: Any], let raw = keys[key] as? [String: Any], let number = raw["c"] as? NSNumber else {
            return fallbackColors[index]
        }
        return Color(microRGB: number.intValue)
    }

    private func statusName(_ value: String) -> String {
        switch value {
        case "working": return "作業中"
        case "awaiting-approval": return "承認待ち"
        case "awaiting-response": return "応答待ち"
        case "unread": return "未読"
        case "error": return "エラー"
        case "off": return "未割当"
        default: return "待機"
        }
    }

    private func selectAgent(_ index: Int) {
        guard bridge.isConnected else { return }
        selectedAgent = index
        let key = "AG0\(index)"
        releaseTasks[key]?.cancel()
        bridge.sendKey(key, action: 1, agent: index)
        releaseTasks[key] = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            bridge.sendKey(key, action: 0, agent: index)
            releaseTasks[key] = nil
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        lastAction = "送信中"
    }

    private func commit(direction: Direction) {
        guard bridge.isConnected else { return }
        pendingDirection = direction
        bridge.sendJoystick(angle: direction.angle, distance: 1)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        lastAction = "送信中"
        resetTask?.cancel()
        resetTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled else { return }
            bridge.sendJoystick(angle: 0, distance: 0)
            pendingDirection = nil
        }
    }

    private func changeReasoning(to value: Int) {
        guard bridge.isConnected, let current = effectiveReasoningIndex else { return }
        let delta = value - current
        guard delta != 0 else { return }
        let key = delta > 0 ? "ENC_CW" : "ENC_CC"
        for step in 0..<abs(delta) {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(90 * step))
                bridge.pulse(key)
            }
        }
        lastAction = "送信中"
    }

    private func releaseAllPresses() {
        releaseTasks.values.forEach { $0.cancel() }
        releaseTasks.removeAll()
        for index in 0..<6 { bridge.sendKey("AG0\(index)", action: 0, agent: index) }
        for key in commandKeys { bridge.sendKey(key, action: 0) }
        bridge.sendJoystick(angle: 0, distance: 0)
    }
}

private struct RedesignedAgentOrb: View {
    let id: Int
    let symbol: String
    let color: Color
    let isSelected: Bool
    let isEnabled: Bool
    let title: String?
    let status: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(isEnabled ? color : .secondary)
                    .frame(width: 43, height: 43)
                    .background(isSelected ? color.opacity(0.13) : Color.clear, in: Circle())
                    .overlay(Circle().stroke(isSelected ? color : .secondary.opacity(0.16), lineWidth: isSelected ? 2.5 : 1))
                Circle()
                    .fill(isEnabled ? color : Color.secondary.opacity(0.22))
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5))
            }
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("agent-\(id)")
        .accessibilityLabel(title ?? "Agent")
        .accessibilityValue("\(statusName)、\(isSelected ? "選択中" : "待機")")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var statusName: String {
        switch status {
        case "working": return "作業中"
        case "awaiting-approval": return "承認待ち"
        case "awaiting-response": return "応答待ち"
        case "unread": return "未読"
        case "error": return "エラー"
        case "off": return "未割当"
        default: return "待機"
        }
    }
}

private struct FlickPadCompact: View {
    let isEnabled: Bool
    let directionNames: [Direction: String]
    let onCommit: (Direction) -> Void
    let onCancel: () -> Void
    @State private var activeDirection: Direction?
    @State private var dragPoint: CGPoint = .zero

    var body: some View {
        GeometryReader { proxy in
            let diameter = min(proxy.size.width, proxy.size.height)
            let center = CGPoint(x: diameter / 2, y: diameter / 2)
            let radius = diameter / 2 - 5
            let hubSize = max(70, diameter * 0.25)
            let knobSize = max(58, diameter * 0.18)
            ZStack {
                Circle()
                    .fill(Color.primary.opacity(0.025))
                    .overlay(Circle().stroke(.secondary.opacity(0.17), lineWidth: 1))
                Circle()
                    .stroke(Color.primary.opacity(0.045), lineWidth: 12)
                    .padding(11)
                Circle()
                    .stroke(Color.secondary.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 6]))
                    .frame(width: diameter * 0.34, height: diameter * 0.34)
                ForEach(Direction.allCases, id: \.self) { direction in
                    DirectionWedge(direction: direction)
                        .fill(activeDirection == direction ? Color.accentColor.opacity(0.18) : Color.clear)
                        .overlay(DirectionWedge(direction: direction).stroke(.secondary.opacity(0.14), lineWidth: 1))
                }
                ForEach(Direction.allCases, id: \.self) { direction in
                    let name = displayName(directionNames[direction] ?? "—")
                    VStack(spacing: 4) {
                        Image(systemName: direction.symbol)
                            .font(.system(size: min(23, diameter * 0.074), weight: .medium))
                        Text(name)
                            .font(.system(size: min(12, diameter * 0.038), weight: .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.65)
                            .opacity(name == "—" ? 0.45 : 1)
                    }
                    .foregroundStyle(activeDirection == direction ? Color.accentColor : .primary)
                    .frame(width: diameter * 0.24, height: diameter * 0.16)
                    .position(position(for: direction, center: center, radius: radius * 0.56))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(name == "—" ? "方向の割り当て未取得" : (direction.accessibilityName + "、" + name))
                    .accessibilityHint(isEnabled ? "フリックで実行" : "接続すると操作できます")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("direction-\(direction.rawValue)")
                    .accessibilityAction { if isEnabled { onCommit(direction) } }
                }
                Circle()
                    .fill(Color(uiColor: .systemBackground))
                    .frame(width: hubSize, height: hubSize)
                    .overlay(Circle().stroke(activeDirection == nil ? .secondary.opacity(0.20) : Color.accentColor.opacity(0.60), lineWidth: activeDirection == nil ? 1 : 2))
                    .shadow(color: Color.black.opacity(0.08), radius: 8, y: 3)
                    .overlay(Image(systemName: activeDirection == nil ? "hand.draw" : "xmark")
                        .font(.system(size: min(21, diameter * 0.068), weight: .semibold))
                        .foregroundStyle(activeDirection == nil ? .secondary : Color.accentColor))
                    .accessibilityLabel("中央でキャンセル")
                if dragPoint != .zero {
                    Path { path in
                        path.move(to: center)
                        path.addLine(to: CGPoint(x: center.x + dragPoint.x, y: center.y + dragPoint.y))
                    }
                    .stroke(Color.accentColor.opacity(0.52), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .allowsHitTesting(false)
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: knobSize, height: knobSize)
                        .overlay(Circle().stroke(Color.white.opacity(0.92), lineWidth: 3))
                        .shadow(color: Color.accentColor.opacity(0.30), radius: 8, y: 3)
                        .position(x: center.x + dragPoint.x, y: center.y + dragPoint.y)
                        .allowsHitTesting(false)
                }
            }
            .frame(width: diameter, height: diameter)
            .opacity(isEnabled ? 1 : 0.52)
            .contentShape(Circle())
            .gesture(dragGesture(center: center, radius: radius))
            .accessibilityLabel("4方向フリックパッド")
            .accessibilityHint(isEnabled ? "方向へフリックしてワークフローを起動" : "接続すると操作できます")
        }
    }

    private func position(for direction: Direction, center: CGPoint, radius: CGFloat) -> CGPoint {
        switch direction {
        case .up: return CGPoint(x: center.x, y: center.y - radius)
        case .right: return CGPoint(x: center.x + radius, y: center.y)
        case .down: return CGPoint(x: center.x, y: center.y + radius)
        case .left: return CGPoint(x: center.x - radius, y: center.y)
        }
    }

    private func displayName(_ value: String) -> String {
        guard value != "—" else { return value }
        let compact = value.replacingOccurrences(of: " ", with: "")
        return compact.count > 5 ? String(compact.prefix(5)) + "…" : compact
    }

    private func dragGesture(center: CGPoint, radius: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard isEnabled else { return }
                let dx = value.location.x - center.x
                let dy = value.location.y - center.y
                let distance = hypot(dx, dy)
                let maxDistance = radius * 0.72
                let scale = min(1, maxDistance / max(distance, 1))
                dragPoint = CGPoint(x: dx * scale, y: dy * scale)
                let next: Direction?
                switch MicroInputSafety.direction(dx: dx, dy: dy, distance: distance, maxDistance: maxDistance) {
                case .up: next = .up
                case .right: next = .right
                case .down: next = .down
                case .left: next = .left
                case nil: next = nil
                }
                if next != activeDirection, next != nil { UISelectionFeedbackGenerator().selectionChanged() }
                activeDirection = next
            }
            .onEnded { _ in
                guard isEnabled else { return }
                let result = activeDirection
                activeDirection = nil
                dragPoint = .zero
                if let result { onCommit(result) } else { onCancel() }
            }
    }
}

private struct FlickDirectionTile: View {
    let direction: Direction
    let name: String
    let size: CGFloat
    let isEnabled: Bool
    let highlighted: Bool
    let onActivate: () -> Void

    var body: some View {
        VStack(spacing: 5) {
            Image(systemName: direction.symbol)
                .font(.system(size: min(22, size * 0.27), weight: .semibold))
            Text(name)
                .font(.system(size: min(11, size * 0.14), weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(highlighted ? Color.accentColor : .primary)
        .frame(width: size, height: size)
        .background(highlighted ? Color.accentColor.opacity(0.16) : Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).stroke(highlighted ? Color.accentColor.opacity(0.7) : .secondary.opacity(0.10), lineWidth: highlighted ? 2 : 1))
        .opacity(isEnabled ? 1 : 0.65)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(name == "—" ? "方向の割り当て未取得" : name)
        .accessibilityHint(isEnabled ? "フリックで実行" : "接続すると操作できます")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("direction-\(direction.rawValue)")
        .accessibilityAction { if isEnabled { onActivate() } }
    }
}

private struct FlickPadHub: View {
    let size: CGFloat
    let isActive: Bool

    var body: some View {
        Image(systemName: isActive ? "xmark" : "hand.tap")
            .font(.system(size: 19, weight: .semibold))
            .foregroundStyle(isActive ? Color.accentColor : .secondary)
            .frame(width: size, height: size)
            .background(.regularMaterial, in: Circle())
            .overlay(Circle().stroke(isActive ? Color.accentColor.opacity(0.65) : .secondary.opacity(0.14), lineWidth: isActive ? 2 : 1))
            .accessibilityLabel("中央でキャンセル")
    }
}

private struct RedesignedDockButton: View {
    let systemImage: String
    let title: String
    let accessibilityLabel: String
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: { if isEnabled { action() } }) {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .medium))
                if !title.isEmpty {
                    Text(title)
                        .font(.system(size: 9, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
            }
            .frame(width: 48, height: 40)
                .foregroundStyle(isEnabled ? .primary : .secondary)
        }
        .buttonStyle(.plain)
        .background(isEnabled ? Color.primary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .opacity(isEnabled ? 1 : 0.42)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct RedesignedHoldButton: View {
    let systemImage: String
    let title: String
    let accessibilityLabel: String
    let isEnabled: Bool
    let onDown: () -> Void
    let onUp: () -> Void
    @State private var pressed = false

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 18, weight: .medium))
            .frame(width: 48, height: 40)
            .overlay(alignment: .bottom) {
                if !title.isEmpty {
                    Text(title)
                        .font(.system(size: 9, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .padding(.bottom, 3)
                }
            }
            .foregroundStyle(pressed ? Color.accentColor : (isEnabled ? .primary : .secondary))
            .background(pressed ? Color.accentColor.opacity(0.15) : Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(isEnabled ? 1 : 0.42)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard isEnabled, !pressed else { return }
                        pressed = true
                        onDown()
                    }
                    .onEnded { _ in
                        guard pressed else { return }
                        pressed = false
                        onUp()
                    }
            )
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(pressed ? "入力中" : "待機")
    }
}

private struct RedesignedComposerAction: View {
    let systemImage: String
    let title: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .foregroundStyle(.primary)
            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}
