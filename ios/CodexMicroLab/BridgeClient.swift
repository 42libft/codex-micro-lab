import Foundation
import Security
import SwiftUI
import UIKit

enum BridgePhase: String {
    case unpaired, discovering, authenticating, bridgeConnected, codexConnected, recovering, failed
}

struct AgentSnapshot: Identifiable {
    let id: Int
    let title: String?
    let status: String
    let selected: Bool
    let rgb: Int?
}

struct LayoutSnapshot {
    let analogStick: [String: String?]
    let encoderMode: String?
    let agentSource: String?
    let actionKeys: [String: String]
    let encoder: [String: String]
    let microphoneMode: String?
    let separateMicrophoneKeys: Bool?
}

struct ReasoningSnapshot {
    let displayName: String?
    let current: Int?
    let choices: [String]?
    let available: Bool
}

struct CodexStateSnapshot {
    let status: String
    let transport: String?
    let model: String?
    let error: String?
    let lastResponseAt: String?
}

struct InputAckSnapshot {
    let eventId: String
    let state: String
    let inputType: String
    let reason: String?
}

@MainActor
final class BridgeClient: NSObject, ObservableObject {
    @Published private(set) var state = "Codex Micro Labを探索中…"
    @Published private(set) var transport = "準備中"
    @Published private(set) var lighting: [String: Any] = [:]
    @Published private(set) var battery: Int?
    @Published private(set) var isCharging = false
    @Published private(set) var phase: BridgePhase = .unpaired
    @Published private(set) var codexConnected = false
    @Published private(set) var agents: [AgentSnapshot] = []
    @Published private(set) var layout: LayoutSnapshot?
    @Published private(set) var reasoning: ReasoningSnapshot?
    @Published private(set) var codexState: CodexStateSnapshot?
    @Published private(set) var lastAck: InputAckSnapshot?
    @Published private(set) var lastHeartbeatAt: Date?
    @Published private(set) var lastMessageAt: Date?
    @Published private(set) var lastRpcSummary: String?

    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var token = KeychainToken.load() ?? ""
    private var manualHosts = UserDefaults.standard.stringArray(forKey: "codex-micro-lab.endpoint-hosts") ?? []
    private var manualPort: Int = {
        let stored = UserDefaults.standard.integer(forKey: "codex-micro-lab.endpoint-port")
        return stored == 0 ? 47831 : stored
    }()
    private var manualIndex = 0
    private var bridgePort: Int?
    private var telemetryTimer: Timer?
    private var heartbeatTimer: Timer?
    private var handshakeComplete = false
    // URLSession can deliver a failure from an old task after a replacement
    // task has already connected. Keep a generation so that stale callbacks
    // cannot tear down the new connection or surface a misleading send error.
    private var connectionGeneration = 0
    private var activePresses = Set<String>()
    private var handlingFailure = false

    var isBridgeConnected: Bool { handshakeComplete }
    var isConnected: Bool { handshakeComplete && codexConnected }
    var hasPairingToken: Bool { PairingPayload.isValidToken(token) && !manualHosts.isEmpty && (1024...65535).contains(manualPort) }

    override init() {
        super.init()
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("UITEST_UNPAIRED") {
            token = ""
            phase = .unpaired
            handshakeComplete = false
            codexConnected = false
            state = "ペアリング待ち"
            transport = "未接続"
            return
        }
        guard arguments.contains("UITEST_PAIRED") || arguments.contains("UITEST_RECOVERING") else { return }
        token = "0123456789abcdef0123456789abcdef"
        manualHosts = ["192.168.1.2"]
        phase = arguments.contains("UITEST_PAIRED") ? .codexConnected : .recovering
        handshakeComplete = arguments.contains("UITEST_PAIRED")
        codexConnected = arguments.contains("UITEST_PAIRED")
        state = codexConnected ? "Codex接続済み" : "再接続中"
        transport = codexConnected ? "テスト接続" : "QR指定IP再接続待ち"
        agents = [
            AgentSnapshot(id: 0, title: "開発", status: "working", selected: true, rgb: 0x2F80ED),
            AgentSnapshot(id: 1, title: "調査", status: "awaiting-approval", selected: false, rgb: 0x8B5CF6),
            AgentSnapshot(id: 2, title: "分析", status: "unread", selected: false, rgb: 0x22C55E),
            AgentSnapshot(id: 3, title: "運用", status: "idle", selected: false, rgb: 0xF97316),
            AgentSnapshot(id: 4, title: "記録", status: "awaiting-response", selected: false, rgb: 0x14B8A6),
            AgentSnapshot(id: 5, title: "未割当", status: "off", selected: false, rgb: nil)
        ]
        layout = LayoutSnapshot(
            analogStick: ["up": "計画", "right": "実行", "down": "まとめる", "left": "振り返る"],
            encoderMode: "reasoning",
            agentSource: "Recent",
            actionKeys: ["ACT07": "承認", "ACT08": "却下", "ACT10": "音声入力"],
            encoder: ["left": "浅く", "click": "選択", "right": "深く"],
            microphoneMode: "ptt",
            separateMicrophoneKeys: false
        )
        reasoning = ReasoningSnapshot(displayName: "標準", current: 2, choices: ["浅い", "やや浅い", "標準", "やや深い", "深い"], available: true)
        codexState = CodexStateSnapshot(status: codexConnected ? "connected" : "not-detected", transport: "unknown", model: "codex-micro", error: nil, lastResponseAt: nil)
    }

