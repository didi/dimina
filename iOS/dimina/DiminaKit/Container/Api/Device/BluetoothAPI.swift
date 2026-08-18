import CoreBluetooth
import Foundation

/** WeChat-compatible Bluetooth adapter and BLE central API bridge. */
public final class BluetoothAPI: DMPContainerApi {
    private static func bridge(_ name: String, _ param: DMPBridgeParam, _ env: DMPBridgeEnv, _ callback: DMPBridgeCallback?) -> DMPAPIResult {
        BluetoothAPIManager.shared.handle(name: name, data: param.getMap(), appId: env.appId, callback: callback)
        return DMPAsyncResult()
    }

    @BridgeMethod("openBluetoothAdapter") var openBluetoothAdapter: DMPBridgeMethodHandler = { bridge("openBluetoothAdapter", $0, $1, $2) }
    @BridgeMethod("closeBluetoothAdapter") var closeBluetoothAdapter: DMPBridgeMethodHandler = { bridge("closeBluetoothAdapter", $0, $1, $2) }
    @BridgeMethod("getBluetoothAdapterState") var getBluetoothAdapterState: DMPBridgeMethodHandler = { bridge("getBluetoothAdapterState", $0, $1, $2) }
    @BridgeMethod("startBluetoothDevicesDiscovery") var startBluetoothDevicesDiscovery: DMPBridgeMethodHandler = { bridge("startBluetoothDevicesDiscovery", $0, $1, $2) }
    @BridgeMethod("stopBluetoothDevicesDiscovery") var stopBluetoothDevicesDiscovery: DMPBridgeMethodHandler = { bridge("stopBluetoothDevicesDiscovery", $0, $1, $2) }
    @BridgeMethod("getBluetoothDevices") var getBluetoothDevices: DMPBridgeMethodHandler = { bridge("getBluetoothDevices", $0, $1, $2) }
    @BridgeMethod("getConnectedBluetoothDevices") var getConnectedBluetoothDevices: DMPBridgeMethodHandler = { bridge("getConnectedBluetoothDevices", $0, $1, $2) }
    @BridgeMethod("onBluetoothAdapterStateChange") var onBluetoothAdapterStateChange: DMPBridgeMethodHandler = { bridge("onBluetoothAdapterStateChange", $0, $1, $2) }
    @BridgeMethod("offBluetoothAdapterStateChange") var offBluetoothAdapterStateChange: DMPBridgeMethodHandler = { bridge("offBluetoothAdapterStateChange", $0, $1, $2) }
    @BridgeMethod("onBluetoothDeviceFound") var onBluetoothDeviceFound: DMPBridgeMethodHandler = { bridge("onBluetoothDeviceFound", $0, $1, $2) }
    @BridgeMethod("offBluetoothDeviceFound") var offBluetoothDeviceFound: DMPBridgeMethodHandler = { bridge("offBluetoothDeviceFound", $0, $1, $2) }
    @BridgeMethod("createBLEConnection") var createBLEConnection: DMPBridgeMethodHandler = { bridge("createBLEConnection", $0, $1, $2) }
    @BridgeMethod("closeBLEConnection") var closeBLEConnection: DMPBridgeMethodHandler = { bridge("closeBLEConnection", $0, $1, $2) }
    @BridgeMethod("getBLEDeviceServices") var getBLEDeviceServices: DMPBridgeMethodHandler = { bridge("getBLEDeviceServices", $0, $1, $2) }
    @BridgeMethod("getBLEDeviceCharacteristics") var getBLEDeviceCharacteristics: DMPBridgeMethodHandler = { bridge("getBLEDeviceCharacteristics", $0, $1, $2) }
    @BridgeMethod("readBLECharacteristicValue") var readBLECharacteristicValue: DMPBridgeMethodHandler = { bridge("readBLECharacteristicValue", $0, $1, $2) }
    @BridgeMethod("writeBLECharacteristicValue") var writeBLECharacteristicValue: DMPBridgeMethodHandler = { bridge("writeBLECharacteristicValue", $0, $1, $2) }
    @BridgeMethod("notifyBLECharacteristicValueChange") var notifyBLECharacteristicValueChange: DMPBridgeMethodHandler = { bridge("notifyBLECharacteristicValueChange", $0, $1, $2) }
    @BridgeMethod("getBLEDeviceRSSI") var getBLEDeviceRSSI: DMPBridgeMethodHandler = { bridge("getBLEDeviceRSSI", $0, $1, $2) }
    @BridgeMethod("setBLEMTU") var setBLEMTU: DMPBridgeMethodHandler = { bridge("setBLEMTU", $0, $1, $2) }
    @BridgeMethod("getBLEMTU") var getBLEMTU: DMPBridgeMethodHandler = { bridge("getBLEMTU", $0, $1, $2) }
    @BridgeMethod("onBLEConnectionStateChange") var onBLEConnectionStateChange: DMPBridgeMethodHandler = { bridge("onBLEConnectionStateChange", $0, $1, $2) }
    @BridgeMethod("offBLEConnectionStateChange") var offBLEConnectionStateChange: DMPBridgeMethodHandler = { bridge("offBLEConnectionStateChange", $0, $1, $2) }
    @BridgeMethod("onBLECharacteristicValueChange") var onBLECharacteristicValueChange: DMPBridgeMethodHandler = { bridge("onBLECharacteristicValueChange", $0, $1, $2) }
    @BridgeMethod("offBLECharacteristicValueChange") var offBLECharacteristicValueChange: DMPBridgeMethodHandler = { bridge("offBLECharacteristicValueChange", $0, $1, $2) }
    @BridgeMethod("onBLEMTUChange") var onBLEMTUChange: DMPBridgeMethodHandler = { bridge("onBLEMTUChange", $0, $1, $2) }
    @BridgeMethod("offBLEMTUChange") var offBLEMTUChange: DMPBridgeMethodHandler = { bridge("offBLEMTUChange", $0, $1, $2) }
    @BridgeMethod("isBluetoothDevicePaired") var isBluetoothDevicePaired: DMPBridgeMethodHandler = { bridge("isBluetoothDevicePaired", $0, $1, $2) }
    @BridgeMethod("makeBluetoothPair") var makeBluetoothPair: DMPBridgeMethodHandler = { bridge("makeBluetoothPair", $0, $1, $2) }
}

