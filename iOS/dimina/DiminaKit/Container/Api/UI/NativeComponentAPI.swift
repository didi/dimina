//
//  NativeComponentAPI.swift
//  dimina
//

import AVFoundation
import Foundation
import UIKit
import WebKit

public class NativeComponentAPI: DMPContainerApi {
    private static let COMPONENT_MOUNT = "componentMount"
    private static let PROPS_UPDATE = "propsUpdate"
    private static let COMPONENT_UNMOUNT = "componentUnmount"
    private static let VIDEO_CONTEXT = "videoContext"

    @BridgeMethod(COMPONENT_MOUNT)
    var componentMount: DMPBridgeMethodHandler = { param, env, _ in
        NativeComponentAPI.handleComponent(apiName: COMPONENT_MOUNT, param: param, env: env)
        return DMPNoneResult()
    }

    @BridgeMethod(PROPS_UPDATE)
    var propsUpdate: DMPBridgeMethodHandler = { param, env, _ in
        NativeComponentAPI.handleComponent(apiName: PROPS_UPDATE, param: param, env: env)
        return DMPNoneResult()
    }

    @BridgeMethod(COMPONENT_UNMOUNT)
    var componentUnmount: DMPBridgeMethodHandler = { param, env, _ in
        NativeComponentAPI.handleComponent(apiName: COMPONENT_UNMOUNT, param: param, env: env)
        return DMPNoneResult()
    }

    @BridgeMethod(VIDEO_CONTEXT)
    var videoContext: DMPBridgeMethodHandler = { param, env, _ in
        NativeComponentAPI.handleComponent(apiName: VIDEO_CONTEXT, param: param, env: env)
        return DMPNoneResult()
    }

    private static func handleComponent(apiName: String, param: DMPBridgeParam, env: DMPBridgeEnv) {
        let params = param.getMap()
        let type = params.getString(key: "type") ?? "native/video"
        guard type == "native/video" else { return }

        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex),
              let webview = app.render?.getWebView(byId: env.webViewId) else {
            return
        }

        DispatchQueue.main.async {
            let host = DMPIOSNativeComponentHost.host(for: webview, app: app, webViewId: env.webViewId)
            host.handle(apiName: apiName, params: params)
        }
    }

    public static func clear(webViewId: Int) {
        DispatchQueue.main.async {
            DMPIOSNativeComponentHost.clear(webViewId: webViewId)
        }
    }
}

private final class DMPIOSNativeComponentHost {
    private static var hosts: [Int: DMPIOSNativeComponentHost] = [:]

    private weak var app: DMPApp?
    private weak var webview: DMPWebview?
    private weak var wkWebView: WKWebView?
    private let webViewId: Int
    private let overlayView = DMPPassthroughView()
    private var videos: [String: DMPIOSNativeVideoComponent] = [:]
    private var scrollObservation: NSKeyValueObservation?

    static func host(for webview: DMPWebview, app: DMPApp, webViewId: Int) -> DMPIOSNativeComponentHost {
        if let host = hosts[webViewId] {
            return host
        }
        let host = DMPIOSNativeComponentHost(webview: webview, app: app, webViewId: webViewId)
        hosts[webViewId] = host
        return host
    }

    static func clear(webViewId: Int) {
        guard let host = hosts.removeValue(forKey: webViewId) else { return }
        host.release()
    }

