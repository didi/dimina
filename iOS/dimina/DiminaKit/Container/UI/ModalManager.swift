//
//  ModalManager.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import UIKit

/// Completion handler for modal actions
public typealias ModalCompletionHandler = (Bool) -> Void

/// ModalManager is a singleton class that handles showing and hiding modal dialogs
public class ModalManager {
    
    // MARK: - Singleton
    
    /// Shared instance
    public static let shared = ModalManager()
    
    // MARK: - Properties
    
    /// Dedicated window for modals
    private var modalWindow: UIWindow?
    
    /// Modal container view
    private var containerView: UIView?
    
    /// Private initializer to enforce singleton pattern
    private init() {}
    
    // MARK: - Public Methods
    
    /// Show a modal dialog with the specified parameters
    /// - Parameters:
    ///   - title: The title of the modal
    ///   - content: The content message of the modal
    ///   - showCancel: Whether to show the cancel button
    ///   - cancelText: Text for the cancel button
    ///   - cancelColor: Color for the cancel button text
    ///   - confirmText: Text for the confirm button
    ///   - confirmColor: Color for the confirm button text
    ///   - completion: Completion handler called when a button is tapped
    public func showModal(
        title: String,
        content: String,
        showCancel: Bool = true,
        cancelText: String = "取消",
        cancelColor: String = "#000000",
        confirmText: String = "确定",
        confirmColor: String = "#576B95",
        completion: @escaping ModalCompletionHandler
    ) {
        // Ensure UI updates happen on the main thread
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            // Create a dedicated window for the modal
            self.createModalWindow()
            
            // Create modal content
            self.createModalContent(
                title: title,
                content: content,
                showCancel: showCancel,
                cancelText: cancelText,
                cancelColor: cancelColor,
                confirmText: confirmText,
                confirmColor: confirmColor,
                completion: completion
            )
            
            // Make the window visible
            self.modalWindow?.isHidden = false
            
            // Animate in
            UIView.animate(withDuration: 0.3) {
                self.modalWindow?.alpha = 1
                self.containerView?.transform = .identity
            }
        }
    }
    
    /// Hide the currently displayed modal
    private func hideModal(confirmed: Bool, completion: ModalCompletionHandler?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            // Animate out and remove modal window
            UIView.animate(withDuration: 0.2, animations: {
                self.modalWindow?.alpha = 0
                self.containerView?.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
            }) { _ in
                self.modalWindow?.isHidden = true
                self.modalWindow = nil
                self.containerView = nil
                
                // Call completion handler
                completion?(confirmed)
            }
        }
    }
    
    // MARK: - Private Methods
    
    /// Create a dedicated window for the modal
    private func createModalWindow() {
        // Create a new window
        if #available(iOS 13.0, *) {
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                let window = UIWindow(windowScene: windowScene)
                window.windowLevel = .alert + 1 // Above alerts
                window.backgroundColor = UIColor.black.withAlphaComponent(0.4) // Semi-transparent background
                self.modalWindow = window
            }
        } else {
            let window = UIWindow(frame: UIScreen.main.bounds)
            window.windowLevel = .alert + 1 // Above alerts
            window.backgroundColor = UIColor.black.withAlphaComponent(0.4) // Semi-transparent background
            self.modalWindow = window
        }
        
        // Set up the root view controller (required for window)
        let viewController = UIViewController()
        viewController.view.backgroundColor = .clear
        self.modalWindow?.rootViewController = viewController
        self.modalWindow?.alpha = 0
    }
    
    /// Create the modal content
    private func createModalContent(
        title: String,
        content: String,
        showCancel: Bool,
        cancelText: String,
        cancelColor: String,
        confirmText: String,
        confirmColor: String,
        completion: @escaping ModalCompletionHandler
    ) {
        guard let window = self.modalWindow, let rootView = window.rootViewController?.view else { return }
        
        // Create modal container
        let container = UIView()
        container.backgroundColor = .white
        container.layer.cornerRadius = 12
        container.clipsToBounds = true
        container.translatesAutoresizingMaskIntoConstraints = false
        rootView.addSubview(container)
        self.containerView = container
        
        // Apply initial transform for animation
        container.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
        
        // Create title label
        let titleLabel = UILabel()
        titleLabel.text = title
        titleLabel.textColor = .black
        titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .medium)
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(titleLabel)
        
        // Keep long content inside a dedicated scrolling region while the
        // title and action buttons remain fixed.
        let contentScrollView = UIScrollView()
        contentScrollView.alwaysBounceVertical = false
        contentScrollView.showsHorizontalScrollIndicator = false
        contentScrollView.translatesAutoresizingMaskIntoConstraints = false
        if #available(iOS 11.0, *) {
            contentScrollView.contentInsetAdjustmentBehavior = .never
        }
        container.addSubview(contentScrollView)

        // Create content label
        let contentLabel = UILabel()
        contentLabel.text = content
        contentLabel.textColor = UIColor.darkGray
        contentLabel.font = UIFont.systemFont(ofSize: 15)
        contentLabel.textAlignment = .center
        contentLabel.numberOfLines = 0
        contentLabel.translatesAutoresizingMaskIntoConstraints = false
        contentScrollView.addSubview(contentLabel)
        
        // Create separator line
        let separatorLine = UIView()
        separatorLine.backgroundColor = UIColor.lightGray.withAlphaComponent(0.3)
        separatorLine.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(separatorLine)
        
        // Create buttons container
        let buttonsContainer = UIView()
        buttonsContainer.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(buttonsContainer)
        
        // Create confirm button
        let confirmButton = UIButton(type: .system)
        confirmButton.setTitle(confirmText, for: .normal)
        confirmButton.setTitleColor(UIColor(hexString: confirmColor), for: .normal)
        confirmButton.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .medium)
        confirmButton.translatesAutoresizingMaskIntoConstraints = false
        confirmButton.addTarget(self, action: #selector(confirmButtonTapped(_:)), for: .touchUpInside)
        buttonsContainer.addSubview(confirmButton)
        
        // Store completion handler in button for later use
        confirmButton.layer.setValue(completion, forKey: "completionHandler")
        
        // Set up constraints for confirm button and buttons container
        var buttonConstraints = [
            confirmButton.topAnchor.constraint(equalTo: buttonsContainer.topAnchor),
            confirmButton.bottomAnchor.constraint(equalTo: buttonsContainer.bottomAnchor),
            confirmButton.heightAnchor.constraint(equalToConstant: 44)
        ]
        
        // Add cancel button if needed
        if showCancel {
            let cancelButton = UIButton(type: .system)
            cancelButton.setTitle(cancelText, for: .normal)
            cancelButton.setTitleColor(UIColor(hexString: cancelColor), for: .normal)
            cancelButton.titleLabel?.font = UIFont.systemFont(ofSize: 16)
            cancelButton.translatesAutoresizingMaskIntoConstraints = false
            cancelButton.addTarget(self, action: #selector(cancelButtonTapped(_:)), for: .touchUpInside)
            buttonsContainer.addSubview(cancelButton)
            
            // Store completion handler in button for later use
            cancelButton.layer.setValue(completion, forKey: "completionHandler")
            
            // Add vertical separator between buttons
            let buttonSeparator = UIView()
            buttonSeparator.backgroundColor = UIColor.lightGray.withAlphaComponent(0.3)
            buttonSeparator.translatesAutoresizingMaskIntoConstraints = false
            buttonsContainer.addSubview(buttonSeparator)
            
            // Add constraints for cancel button and separator
            buttonConstraints.append(contentsOf: [
                cancelButton.leadingAnchor.constraint(equalTo: buttonsContainer.leadingAnchor),
                cancelButton.topAnchor.constraint(equalTo: buttonsContainer.topAnchor),
                cancelButton.bottomAnchor.constraint(equalTo: buttonsContainer.bottomAnchor),
                cancelButton.widthAnchor.constraint(equalTo: confirmButton.widthAnchor),
                
                buttonSeparator.topAnchor.constraint(equalTo: buttonsContainer.topAnchor),
                buttonSeparator.bottomAnchor.constraint(equalTo: buttonsContainer.bottomAnchor),
                buttonSeparator.widthAnchor.constraint(equalToConstant: 1),
                buttonSeparator.leadingAnchor.constraint(equalTo: cancelButton.trailingAnchor),
                
                confirmButton.leadingAnchor.constraint(equalTo: buttonSeparator.trailingAnchor),
                confirmButton.trailingAnchor.constraint(equalTo: buttonsContainer.trailingAnchor)
            ])
        } else {
            // If no cancel button, confirm button takes full width
            buttonConstraints.append(contentsOf: [
                confirmButton.leadingAnchor.constraint(equalTo: buttonsContainer.leadingAnchor),
                confirmButton.trailingAnchor.constraint(equalTo: buttonsContainer.trailingAnchor)
            ])
        }
        
        // Activate button constraints
        NSLayoutConstraint.activate(buttonConstraints)
        
        let contentHeightConstraint = contentScrollView.heightAnchor.constraint(
            equalTo: contentLabel.heightAnchor,
            constant: 0
        )
        contentHeightConstraint.priority = .defaultHigh

        // Set up main container constraints
        var containerConstraints = [
            // Container constraints
            container.centerXAnchor.constraint(equalTo: rootView.centerXAnchor),
            container.centerYAnchor.constraint(equalTo: rootView.centerYAnchor),
            container.widthAnchor.constraint(equalToConstant: 280),
            container.heightAnchor.constraint(lessThanOrEqualTo: rootView.safeAreaLayoutGuide.heightAnchor, multiplier: 0.9),
            
            // Title constraints
            titleLabel.topAnchor.constraint(equalTo: container.topAnchor, constant: 20),
            titleLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            titleLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
            
            // Content constraints
            contentScrollView.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 12),
            contentScrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            contentScrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            contentLabel.topAnchor.constraint(equalTo: contentScrollView.contentLayoutGuide.topAnchor),
            contentLabel.bottomAnchor.constraint(equalTo: contentScrollView.contentLayoutGuide.bottomAnchor),
            contentLabel.leadingAnchor.constraint(equalTo: contentScrollView.contentLayoutGuide.leadingAnchor, constant: 16),
            contentLabel.trailingAnchor.constraint(equalTo: contentScrollView.contentLayoutGuide.trailingAnchor, constant: -16),
            contentLabel.widthAnchor.constraint(equalTo: contentScrollView.frameLayoutGuide.widthAnchor, constant: -32),
            
            // Separator line constraints
            separatorLine.topAnchor.constraint(equalTo: contentScrollView.bottomAnchor, constant: 20),
            separatorLine.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            separatorLine.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            separatorLine.heightAnchor.constraint(equalToConstant: 1),
            
            // Buttons container constraints
            buttonsContainer.topAnchor.constraint(equalTo: separatorLine.bottomAnchor),
            buttonsContainer.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            buttonsContainer.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            buttonsContainer.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ]
        containerConstraints.append(contentHeightConstraint)
        NSLayoutConstraint.activate(containerConstraints)
    }
    
    // MARK: - Button Actions
    
    @objc private func cancelButtonTapped(_ sender: UIButton) {
        if let completion = sender.layer.value(forKey: "completionHandler") as? ModalCompletionHandler {
            hideModal(confirmed: false, completion: completion)
        }
    }
    
    @objc private func confirmButtonTapped(_ sender: UIButton) {
        if let completion = sender.layer.value(forKey: "completionHandler") as? ModalCompletionHandler {
            hideModal(confirmed: true, completion: completion)
        }
    }
}

// MARK: - UIColor Extension

extension UIColor {
    convenience init(hexString: String) {
        let hex = hexString.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int = UInt64()
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3: // RGB (12-bit)
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // RGB (24-bit)
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // ARGB (32-bit)
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: CGFloat(a) / 255)
    }
}
