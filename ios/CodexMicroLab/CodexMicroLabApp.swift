import SwiftUI

@main
struct CodexMicroLabApp: App {
    @StateObject private var bridge = BridgeClient()
    @Environment(\.scenePhase) private var scenePhase

    private var isUITest: Bool {
        ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("UITEST_") })
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(bridge)
                // UI-test fixtures provide a deterministic connected or
                // recovering state. Do not let the real discovery task
                // overwrite that fixture before the screenshot is captured.
                .task {
                    if !isUITest { await bridge.startBrowsing() }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if isUITest { return }
            // `.inactive` is also emitted while presenting a sheet, opening
            // the keyboard, or showing a transient system overlay. Treating
            // it as a disconnect made normal text/voice input look like a
            // transport failure. The background phase is the durable exit
            // boundary; BridgeClient still releases held inputs on both
            // background and view disappearance.
            if phase == .background {
                bridge.disconnectForBackground()
            } else if phase == .active {
                Task { await bridge.startBrowsing() }
            }
        }
    }
}