    func startBrowsing() async {
        guard socket == nil else { return }
        phase = hasPairingToken ? .discovering : .unpaired
        manualIndex = 0
        manualHosts = manualHosts.filter(PairingPayload.isAllowedPairingHost)
        guard hasPairingToken else {
            state = "QRを読み直してください"
            transport = "ペアリング情報なし"
            return
        }
        transport = "QR指定IPへ接続中"
        state = "Macへ直接接続中…"
        connectNextManualHost()
    }

    func setPairing(_ payload: PairingPayload) {
        token = payload.token
        manualHosts = payload.hosts
        manualPort = payload.port
        UserDefaults.standard.set(manualHosts, forKey: "codex-micro-lab.endpoint-hosts")
        UserDefaults.standard.set(manualPort, forKey: "codex-micro-lab.endpoint-port")
        KeychainToken.save(payload.token)
        disconnectForBackground()
        Task { await startBrowsing() }
    }

    func clearPairingToken() {
        disconnectForBackground()
        token = ""
        KeychainToken.delete()
        manualHosts = []
        UserDefaults.standard.removeObject(forKey: "codex-micro-lab.endpoint-hosts")
        UserDefaults.standard.removeObject(forKey: "codex-micro-lab.endpoint-port")
        state = "ペアリング待ち"
        transport = "未接続"
    }

    func sendKey(_ key: String, action: Int, agent: Int? = nil) {
        if action == 1 { activePresses.insert(key) }
        if action == 0 { activePresses.remove(key) }
        var input: [String: Any] = ["key": key, "act": action, "eventId": UUID().uuidString]
        if let agent { input["agent"] = agent }
        send(["version": 1, "type": "input.hid", "input": input])
    }

    func pulse(_ key: String) { sendKey(key, action: 2) }

    func sendJoystick(angle: Double, distance: Double) {
        send(["version": 1, "type": "input.joystick", "input": ["angle": angle, "distance": distance, "eventId": UUID().uuidString]])
    }

