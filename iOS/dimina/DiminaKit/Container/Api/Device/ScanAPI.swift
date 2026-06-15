//
//  ScanAPI.swift
//  dimina
//
//  Created by Codex on 2026/6/10.
//

import AVFoundation
import Foundation
import UIKit

/**
 * Device - Scan API
 */
public class ScanAPI: DMPContainerApi {
    fileprivate static let SCAN_CODE = "scanCode"

    @BridgeMethod(SCAN_CODE)
    var scanCode: DMPBridgeMethodHandler = { param, env, callback in
        let options = DMPScanCodeOptions.from(param.getMap())
        guard !options.scanTypes.isEmpty else {
            let result = DMPMap()
            result.set("errMsg", "\(SCAN_CODE):fail invalid scanType")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "invalid scanType")
            return DMPAsyncResult()
        }

        guard DMPPermissionManager.shared.isPermissionConfigured(.camera) else {
            let result = DMPMap()
            result.set("errMsg", "\(SCAN_CODE):fail camera permission not configured")
            DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "camera permission not configured")
            return DMPAsyncResult()
        }

        DMPPermissionManager.shared.requestPermission(.camera) { status in
            guard status == .authorized else {
                let result = DMPMap()
                result.set("errMsg", "\(SCAN_CODE):fail auth denied")
                DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "auth denied")
                return
            }

            DispatchQueue.main.async {
                guard let topVC = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() else {
                    let result = DMPMap()
                    result.set("errMsg", "\(SCAN_CODE):fail cannot find view controller")
                    DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: "cannot find view controller")
                    return
                }

                let scanner = DMPScanCodeViewController(options: options)
                scanner.modalPresentationStyle = .fullScreen
                scanner.onSuccess = { result in
                    DMPContainerApi.invokeSuccess(callback: callback, param: result)
                }
                scanner.onFailure = { message in
                    let result = DMPMap()
                    result.set("errMsg", "\(SCAN_CODE):fail \(message)")
                    DMPContainerApi.invokeFailure(callback: callback, param: result, errMsg: message)
                }
                topVC.present(scanner, animated: true)
            }
        }

        return DMPAsyncResult()
    }
}

private struct DMPScanCodeOptions {
    let onlyFromCamera: Bool
    let scanTypes: [String]

    static func from(_ map: DMPMap) -> DMPScanCodeOptions {
        let rawScanTypes = map.get("scanType")
        let requestedTypes: [String]?
        if let scanTypes = rawScanTypes as? [String] {
            requestedTypes = scanTypes
        } else if let scanTypes = rawScanTypes as? [Any] {
            requestedTypes = scanTypes.compactMap { $0 as? String }
        } else if rawScanTypes != nil {
            requestedTypes = []
        } else {
            requestedTypes = nil
        }

        let scanTypes: [String]
        if requestedTypes == nil || requestedTypes?.isEmpty == true {
            scanTypes = DMPScanCodeFormats.defaultScanTypes
        } else {
            scanTypes = DMPScanCodeOptions.uniqueSupportedTypes(requestedTypes ?? [])
        }

        return DMPScanCodeOptions(
            onlyFromCamera: map.getBool(key: "onlyFromCamera") ?? false,
            scanTypes: scanTypes
        )
    }

    private static func uniqueSupportedTypes(_ requestedTypes: [String]) -> [String] {
        var uniqueTypes: [String] = []
        for scanType in requestedTypes {
            if DMPScanCodeFormats.supports(scanType), !uniqueTypes.contains(scanType) {
                uniqueTypes.append(scanType)
            }
        }
        return uniqueTypes
    }
}

private enum DMPScanCodeFormats {
    static let defaultScanTypes = ["barCode", "qrCode"]

    static func supports(_ scanType: String) -> Bool {
        return ["barCode", "qrCode", "datamatrix", "pdf417"].contains(scanType)
    }

    static func metadataObjectTypes(for scanTypes: [String]) -> [AVMetadataObject.ObjectType] {
        var result: [AVMetadataObject.ObjectType] = []
        for scanType in scanTypes {
            for metadataType in metadataObjectTypes(for: scanType) {
                if !result.contains(metadataType) {
                    result.append(metadataType)
                }
            }
        }
        return result
    }