    private init(webview: DMPWebview, app: DMPApp, webViewId: Int) {
        self.webview = webview
        self.wkWebView = webview.getWebView()
        self.app = app
        self.webViewId = webViewId

        overlayView.backgroundColor = .clear
        overlayView.clipsToBounds = true

        if let wkWebView = wkWebView {
            wkWebView.clipsToBounds = true
            overlayView.frame = wkWebView.bounds
            overlayView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            wkWebView.addSubview(overlayView)
            scrollObservation = wkWebView.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                self?.updateLayouts()
            }
        }
    }

    func handle(apiName: String, params: DMPMap) {
        guard let id = params.getString(key: "id"), !id.isEmpty else { return }
        switch apiName {
        case "componentMount":
            mountVideo(id: id, params: params)
        case "propsUpdate":
            updateVideo(id: id, params: params)
        case "componentUnmount":
            unmountVideo(id: id)
        case "videoContext":
            videos[id]?.handleCommand(params)
        default:
            break
        }
    }

    private func release() {
        scrollObservation = nil
        videos.values.forEach { $0.release() }
        videos.removeAll()
        overlayView.removeFromSuperview()
    }

    private func mountVideo(id: String, params: DMPMap) {
        let video = videos[id] ?? DMPIOSNativeVideoComponent(id: id, host: self)
        if videos[id] == nil {
            videos[id] = video
            overlayView.addSubview(video.view)
        }
        video.update(params)
    }

    private func updateVideo(id: String, params: DMPMap) {
        if let video = videos[id] {
            video.update(params)
        } else {
            mountVideo(id: id, params: params)
        }
    }

    private func unmountVideo(id: String) {
        guard let video = videos.removeValue(forKey: id) else { return }
        video.release()
        video.view.removeFromSuperview()
    }

    fileprivate func updateLayouts() {
        overlayView.frame = wkWebView?.bounds ?? .zero
        videos.values.forEach { $0.applyLastLayout() }
    }

    fileprivate func calculateLayout(_ params: DMPMap) -> CGRect? {
        guard let rect = params.getDMPMap(key: "rect"), let wkWebView = wkWebView else { return nil }
        let width = rect.getDouble(key: "width") ?? 0
        let height = rect.getDouble(key: "height") ?? 0
        if width <= 0 || height <= 0 { return nil }

        let scrollOffset = wkWebView.scrollView.contentOffset
        let pageLeft = rect.getDouble(key: "pageLeft") ?? rect.getDouble(key: "left") ?? 0
        let pageTop = rect.getDouble(key: "pageTop") ?? rect.getDouble(key: "top") ?? 0
        return CGRect(
            x: pageLeft - scrollOffset.x,
            y: pageTop - scrollOffset.y,
            width: width,
            height: height
        )
    }

    fileprivate func sendEvent(_ eventName: String, body: [String: Any]) {
        let msg = DMPMap([
            "type": eventName,
            "body": body,
        ])
        DMPChannelProxy.containerToRender(msg: msg, app: app, webViewId: webViewId)
    }
}

private final class DMPPassthroughView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hitView = super.hitTest(point, with: event)
        return hitView === self ? nil : hitView
    }
}

private final class DMPIOSNativeVideoComponent: NSObject, UIGestureRecognizerDelegate {
    let view = UIView()
    private weak var host: DMPIOSNativeComponentHost?
    private let id: String
    private let playerLayer = AVPlayerLayer()
    private let controlBar = UIView()
    private let playButton = UIButton(type: .system)
    private let seekSlider = UISlider()
    private let timeLabel = UILabel()
    private let centerPlayButton = UIButton(type: .system)
    private var player: AVPlayer?
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var lastParams: DMPMap?
    private var src = ""
    private var controls = true
    private var controlsVisible = true
    private var showProgress = true
    private var showPlayBtn = true
    private var showCenterPlayBtn = true
    private var autoplay = false
    private var loop = false
    private var muted = false
    private var initialTime: Double = 0
    private var playbackRate: Float = 1
    private var isUserSeeking = false
    private var pendingPlay = false
    private var playbackRequested = false
    private lazy var tapRecognizer: UITapGestureRecognizer = {
        let recognizer = UITapGestureRecognizer(target: self, action: #selector(toggleControlBar))
        recognizer.cancelsTouchesInView = false
        recognizer.delegate = self
        return recognizer
    }()

    init(id: String, host: DMPIOSNativeComponentHost) {
        self.id = id
        self.host = host
        super.init()

        view.backgroundColor = .black
        view.isUserInteractionEnabled = true
        view.addGestureRecognizer(tapRecognizer)
        playerLayer.videoGravity = .resizeAspect
        view.layer.addSublayer(playerLayer)
        setupControls()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(playerDidEnd),
            name: .AVPlayerItemDidPlayToEndTime,
            object: nil
        )
    }

    func update(_ params: DMPMap) {
        lastParams = params
        applyLayout()

        autoplay = params.getBool(key: "autoplay") ?? autoplay
        loop = params.getBool(key: "loop") ?? loop
        muted = params.getBool(key: "muted") ?? muted
        initialTime = params.getDouble(key: "initialTime") ?? initialTime
        controls = params.getBool(key: "controls") ?? controls
        showProgress = params.getBool(key: "showProgress") ?? showProgress
        showPlayBtn = params.getBool(key: "showPlayBtn") ?? showPlayBtn
        showCenterPlayBtn = params.getBool(key: "showCenterPlayBtn") ?? showCenterPlayBtn
        playerLayer.videoGravity = videoGravity(for: params.getString(key: "objectFit"))

        player?.isMuted = muted
        applyControlsVisibility()

        let nextSrc = params.getString(key: "src") ?? src
        if nextSrc != src {
            src = nextSrc
            loadSource()
        } else if autoplay {
            play()
        }
    }