    /// Sends text captured by the iPhone composer. Older bridges safely ignore
    /// this additive message; Lab builds can route it to the renderer composer.
    func sendText(_ text: String) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        send(["version": 1, "type": "input.text", "input": ["text": value, "eventId": UUID().uuidString]])
    }

    func sendTelemetry() {
        guard handshakeComplete else { return }
        UIDevice.current.isBatteryMonitoringEnabled = true
        let level = UIDevice.current.batteryLevel
        let percentage = level >= 0 ? Int(level * 100) : nil
        battery = percentage
        var telemetry: [String: Any] = ["isCharging": UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full]
        if let percentage { telemetry["batteryPercentage"] = percentage }
        send(["version": 1, "type": "device.telemetry", "telemetry": telemetry])
    }

    func disconnectForBackground() {
        // Mark the intentional shutdown before releasing held inputs. A
        // release frame can complete with EPIPE while URLSession is closing;
        // that must not start a second recovery loop or replace the next
        // connection attempt.
        let wasHandlingFailure = handlingFailure
        handlingFailure = true
        connectionGeneration &+= 1
        releaseAllPresses()
        telemetryTimer?.invalidate()
        telemetryTimer = nil
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        manualIndex = 0
        handshakeComplete = false
        codexConnected = false
        phase = hasPairingToken ? .recovering : .unpaired
        transport = "一時停止"
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        state = "バックグラウンドのため一時停止"
        handlingFailure = wasHandlingFailure
    }

    private func releaseAllPresses() {
        let keys = activePresses
        activePresses.removeAll()
        for key in keys {
            send(["version": 1, "type": "input.hid", "input": ["key": key, "act": 0, "eventId": UUID().uuidString]])
        }
        // ACT10 is a hold-to-talk key even if a transient view callback did
        // not reach sendKey(1) before the scene was backgrounded.
        send(["version": 1, "type": "input.hid", "input": ["key": "ACT10", "act": 0, "eventId": UUID().uuidString]])
        send(["version": 1, "type": "input.joystick", "input": ["angle": 0, "distance": 0, "eventId": UUID().uuidString]])
    }

    private func connectNextManualHost() {
        guard socket == nil else { return }
        guard manualIndex < manualHosts.count else {
            phase = .failed
            transport = "QR指定IPへ接続できません"
            state = "ネットワークを確認してQRを読み直してください"
            return
        }
        let host = manualHosts[manualIndex]
        manualIndex += 1
        connect(host: host, port: manualPort)
    }

    private func connect(host: String, port: Int) {
        guard socket == nil else { return }
        connectionGeneration &+= 1
        let generation = connectionGeneration
        bridgePort = port
        let url = URL(string: "ws://\(host):\(port)")!
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: configuration)
        self.session = session
        state = "Macへ接続中…"
        phase = .authenticating
        let socket = session.webSocketTask(with: url)
        self.socket = socket
        handshakeComplete = false
        socket.resume()
        send(["version": 1, "type": "hello", "role": "iphone", "token": token])
        receiveLoop(for: socket, generation: generation)
    }

    private func receiveLoop(for task: URLSessionWebSocketTask, generation: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                guard self.connectionGeneration == generation, self.socket === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message { self.handle(text) }
                    self.receiveLoop(for: task, generation: generation)
                case .failure(let error):
                    self.handleConnectionFailure("Disconnected: \(error.localizedDescription)", generation: generation)
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { return }
        lastMessageAt = Date()
        switch type {
        case "hello.ok":
            state = "ブリッジ接続済み"
            transport = "QR指定IP"
            handshakeComplete = true
            phase = .bridgeConnected
            startPostHandshakeTimers()
        case "heartbeat.ok":
            lastHeartbeatAt = Date()
        case "rpc.response":
            if let raw = object["raw"] as? String {
                lastRpcSummary = String(raw.prefix(240))
            }
        case "connection.state":
            codexConnected = (object["state"] as? String) == "available"
            phase = codexConnected ? .codexConnected : .bridgeConnected
            state = codexConnected ? "Codex接続済み" : "Lab版Codexを待機中"
        case "lighting.snapshot":
            if let snapshot = object["lighting"] as? [String: Any] { lighting = snapshot }
        case "agent.snapshot":
            if let snapshot = object["snapshot"] as? [String: Any], let slot = snapshot["slot"] as? Int {
                let next = AgentSnapshot(id: slot, title: nil, status: snapshot["status"] as? String ?? "idle", selected: snapshot["selected"] as? Bool ?? false, rgb: snapshot["rgb"] as? Int)
                agents = (agents.filter { $0.id != slot } + [next]).sorted { $0.id < $1.id }
            }
        case "codex.state":
            if let snapshot = object["snapshot"] as? [String: Any] {
                codexState = CodexStateSnapshot(status: snapshot["status"] as? String ?? "not-detected", transport: snapshot["transport"] as? String, model: snapshot["model"] as? String, error: snapshot["error"] as? String, lastResponseAt: snapshot["lastResponseAt"] as? String)
            }
        case "input.ack":
            if let ack = object["ack"] as? [String: Any], let eventId = ack["eventId"] as? String {
                lastAck = InputAckSnapshot(eventId: eventId, state: ack["state"] as? String ?? "failed", inputType: ack["inputType"] as? String ?? "hid", reason: ack["reason"] as? String)
            }
        case "error":
            let message = object["message"] as? String ?? "ブリッジエラー"
            if handshakeComplete { state = message } else { handleConnectionFailure(message) }
        default: break
        }
    }

    private func handleConnectionFailure(_ message: String, generation: Int? = nil) {
        if let generation, generation != connectionGeneration { return }
        guard !handlingFailure else { return }
        handlingFailure = true
        let authenticationFailed = message.localizedCaseInsensitiveContains("pairing token") || message.localizedCaseInsensitiveContains("authentication") || message.contains("認証")
        // Release any held input while the task is still available. Error
        // callbacks from these release frames are ignored during recovery so
        // a broken pipe cannot recursively start another recovery cycle.
        releaseAllPresses()
        connectionGeneration &+= 1
        handshakeComplete = false
        codexConnected = false
        phase = .recovering
        transport = "QR指定IP接続失敗"
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        telemetryTimer?.invalidate()
        telemetryTimer = nil
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        if authenticationFailed {
            phase = .failed
            transport = "認証失敗"
            state = "認証が無効です。設定から再ペアリングしてください"
            handlingFailure = false
            return
        }
        if manualIndex < manualHosts.count {
            state = "Macが見つかりません。別の接続先を試行中…"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.connectNextManualHost() }
        } else {
            phase = .failed
            transport = "QR指定IPへ接続できません"
            state = "ネットワークを確認してQRを読み直してください"
        }
        handlingFailure = false
    }

    private func startPostHandshakeTimers() {
        guard handshakeComplete else { return }
        sendTelemetry()
        telemetryTimer?.invalidate()
        telemetryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sendTelemetry() }
        }
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.handshakeComplete else { return }
                self.send(["version": 1, "type": "heartbeat", "nonce": UUID().uuidString])
            }
        }
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        guard let task = socket, handshakeComplete || object["type"] as? String == "hello" else { return }
        // URLSession may deliver a delayed callback after cancel/close. Do
        // not enqueue another frame on a task which is no longer running;
        // doing so is the iOS-side equivalent of writing to a broken pipe.
        guard task.state == .running, task.closeCode == .invalid else { return }
        task.send(.string(text)) { [weak self, weak task] error in
            guard let error else { return }
            Task { @MainActor in
                guard let self, self.socket === task, !self.handlingFailure else { return }
                self.handleConnectionFailure("送信失敗: \(error.localizedDescription)", generation: self.connectionGeneration)
            }
        }
    }
}

enum KeychainToken {
    private static let service = "io.github.42libft.codex-micro-lab.iphone"
    private static let account = "pairing-token"

    static func load() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }

    static func delete() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}