    private static func metadataObjectTypes(for scanType: String) -> [AVMetadataObject.ObjectType] {
        switch scanType {
        case "barCode":
            var types: [AVMetadataObject.ObjectType] = [
                .code39,
                .code39Mod43,
                .code93,
                .code128,
                .ean8,
                .ean13,
                .interleaved2of5,
                .itf14,
                .upce,
            ]
            if #available(iOS 15.4, *) {
                types.append(contentsOf: [
                    .codabar,
                    .gs1DataBar,
                    .gs1DataBarExpanded,
                    .gs1DataBarLimited,
                ])
            }
            return types
        case "qrCode":
            return [.qr]
        case "datamatrix":
            return [.dataMatrix]
        case "pdf417":
            return [.pdf417]
        default:
            return []
        }
    }

    static func resultScanType(for metadataType: AVMetadataObject.ObjectType) -> String {
        switch metadataType {
        case .qr:
            return "QR_CODE"
        case .dataMatrix:
            return "DATA_MATRIX"
        case .pdf417:
            return "PDF_417"
        case .code39, .code39Mod43:
            return "CODE_39"
        case .code93:
            return "CODE_93"
        case .code128:
            return "CODE_128"
        case .ean8:
            return "EAN_8"
        case .ean13:
            return "EAN_13"
        case .upce:
            return "UPC_E"
        case .interleaved2of5, .itf14:
            return "ITF"
        default:
            if #available(iOS 15.4, *) {
                switch metadataType {
                case .codabar:
                    return "CODABAR"
                case .gs1DataBar:
                    return "RSS_14"
                case .gs1DataBarExpanded:
                    return "RSS_EXPANDED"
                case .gs1DataBarLimited:
                    return "RSS_14"
                default:
                    break
                }
            }
            return metadataType.rawValue
        }
    }
}

private final class DMPScanCodeViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private enum Layout {
        static let closeButtonSize: CGFloat = 44
        static let closeButtonSideMargin: CGFloat = 16
        static let closeButtonTopMargin: CGFloat = 32
    }

    var onSuccess: ((DMPMap) -> Void)?
    var onFailure: ((String) -> Void)?

    private let options: DMPScanCodeOptions
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.didi.dimina.scancode.session")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didFinish = false

    init(options: DMPScanCodeOptions) {
        self.options = options
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        setupCloseButton()
        setupSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopSession()
    }

    private func setupCloseButton() {
        let closeButton = DMPScanCloseButton()
        closeButton.accessibilityLabel = "Close"
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(closeButton)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: Layout.closeButtonSideMargin),
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Layout.closeButtonTopMargin),
            closeButton.widthAnchor.constraint(equalToConstant: Layout.closeButtonSize),
            closeButton.heightAnchor.constraint(equalTo: closeButton.widthAnchor),
        ])
    }

    private func setupSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            finishFailure("camera unavailable")
            return
        }

        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                finishFailure("cannot add camera input")
                return
            }
            session.addInput(input)
        } catch {
            finishFailure(error.localizedDescription)
            return
        }

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            finishFailure("cannot add metadata output")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)

        let requestedTypes = DMPScanCodeFormats.metadataObjectTypes(for: options.scanTypes)
        let supportedTypes = requestedTypes.filter { output.availableMetadataObjectTypes.contains($0) }
        guard !supportedTypes.isEmpty else {
            finishFailure("no supported scan types")
            return
        }
        output.metadataObjectTypes = supportedTypes

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        previewLayer = layer

        sessionQueue.async { [weak self] in
            self?.session.startRunning()
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !didFinish,
              let readableObject = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let result = readableObject.stringValue else {
            return
        }

        let scanType = DMPScanCodeFormats.resultScanType(for: readableObject.type)
        let rawData = result.data(using: .utf8)?.base64EncodedString() ?? ""
        let map = DMPMap()
        map.set("result", result)
        map.set("scanType", scanType)
        map.set("charSet", "UTF-8")
        map.set("rawData", rawData)
        map.set("path", scanType == "QR_CODE" && result.hasPrefix("/") ? result : "")
        map.set("errMsg", "\(ScanAPI.SCAN_CODE):ok")
        finishSuccess(map)
    }

    @objc private func closeTapped() {
        finishFailure("cancel")
    }

    private func finishSuccess(_ result: DMPMap) {
        guard !didFinish else { return }
        didFinish = true
        stopSession()
        DispatchQueue.main.async {
            let notify: () -> Void = {
                self.onSuccess?(result)
            }
            if self.presentingViewController != nil {
                self.dismiss(animated: true, completion: notify)
            } else {
                notify()
            }
        }
    }

    private func finishFailure(_ message: String) {
        guard !didFinish else { return }
        didFinish = true
        stopSession()
        DispatchQueue.main.async {
            let notify: () -> Void = {
                self.onFailure?(message)
            }
            if self.presentingViewController != nil {
                self.dismiss(animated: true, completion: notify)
            } else {
                notify()
            }
        }
    }

    private func stopSession() {
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }
}

private final class DMPScanCloseButton: UIControl {
    private enum Metrics {
        static let iconSize: CGFloat = 14
        static let lineWidth: CGFloat = 2
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let half = Metrics.iconSize / 2
        let path = UIBezierPath()
        path.lineWidth = Metrics.lineWidth
        path.lineCapStyle = .round
        path.move(to: CGPoint(x: center.x - half, y: center.y - half))
        path.addLine(to: CGPoint(x: center.x + half, y: center.y + half))
        path.move(to: CGPoint(x: center.x + half, y: center.y - half))
        path.addLine(to: CGPoint(x: center.x - half, y: center.y + half))
        UIColor.white.setStroke()
        path.stroke()
    }
}