final class BluetoothAPIManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let shared = BluetoothAPIManager()
    private static let arrayBufferKey = "__diminaArrayBufferBase64"

    private struct Pending {
        let name: String
        let callback: DMPBridgeCallback?
        let timeout: DispatchWorkItem?

        init(name: String, callback: DMPBridgeCallback?, timeout: DispatchWorkItem? = nil) {
            self.name = name
            self.callback = callback
            self.timeout = timeout
        }
    }

    private var central: CBCentralManager?
    private var initializedApps = Set<String>()
    private var scanningApps = Set<String>()
    private var allowDuplicates: [String: Bool] = [:]
    private var pendingOpen: [String: [DMPBridgeCallback?]] = [:]
    private var pending: [String: Pending] = [:]
    private var discovered: [String: [String: [String: Any]]] = [:]
    private var peripherals: [String: [String: CBPeripheral]] = [:]

    private var adapterListeners: [String: [String: DMPBridgeCallback]] = [:]
    private var deviceListeners: [String: [String: DMPBridgeCallback]] = [:]
    private var connectionListeners: [String: [String: DMPBridgeCallback]] = [:]
    private var characteristicListeners: [String: [String: DMPBridgeCallback]] = [:]
    private var mtuListeners: [String: [String: DMPBridgeCallback]] = [:]

    func handle(name: String, data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch name {
            case "openBluetoothAdapter": self.open(data: data, appId: appId, callback: callback)
            case "closeBluetoothAdapter": self.close(appId: appId, callback: callback)
            case "getBluetoothAdapterState": self.adapterState(appId: appId, callback: callback)
            case "startBluetoothDevicesDiscovery": self.startDiscovery(data: data, appId: appId, callback: callback)
            case "stopBluetoothDevicesDiscovery": self.stopDiscovery(appId: appId, callback: callback)
            case "getBluetoothDevices": self.getDevices(appId: appId, callback: callback)
            case "getConnectedBluetoothDevices": self.getConnected(data: data, appId: appId, callback: callback)
            case "createBLEConnection": self.connect(data: data, appId: appId, callback: callback)
            case "closeBLEConnection": self.disconnect(data: data, appId: appId, callback: callback)
            case "getBLEDeviceServices": self.getServices(data: data, appId: appId, callback: callback)
            case "getBLEDeviceCharacteristics": self.getCharacteristics(data: data, appId: appId, callback: callback)
            case "readBLECharacteristicValue": self.readCharacteristic(data: data, appId: appId, callback: callback)
            case "writeBLECharacteristicValue": self.writeCharacteristic(data: data, appId: appId, callback: callback)
            case "notifyBLECharacteristicValueChange": self.setNotification(data: data, appId: appId, callback: callback)
            case "getBLEDeviceRSSI": self.getRSSI(data: data, appId: appId, callback: callback)
            case "getBLEMTU": self.getMTU(data: data, appId: appId, callback: callback)
            case "setBLEMTU": self.fail(name, callback, 10009, "system not support")
            case "isBluetoothDevicePaired", "makeBluetoothPair": self.fail(name, callback, 10009, "system not support")
            case "onBluetoothAdapterStateChange": self.addListener(&self.adapterListeners, data, appId, callback)
            case "offBluetoothAdapterStateChange": self.removeListener(&self.adapterListeners, data, appId)
            case "onBluetoothDeviceFound": self.addListener(&self.deviceListeners, data, appId, callback)
            case "offBluetoothDeviceFound": self.removeListener(&self.deviceListeners, data, appId)
            case "onBLEConnectionStateChange": self.addListener(&self.connectionListeners, data, appId, callback)
            case "offBLEConnectionStateChange": self.removeListener(&self.connectionListeners, data, appId)
            case "onBLECharacteristicValueChange": self.addListener(&self.characteristicListeners, data, appId, callback)
            case "offBLECharacteristicValueChange": self.removeListener(&self.characteristicListeners, data, appId)
            case "onBLEMTUChange": self.addListener(&self.mtuListeners, data, appId, callback)
            case "offBLEMTUChange": self.removeListener(&self.mtuListeners, data, appId)
            default: self.fail(name, callback, 10008, "system error")
            }
        }
    }

    private func open(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        if data.getString(key: "mode") == "peripheral" {
            fail("openBluetoothAdapter", callback, 10009, "peripheral mode is not supported")
            return
        }
        initializedApps.insert(appId)
        if central == nil {
            pendingOpen[appId, default: []].append(callback)
            central = CBCentralManager(delegate: self, queue: .main)
            return
        }
        resolveOpen(appId: appId, callback: callback)
    }

    private func resolveOpen(appId: String, callback: DMPBridgeCallback?) {
        guard initializedApps.contains(appId), let central else { return }
        if central.state == .poweredOn {
            success("openBluetoothAdapter", callback)
        } else if central.state != .unknown && central.state != .resetting {
            fail("openBluetoothAdapter", callback, 10001, "not available", extra: ["state": central.state.rawValue])
        } else {
            pendingOpen[appId, default: []].append(callback)
        }
    }

    private func close(appId: String, callback: DMPBridgeCallback?) {
        guard ensureInitialized(appId, "closeBluetoothAdapter", callback) else { return }
        scanningApps.remove(appId)
        if scanningApps.isEmpty { central?.stopScan() }
        pending.keys.filter { $0.hasPrefix("\(appId)\u{0}") }.forEach { operationKey in
            if let operation = pending.removeValue(forKey: operationKey) {
                operation.timeout?.cancel()
                fail(operation.name, operation.callback, 10006, "no connection")
            }
        }
        peripherals[appId]?.values.forEach { central?.cancelPeripheralConnection($0) }
        peripherals.removeValue(forKey: appId)
        discovered.removeValue(forKey: appId)
        initializedApps.remove(appId)
        success("closeBluetoothAdapter", callback)
    }

    private func adapterState(appId: String, callback: DMPBridgeCallback?) {
        guard ensureInitialized(appId, "getBluetoothAdapterState", callback) else { return }
        success("getBluetoothAdapterState", callback, [
            "available": central?.state == .poweredOn,
            "discovering": scanningApps.contains(appId) && central?.isScanning == true,
        ])
    }

    private func startDiscovery(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "startBluetoothDevicesDiscovery"
        guard ensureAvailable(appId, name, callback), let central else { return }
        let services = (data.get("services") as? [Any])?.compactMap { ($0 as? String).map(CBUUID.init(string:)) }
        allowDuplicates[appId] = data.getBool(key: "allowDuplicatesKey") ?? false
        scanningApps.insert(appId)
        central.scanForPeripherals(
            withServices: services?.isEmpty == true ? nil : services,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: allowDuplicates[appId] ?? false]
        )
        success(name, callback)
    }

    private func stopDiscovery(appId: String, callback: DMPBridgeCallback?) {
        let name = "stopBluetoothDevicesDiscovery"
        guard ensureInitialized(appId, name, callback) else { return }
        scanningApps.remove(appId)
        if scanningApps.isEmpty { central?.stopScan() }
        success(name, callback)
    }

    private func getDevices(appId: String, callback: DMPBridgeCallback?) {
        let name = "getBluetoothDevices"
        guard ensureInitialized(appId, name, callback) else { return }
        success(name, callback, ["devices": Array(discovered[appId]?.values ?? [:].values)])
    }

    private func getConnected(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "getConnectedBluetoothDevices"
        guard ensureAvailable(appId, name, callback), let central else { return }
        let services = (data.get("services") as? [Any])?.compactMap { ($0 as? String).map(CBUUID.init(string:)) } ?? []
        var result: [String: [String: Any]] = [:]
        peripherals[appId]?.forEach { id, peripheral in
            let matches = services.isEmpty || (peripheral.services ?? []).contains { services.contains($0.uuid) }
            if peripheral.state == .connected && matches { result[id] = deviceInfo(peripheral: peripheral) }
        }
        if !services.isEmpty {
            central.retrieveConnectedPeripherals(withServices: services).forEach { peripheral in
                result[peripheral.identifier.uuidString] = deviceInfo(peripheral: peripheral)
            }
        }
        success(name, callback, ["devices": Array(result.values)])
    }

    private func connect(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "createBLEConnection"
        guard ensureAvailable(appId, name, callback), let central else { return }
        guard let deviceId = required(data, "deviceId", name, callback) else { return }
        if let existing = peripherals[appId]?[deviceId], existing.state == .connected {
            success(name, callback)
            return
        }
        guard let peripheral = peripheral(for: deviceId, appId: appId) else {
            fail(name, callback, 10002, "no device")
            return
        }
        peripheral.delegate = self
        peripherals[appId, default: [:]][deviceId] = peripheral
        let operationKey = key(appId, deviceId)
        var timeoutTask: DispatchWorkItem?
        if let timeout = data.getDouble(key: "timeout"), timeout > 0 {
            let task = DispatchWorkItem { [weak self, weak peripheral] in
                guard let self,
                      let operation = self.pending[operationKey],
                      operation.name == name else { return }
                self.pending.removeValue(forKey: operationKey)
                if let peripheral { self.central?.cancelPeripheralConnection(peripheral) }
                self.fail(name, operation.callback, 10012, "operate time out")
            }
            timeoutTask = task
        }
        pending[operationKey] = Pending(name: name, callback: callback, timeout: timeoutTask)
        central.connect(peripheral, options: nil)
        if let timeoutTask, let timeout = data.getDouble(key: "timeout"), timeout > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout / 1_000, execute: timeoutTask)
        }
    }

    private func disconnect(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "closeBLEConnection"
        guard ensureInitialized(appId, name, callback) else { return }
        guard let deviceId = required(data, "deviceId", name, callback) else { return }
        guard let peripheral = peripherals[appId]?.removeValue(forKey: deviceId) else {
            fail(name, callback, 10002, "no device")
            return
        }
        if let operation = pending.removeValue(forKey: key(appId, deviceId)) {
            operation.timeout?.cancel()
            fail(operation.name, operation.callback, 10006, "no connection")
        }
        central?.cancelPeripheralConnection(peripheral)
        emit(connectionListeners[appId], ["deviceId": deviceId, "connected": false])
        success(name, callback)
    }

    private func getServices(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "getBLEDeviceServices"
        guard let (deviceId, peripheral) = connectedPeripheral(data, appId, name, callback) else { return }
        if let services = peripheral.services, !services.isEmpty {
            success(name, callback, ["services": serviceResult(services)])
            return
        }
        pending[key(appId, deviceId)] = Pending(name: name, callback: callback)
        peripheral.discoverServices(nil)
    }

    private func getCharacteristics(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "getBLEDeviceCharacteristics"
        guard let (deviceId, peripheral) = connectedPeripheral(data, appId, name, callback) else { return }
        guard let service = service(data, peripheral) else {
            fail(name, callback, 10004, "no service")
            return
        }
        if let characteristics = service.characteristics {
            success(name, callback, ["characteristics": characteristicResult(characteristics)])
            return
        }
        pending[key(appId, deviceId)] = Pending(name: name, callback: callback)
        peripheral.discoverCharacteristics(nil, for: service)
    }

    private func characteristicResult(_ characteristics: [CBCharacteristic]) -> [[String: Any]] {
        characteristics.map { characteristic -> [String: Any] in
            let properties = characteristic.properties
            return [
                "uuid": characteristic.uuid.uuidString.uppercased(),
                "properties": [
                    "read": properties.contains(.read),
                    "write": properties.contains(.write),
                    "writeNoResponse": properties.contains(.writeWithoutResponse),
                    "notify": properties.contains(.notify),
                    "indicate": properties.contains(.indicate),
                ],
            ]
        }
    }

    private func readCharacteristic(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "readBLECharacteristicValue"
        guard let (deviceId, peripheral) = connectedPeripheral(data, appId, name, callback) else { return }
        guard let characteristic = characteristic(data, peripheral, name, callback) else { return }
        guard characteristic.properties.contains(.read) else {
            fail(name, callback, 10007, "property not support")
            return
        }
        pending[key(appId, deviceId)] = Pending(name: name, callback: callback)
        peripheral.readValue(for: characteristic)
    }

    private func writeCharacteristic(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "writeBLECharacteristicValue"
        guard let (deviceId, peripheral) = connectedPeripheral(data, appId, name, callback) else { return }
        guard let characteristic = characteristic(data, peripheral, name, callback) else { return }
        guard let value = decodeArrayBuffer(data.get("value")) else {
            fail(name, callback, 10013, "invalid_data")
            return
        }
        let withoutResponse = data.getString(key: "writeType") == "writeNoResponse"
        let writeType: CBCharacteristicWriteType = withoutResponse ? .withoutResponse : .withResponse
        let supported = withoutResponse
            ? characteristic.properties.contains(.writeWithoutResponse)
            : characteristic.properties.contains(.write)
        guard supported else {
            fail(name, callback, 10007, "property not support")
            return
        }
        if withoutResponse {
            peripheral.writeValue(value, for: characteristic, type: writeType)
            success(name, callback)
        } else {
            pending[key(appId, deviceId)] = Pending(name: name, callback: callback)
            peripheral.writeValue(value, for: characteristic, type: writeType)
        }
    }

    private func setNotification(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "notifyBLECharacteristicValueChange"
        guard let (deviceId, peripheral) = connectedPeripheral(data, appId, name, callback) else { return }
        guard let characteristic = characteristic(data, peripheral, name, callback) else { return }
        let enabled = data.getBool(key: "state") ?? true
        guard !enabled || characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate) else {
            fail(name, callback, 10007, "property not support")
            return
        }
        pending[key(appId, deviceId)] = Pending(name: name, callback: callback)
        peripheral.setNotifyValue(enabled, for: characteristic)
    }

    private func getRSSI(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "getBLEDeviceRSSI"
        guard let (deviceId, peripheral) = connectedPeripheral(data, appId, name, callback) else { return }
        pending[key(appId, deviceId)] = Pending(name: name, callback: callback)
        peripheral.readRSSI()
    }

    private func getMTU(data: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let name = "getBLEMTU"
        guard let (_, peripheral) = connectedPeripheral(data, appId, name, callback) else { return }
        success(name, callback, ["mtu": peripheral.maximumWriteValueLength(for: .withoutResponse) + 3])
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let pendingCallbacks = pendingOpen
        pendingOpen.removeAll()
        pendingCallbacks.forEach { appId, callbacks in
            callbacks.forEach { resolveOpen(appId: appId, callback: $0) }
        }
        adapterListeners.forEach { appId, listeners in
            emit(listeners, [
                "available": central.state == .poweredOn,
                "discovering": central.state == .poweredOn && scanningApps.contains(appId) && central.isScanning,
            ])
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        for appId in scanningApps {
            let id = peripheral.identifier.uuidString
            let isNew = discovered[appId]?[id] == nil
            let info = deviceInfo(peripheral: peripheral, advertisementData: advertisementData, rssi: RSSI)
            discovered[appId, default: [:]][id] = info
            peripherals[appId, default: [:]][id] = peripheral
            if isNew || allowDuplicates[appId] == true {
                emit(deviceListeners[appId], ["devices": [info]])
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard let appId = owner(of: peripheral) else { return }
        peripheral.delegate = self
        let id = peripheral.identifier.uuidString
        finish(appId, id, expected: "createBLEConnection") { success("createBLEConnection", $0) }
        emit(connectionListeners[appId], ["deviceId": id, "connected": true])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        let id = peripheral.identifier.uuidString
        finish(appId, id, expected: "createBLEConnection") { fail("createBLEConnection", $0, 10003, "connection fail") }
        emit(connectionListeners[appId], ["deviceId": id, "connected": false])
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        let id = peripheral.identifier.uuidString
        emit(connectionListeners[appId], ["deviceId": id, "connected": false])
        if let pending = pending.removeValue(forKey: key(appId, id)) {
            pending.timeout?.cancel()
            fail(pending.name, pending.callback, 10006, "no connection")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        let id = peripheral.identifier.uuidString
        finish(appId, id, expected: "getBLEDeviceServices") { callback in
            if error == nil {
                success("getBLEDeviceServices", callback, ["services": serviceResult(peripheral.services ?? [])])
            } else { fail("getBLEDeviceServices", callback, 10008, "system error") }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        finish(appId, peripheral.identifier.uuidString, expected: "getBLEDeviceCharacteristics") { callback in
            if error == nil {
                success("getBLEDeviceCharacteristics", callback, [
                    "characteristics": characteristicResult(service.characteristics ?? []),
                ])
            } else {
                fail("getBLEDeviceCharacteristics", callback, 10008, "system error")
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        let id = peripheral.identifier.uuidString
        if error == nil, let value = characteristic.value {
            emitCharacteristic(appId: appId, peripheral: peripheral, characteristic: characteristic, value: value)
        }
        if pending[key(appId, id)]?.name == "readBLECharacteristicValue" {
            finish(appId, id, expected: "readBLECharacteristicValue") { callback in
                if error == nil { success("readBLECharacteristicValue", callback) }
                else { fail("readBLECharacteristicValue", callback, 10008, "system error") }
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        finish(appId, peripheral.identifier.uuidString, expected: "writeBLECharacteristicValue") { callback in
            if error == nil { success("writeBLECharacteristicValue", callback) }
            else { fail("writeBLECharacteristicValue", callback, 10008, "system error") }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        finish(appId, peripheral.identifier.uuidString, expected: "notifyBLECharacteristicValueChange") { callback in
            if error == nil { success("notifyBLECharacteristicValueChange", callback) }
            else { fail("notifyBLECharacteristicValueChange", callback, 10008, "system error") }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        guard let appId = owner(of: peripheral) else { return }
        finish(appId, peripheral.identifier.uuidString, expected: "getBLEDeviceRSSI") { callback in
            if error == nil { success("getBLEDeviceRSSI", callback, ["RSSI": RSSI.intValue]) }
            else { fail("getBLEDeviceRSSI", callback, 10008, "system error") }
        }
    }

    private func emitCharacteristic(appId: String, peripheral: CBPeripheral, characteristic: CBCharacteristic, value: Data) {
        emit(characteristicListeners[appId], [
            "deviceId": peripheral.identifier.uuidString,
            "serviceId": characteristic.service?.uuid.uuidString.uppercased() ?? "",
            "characteristicId": characteristic.uuid.uuidString.uppercased(),
            "value": Self.arrayBuffer(value),
        ])
    }

    private func serviceResult(_ services: [CBService]) -> [[String: Any]] {
        services.map { ["uuid": $0.uuid.uuidString.uppercased(), "isPrimary": $0.isPrimary] }
    }

    private func deviceInfo(
        peripheral: CBPeripheral,
        advertisementData: [String: Any] = [:],
        rssi: NSNumber? = nil
    ) -> [String: Any] {
        let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? ""
        let serviceUUIDs = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []).map { $0.uuidString.uppercased() }
        var serviceDataResult: [String: Any] = [:]
        (advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] ?? [:]).forEach {
            serviceDataResult[$0.key.uuidString.uppercased()] = Self.arrayBuffer($0.value)
        }
        let advertisementBytes = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data ?? Data()
        return [
            "deviceId": peripheral.identifier.uuidString,
            "name": peripheral.name ?? localName,
            "localName": localName,
            "RSSI": rssi?.intValue ?? 0,
            "advertisData": Self.arrayBuffer(advertisementBytes),
            "advertisServiceUUIDs": serviceUUIDs,
            "serviceData": serviceDataResult,
        ]
    }

    private func connectedPeripheral(
        _ data: DMPMap,
        _ appId: String,
        _ name: String,
        _ callback: DMPBridgeCallback?
    ) -> (String, CBPeripheral)? {
        guard ensureInitialized(appId, name, callback) else { return nil }
        guard let deviceId = required(data, "deviceId", name, callback) else { return nil }
        guard let peripheral = peripherals[appId]?[deviceId], peripheral.state == .connected else {
            fail(name, callback, 10006, "no connection")
            return nil
        }
        return (deviceId, peripheral)
    }

    private func service(_ data: DMPMap, _ peripheral: CBPeripheral) -> CBService? {
        guard let value = data.getString(key: "serviceId") else { return nil }
        let uuid = CBUUID(string: value)
        return peripheral.services?.first { $0.uuid == uuid }
    }

    private func characteristic(
        _ data: DMPMap,
        _ peripheral: CBPeripheral,
        _ name: String,
        _ callback: DMPBridgeCallback?
    ) -> CBCharacteristic? {
        guard let service = service(data, peripheral) else {
            fail(name, callback, 10004, "no service")
            return nil
        }
        guard let value = data.getString(key: "characteristicId") else {
            fail(name, callback, 10013, "invalid_data")
            return nil
        }
        let uuid = CBUUID(string: value)
        guard let characteristic = service.characteristics?.first(where: { $0.uuid == uuid }) else {
            fail(name, callback, 10005, "no characteristic")
            return nil
        }
        return characteristic
    }

    private func peripheral(for deviceId: String, appId: String) -> CBPeripheral? {
        if let known = peripherals[appId]?[deviceId] { return known }
        guard let uuid = UUID(uuidString: deviceId) else { return nil }
        return central?.retrievePeripherals(withIdentifiers: [uuid]).first
    }

    private func owner(of peripheral: CBPeripheral) -> String? {
        let id = peripheral.identifier.uuidString
        return peripherals.first { $0.value[id] === peripheral }?.key
    }

    private func finish(_ appId: String, _ deviceId: String, expected: String, body: (DMPBridgeCallback?) -> Void) {
        let operationKey = key(appId, deviceId)
        guard let operation = pending[operationKey], operation.name == expected else { return }
        pending.removeValue(forKey: operationKey)
        operation.timeout?.cancel()
        body(operation.callback)
    }

    private func required(_ data: DMPMap, _ field: String, _ name: String, _ callback: DMPBridgeCallback?) -> String? {
        guard let value = data.getString(key: field), !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            fail(name, callback, 10013, "invalid_data")
            return nil
        }
        return value
    }

    private func ensureInitialized(_ appId: String, _ name: String, _ callback: DMPBridgeCallback?) -> Bool {
        if initializedApps.contains(appId) { return true }
        fail(name, callback, 10000, "not init")
        return false
    }

    private func ensureAvailable(_ appId: String, _ name: String, _ callback: DMPBridgeCallback?) -> Bool {
        guard ensureInitialized(appId, name, callback) else { return false }
        if central?.state == .poweredOn { return true }
        fail(name, callback, 10001, "not available")
        return false
    }

    private func addListener(
        _ store: inout [String: [String: DMPBridgeCallback]],
        _ data: DMPMap,
        _ appId: String,
        _ callback: DMPBridgeCallback?
    ) {
        guard let callback, let id = data.getString(key: "callbackId") ?? data.getString(key: "success") else { return }
        store[appId, default: [:]][id] = callback
    }

    private func removeListener(_ store: inout [String: [String: DMPBridgeCallback]], _ data: DMPMap, _ appId: String) {
        if let id = data.getString(key: "callbackId"), !id.isEmpty { store[appId]?.removeValue(forKey: id) }
        else { store.removeValue(forKey: appId) }
    }

    private func emit(_ listeners: [String: DMPBridgeCallback]?, _ value: [String: Any]) {
        listeners?.values.forEach { $0(DMPMap(value), .success) }
    }

    private func success(_ name: String, _ callback: DMPBridgeCallback?, _ value: [String: Any] = [:]) {
        var result = value
        result["errMsg"] = "\(name):ok"
        callback?(DMPMap(result), .success)
        callback?(DMPMap(), .complete)
    }

    private func fail(
        _ name: String,
        _ callback: DMPBridgeCallback?,
        _ code: Int,
        _ message: String,
        extra: [String: Any] = [:]
    ) {
        var result = extra
        result["errCode"] = code
        result["errMsg"] = "\(name):fail \(message)"
        callback?(DMPMap(result), .fail)
        callback?(DMPMap(), .complete)
    }

    private static func arrayBuffer(_ data: Data) -> [String: Any] {
        [arrayBufferKey: data.base64EncodedString()]
    }

    private func decodeArrayBuffer(_ value: Any?) -> Data? {
        guard let dictionary = value as? [String: Any], let base64 = dictionary[Self.arrayBufferKey] as? String else { return nil }
        return Data(base64Encoded: base64)
    }

    private func key(_ appId: String, _ deviceId: String) -> String { "\(appId)\u{0}\(deviceId)" }

    func clearApp(_ appId: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            scanningApps.remove(appId)
            if scanningApps.isEmpty { self.central?.stopScan() }
            peripherals[appId]?.values.forEach { self.central?.cancelPeripheralConnection($0) }
            initializedApps.remove(appId)
            discovered.removeValue(forKey: appId)
            peripherals.removeValue(forKey: appId)
            adapterListeners.removeValue(forKey: appId)
            deviceListeners.removeValue(forKey: appId)
            connectionListeners.removeValue(forKey: appId)
            characteristicListeners.removeValue(forKey: appId)
            mtuListeners.removeValue(forKey: appId)
            pending.keys.filter { $0.hasPrefix("\(appId)\u{0}") }.forEach {
                self.pending.removeValue(forKey: $0)?.timeout?.cancel()
            }
        }
    }
}
