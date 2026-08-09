import CoreBluetooth
import Foundation

/// Diagnostic-only experiment. A successful add() is not equivalent to a Codex-compatible HID device.
final class BLEHidProbe: NSObject, ObservableObject, CBPeripheralManagerDelegate {
    @Published private(set) var status = "Not started"
    private var manager: CBPeripheralManager!

    func start() {
        status = "Starting Bluetooth peripheral…"
        manager = CBPeripheralManager(delegate: self, queue: .main)
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard peripheral.state == .poweredOn else {
            status = "Bluetooth unavailable (state \(peripheral.state.rawValue))"
            print("BLE state: \(peripheral.state.rawValue)")
            return
        }
        let hid = CBMutableService(type: CBUUID(string: "1812"), primary: true)
        peripheral.add(hid)
        status = "Registering HID Service 0x1812…"
        print("HID service add requested; waiting for didAdd callback")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            status = "HID Service rejected: \(error.localizedDescription)"
            print("HID service rejected: \(error)")
        } else {
            status = "HID Service registered: \(service.uuid.uuidString) (diagnostic only)"
            print("HID service registered: \(service.uuid.uuidString)")
        }
    }
}