    func applyLastLayout() {
        applyLayout()
    }

    private func applyLayout() {
        guard let lastParams, let frame = host?.calculateLayout(lastParams) else {
            view.isHidden = true
            return
        }
        let hidden = lastParams.getBool(key: "hidden") ?? false
        view.isHidden = hidden
        view.frame = frame
        playerLayer.frame = view.bounds
        layoutControls()
    }

    func handleCommand(_ params: DMPMap) {
        switch params.getString(key: "command") {
        case "play":
            play()
        case "pause":
            pause()
        case "stop":
            stop()
        case "seek":
            seek(params.getDouble(key: "position") ?? 0)
        case "playbackRate":
            playbackRate = Float(params.getDouble(key: "rate") ?? 1)
            if player?.timeControlStatus == .playing {
                player?.rate = playbackRate
            }
        default:
            break
        }
    }

    func release() {
        if let timeObserver {
            player?.removeTimeObserver(timeObserver)
        }
        timeObserver = nil
        statusObservation = nil
        player?.pause()
        player = nil
        playerLayer.player = nil
        NotificationCenter.default.removeObserver(self)
    }

    private func loadSource() {
        if let timeObserver {
            player?.removeTimeObserver(timeObserver)
        }
        timeObserver = nil
        statusObservation = nil
        pendingPlay = autoplay
        playbackRequested = autoplay
        player?.pause()
        player = nil
        playerLayer.player = nil
        updatePlayButton()
        updateControlProgress()

        guard let url = makeURL(src) else { return }

        let item = AVPlayerItem(url: url)
        let nextPlayer = AVPlayer(playerItem: item)
        nextPlayer.isMuted = muted
        player = nextPlayer
        playerLayer.player = nextPlayer
        installTimeObserver()
        observeItemStatus(item)
    }

    private func observeItemStatus(_ item: AVPlayerItem) {
        statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                switch item.status {
                case .readyToPlay:
                    self.handleReadyToPlay()
                case .failed:
                    self.pendingPlay = false
                    self.playbackRequested = false
                    self.updatePlayButton()
                    self.host?.sendEvent("binderror", body: [
                        "id": self.id,
                        "src": self.src,
                        "errMsg": self.playerItemErrorMessage(item),
                    ])
                default:
                    break
                }
            }
        }
    }

    private func handleReadyToPlay() {
        if initialTime > 0 {
            seek(initialTime)
        } else {
            seek(0.001)
        }

        host?.sendEvent("bindloadedmetadata", body: [
            "id": id,
            "src": src,
            "duration": durationSeconds(),
        ])
        updateControlProgress()
        if autoplay || pendingPlay {
            pendingPlay = false
            play()
        } else {
            updatePlayButton()
        }
    }

    private func installTimeObserver() {
        timeObserver = player?.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }
            self.updateControlProgress()
            self.host?.sendEvent("bindtimeupdate", body: [
                "id": self.id,
                "src": self.src,
                "currentTime": CMTimeGetSeconds(time),
                "duration": self.durationSeconds(),
            ])
        }
    }

    private func play() {
        playbackRequested = true
        guard let player, player.currentItem?.status == .readyToPlay else {
            pendingPlay = true
            updatePlayButton()
            return
        }
        player.play()
        if playbackRate != 1 {
            player.rate = playbackRate
        }
        pendingPlay = false
        updatePlayButton()
        updateControlProgress()
        host?.sendEvent("bindplay", body: ["id": id, "src": src])
    }

    private func pause() {
        pendingPlay = false
        playbackRequested = false
        player?.pause()
        updatePlayButton()
        updateControlProgress()
        host?.sendEvent("bindpause", body: ["id": id, "src": src])
    }

    private func stop() {
        pendingPlay = false
        playbackRequested = false
        player?.pause()
        seek(0)
        updatePlayButton()
        updateControlProgress()
        host?.sendEvent("bindpause", body: ["id": id, "src": src])
    }

    private func seek(_ seconds: Double) {
        let time = CMTime(seconds: max(seconds, 0), preferredTimescale: 600)
        player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                self?.updateControlProgress()
            }
        }
    }

    @objc private func playerDidEnd(_ notification: Notification) {
        guard notification.object as? AVPlayerItem === player?.currentItem else { return }
        pendingPlay = false
        playbackRequested = false
        updatePlayButton()
        updateControlProgress()
        host?.sendEvent("bindended", body: ["id": id, "src": src])
        if loop {
            seek(0)
            play()
        }
    }

    private func setupControls() {
        controlBar.backgroundColor = UIColor(white: 0, alpha: 0.43)
        controlBar.isUserInteractionEnabled = true
        view.addSubview(controlBar)

        playButton.tintColor = .white
        playButton.setImage(UIImage(systemName: "play.fill"), for: .normal)
        playButton.addTarget(self, action: #selector(playButtonTapped), for: .touchUpInside)
        controlBar.addSubview(playButton)

        seekSlider.minimumValue = 0
        seekSlider.maximumValue = 1
        seekSlider.value = 0
        seekSlider.minimumTrackTintColor = .white
        seekSlider.maximumTrackTintColor = UIColor(white: 1, alpha: 0.47)
        seekSlider.thumbTintColor = .white
        let thumbImage = makeSliderThumbImage(diameter: 10)
        seekSlider.setThumbImage(thumbImage, for: .normal)
        seekSlider.setThumbImage(thumbImage, for: .highlighted)
        seekSlider.addTarget(self, action: #selector(sliderTouchDown), for: .touchDown)
        seekSlider.addTarget(self, action: #selector(sliderValueChanged(_:)), for: .valueChanged)
        seekSlider.addTarget(self, action: #selector(sliderTouchEnded(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        controlBar.addSubview(seekSlider)

        timeLabel.text = "00:00/00:00"
        timeLabel.textColor = .white
        timeLabel.textAlignment = .center
        timeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        controlBar.addSubview(timeLabel)

        centerPlayButton.tintColor = .white
        centerPlayButton.backgroundColor = UIColor(white: 0, alpha: 0.47)
        centerPlayButton.layer.cornerRadius = 28
        centerPlayButton.clipsToBounds = true
        centerPlayButton.setImage(UIImage(systemName: "play.fill"), for: .normal)
        centerPlayButton.addTarget(self, action: #selector(centerPlayButtonTapped), for: .touchUpInside)
        view.addSubview(centerPlayButton)

        applyControlsVisibility()
    }

    private func layoutControls() {
        playerLayer.frame = view.bounds

        let controlHeight = min(CGFloat(44), view.bounds.height)
        controlBar.frame = CGRect(
            x: 0,
            y: max(0, view.bounds.height - controlHeight),
            width: view.bounds.width,
            height: controlHeight
        )

        let playButtonWidth = showPlayBtn ? CGFloat(40) : 0
        playButton.frame = CGRect(x: 0, y: 0, width: playButtonWidth, height: controlHeight)

        let horizontalPadding = CGFloat(8)
        let labelWidth = showProgress ? CGFloat(86) : 0
        timeLabel.frame = CGRect(
            x: max(0, controlBar.bounds.width - horizontalPadding - labelWidth),
            y: 0,
            width: labelWidth,
            height: controlHeight
        )

        let sliderX = showPlayBtn ? playButton.frame.maxX : horizontalPadding
        let sliderRight = showProgress ? timeLabel.frame.minX - horizontalPadding : controlBar.bounds.width - horizontalPadding
        seekSlider.frame = CGRect(
            x: sliderX,
            y: 0,
            width: max(0, sliderRight - sliderX),
            height: controlHeight
        )

        let centerSize = CGFloat(56)
        centerPlayButton.frame = CGRect(
            x: (view.bounds.width - centerSize) / 2,
            y: (view.bounds.height - centerSize) / 2,
            width: centerSize,
            height: centerSize
        )

        view.bringSubviewToFront(controlBar)
        view.bringSubviewToFront(centerPlayButton)
    }

    private func applyControlsVisibility() {
        if !controls {
            controlsVisible = false
        } else if controlBar.isHidden {
            controlsVisible = true
        }

        controlBar.isHidden = !(controls && controlsVisible)
        playButton.isHidden = !showPlayBtn
        seekSlider.isHidden = !showProgress
        timeLabel.isHidden = !showProgress
        layoutControls()
        updatePlayButton()
        updateControlProgress()
    }

    @objc private func toggleControlBar() {
        if !controls {
            return
        }
        controlsVisible.toggle()
        applyControlsVisibility()
    }

    @objc private func playButtonTapped() {
        togglePlay()
    }

    @objc private func centerPlayButtonTapped() {
        play()
    }

    @objc private func sliderTouchDown() {
        isUserSeeking = true
    }

    @objc private func sliderValueChanged(_ sender: UISlider) {
        timeLabel.text = formatVideoTime(position: Double(sender.value), duration: durationSeconds())
    }

    @objc private func sliderTouchEnded(_ sender: UISlider) {
        isUserSeeking = false
        seek(Double(sender.value))
    }

    private func togglePlay() {
        if isPlaybackActive {
            pause()
        } else {
            play()
        }
    }

    private var isPlaybackActive: Bool {
        playbackRequested ||
        player?.timeControlStatus == .playing ||
        player?.timeControlStatus == .waitingToPlayAtSpecifiedRate ||
        (player?.rate ?? 0) > 0
    }

    private func updatePlayButton() {
        let imageName = isPlaybackActive ? "pause.fill" : "play.fill"
        playButton.setImage(UIImage(systemName: imageName), for: .normal)
        centerPlayButton.isHidden = !(
            controls &&
            controlsVisible &&
            showCenterPlayBtn &&
            !isPlaybackActive
        )
    }

    private func updateControlProgress() {
        if !controls || isUserSeeking {
            return
        }
        let duration = durationSeconds()
        let currentTime = currentTimeSeconds()
        seekSlider.maximumValue = Float(max(duration, 1))
        seekSlider.value = Float(min(max(currentTime, 0), Double(seekSlider.maximumValue)))
        timeLabel.text = formatVideoTime(position: currentTime, duration: duration)
    }

    private func currentTimeSeconds() -> Double {
        guard let currentTime = player?.currentTime() else { return 0 }
        let seconds = CMTimeGetSeconds(currentTime)
        return seconds.isFinite ? seconds : 0
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if touch.view is UIControl {
            return false
        }
        let point = touch.location(in: view)
        if !controlBar.isHidden && controlBar.frame.contains(point) {
            return false
        }
        if !centerPlayButton.isHidden && centerPlayButton.frame.contains(point) {
            return false
        }
        return true
    }

    private func videoGravity(for objectFit: String?) -> AVLayerVideoGravity {
        switch objectFit {
        case "fill":
            return .resize
        case "cover":
            return .resizeAspectFill
        default:
            return .resizeAspect
        }
    }

    private func durationSeconds() -> Double {
        guard let duration = player?.currentItem?.duration else { return 0 }
        let seconds = CMTimeGetSeconds(duration)
        return seconds.isFinite ? seconds : 0
    }

    private func playerItemErrorMessage(_ item: AVPlayerItem) -> String {
        var messages: [String] = []
        if let error = item.error as NSError? {
            messages.append("\(error.domain)(\(error.code)): \(error.localizedDescription)")
            if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
                messages.append("underlying \(underlying.domain)(\(underlying.code)): \(underlying.localizedDescription)")
            }
        }
        if let event = item.errorLog()?.events.last {
            messages.append("server \(event.errorStatusCode): \(event.errorComment ?? "") \(event.uri ?? "")")
        }
        return messages.isEmpty ? "video:error" : messages.joined(separator: "; ")
    }

    private func makeURL(_ src: String) -> URL? {
        if src.isEmpty {
            return nil
        }
        if src.hasPrefix("http://") || src.hasPrefix("https://") || src.hasPrefix("file://") {
            return URL(string: src)
        }
        return URL(fileURLWithPath: src)
    }
}

private func formatVideoTime(position: Double, duration: Double) -> String {
    return "\(formatVideoTimePart(position))/\(formatVideoTimePart(max(duration, 0)))"
}

private func formatVideoTimePart(_ time: Double) -> String {
    let totalSeconds = max(Int(time), 0)
    let minutes = totalSeconds / 60
    let seconds = totalSeconds % 60
    return String(format: "%02d:%02d", minutes, seconds)
}

private func makeSliderThumbImage(diameter: CGFloat) -> UIImage {
    let size = CGSize(width: diameter, height: diameter)
    let renderer = UIGraphicsImageRenderer(size: size)
    return renderer.image { _ in
        UIColor.white.setFill()
        UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
    }.withRenderingMode(.alwaysOriginal)
}
