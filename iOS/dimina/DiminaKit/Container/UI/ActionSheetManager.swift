//
//  ActionSheetManager.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import UIKit

/// Completion handler for action sheet selection
public typealias ActionSheetCompletionHandler = (Int) -> Void

/// ActionSheetManager is a singleton class that handles showing action sheets
public class ActionSheetManager {
    
    // MARK: - Singleton
    
    /// Shared instance
    public static let shared = ActionSheetManager()
    
    // MARK: - Properties
    
    /// Dedicated window for action sheets
    private var actionSheetWindow: UIWindow?
    
    /// Action sheet container view
    private var containerView: UIView?
    
    /// Background view for dimming
    private var backgroundView: UIView?
    
    /// Private initializer to enforce singleton pattern
    private init() {}
    
    // MARK: - Public Methods
    
    /// Show an action sheet with the specified items
    /// - Parameters:
    ///   - itemList: List of items to display in the action sheet
    ///   - itemColor: Color for the item text
    ///   - completion: Completion handler called when an item is selected
    public func showActionSheet(
        itemList: [String],
        itemColor: String = "#000000",
        completion: @escaping ActionSheetCompletionHandler
    ) {
        // Ensure UI updates happen on the main thread
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            // Create a dedicated window for the action sheet
            self.createActionSheetWindow()
            
            // Create action sheet content
            self.createActionSheetContent(
                itemList: itemList,
                itemColor: itemColor,
                completion: completion
            )
            
            // Make the window visible
            self.actionSheetWindow?.isHidden = false
            
            // Animate in
            UIView.animate(withDuration: 0.3) {
                self.backgroundView?.alpha = 1
                self.containerView?.transform = .identity
            }
        }
    }
    
    /// Hide the currently displayed action sheet
    private func hideActionSheet(selectedIndex: Int, completion: ActionSheetCompletionHandler?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            // Animate out and remove action sheet window
            UIView.animate(withDuration: 0.2, animations: {
                self.backgroundView?.alpha = 0
                if let containerView = self.containerView {
                    containerView.transform = CGAffineTransform(translationX: 0, y: containerView.frame.height)
                }
            }) { _ in
                self.actionSheetWindow?.isHidden = true
                self.actionSheetWindow = nil
                self.containerView = nil
                self.backgroundView = nil
                
                // Call completion handler
                completion?(selectedIndex)
            }
        }
    }
    
    // MARK: - Private Methods
    
    /// Create a dedicated window for the action sheet
    private func createActionSheetWindow() {
        // Create a new window
        if #available(iOS 13.0, *) {
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                let window = UIWindow(windowScene: windowScene)
                window.windowLevel = .alert + 1 // Above alerts
                window.backgroundColor = .clear
                self.actionSheetWindow = window
            }
        } else {
            let window = UIWindow(frame: UIScreen.main.bounds)
            window.windowLevel = .alert + 1 // Above alerts
            window.backgroundColor = .clear
            self.actionSheetWindow = window
        }
        
        // Set up the root view controller (required for window)
        let viewController = UIViewController()
        viewController.view.backgroundColor = .clear
        self.actionSheetWindow?.rootViewController = viewController
    }
    
    /// Create the action sheet content
    private func createActionSheetContent(
        itemList: [String],
        itemColor: String,
        completion: @escaping ActionSheetCompletionHandler
    ) {
        guard let window = self.actionSheetWindow, let rootView = window.rootViewController?.view else { return }
        
        // Create background view for dimming and tap to dismiss
        let backgroundView = UIView(frame: rootView.bounds)
        backgroundView.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        backgroundView.alpha = 0
        
        // Add tap gesture to dismiss
        let tapGesture = UITapGestureRecognizer(target: self, action: #selector(backgroundTapped))
        backgroundView.addGestureRecognizer(tapGesture)
        
        rootView.addSubview(backgroundView)
        self.backgroundView = backgroundView
        
        // Create action sheet container
        let containerView = UIView()
        containerView.backgroundColor = UIColor(red: 0.95, green: 0.95, blue: 0.95, alpha: 1.0) // Light gray background
        containerView.translatesAutoresizingMaskIntoConstraints = false
        rootView.addSubview(containerView)
        self.containerView = containerView
        
        // Apply initial transform for animation (start from bottom)
        containerView.transform = CGAffineTransform(translationX: 0, y: rootView.bounds.height)
        
        // Create main stack view for all content
        let mainStackView = UIStackView()
        mainStackView.axis = .vertical
        mainStackView.alignment = .fill
        mainStackView.spacing = 8
        mainStackView.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(mainStackView)
        
        // Create options stack view
        let optionsStackView = UIStackView()
        optionsStackView.axis = .vertical
        optionsStackView.alignment = .fill
        optionsStackView.spacing = 1
        optionsStackView.translatesAutoresizingMaskIntoConstraints = false
        optionsStackView.layer.cornerRadius = 10
        optionsStackView.clipsToBounds = true
        mainStackView.addArrangedSubview(optionsStackView)
        
        // Debug print
        DMPLogger.debug("Creating action sheet with \(itemList.count) items")
        
        // Add item buttons
        for (index, item) in itemList.enumerated() {
            // Create button
            let button = UIButton(type: .system)
            button.setTitle(item, for: .normal)
            button.setTitleColor(UIColor(hexString: itemColor), for: .normal)
            button.titleLabel?.font = UIFont.systemFont(ofSize: 16)
            button.backgroundColor = .white
            button.tag = index // Store index for later
            button.translatesAutoresizingMaskIntoConstraints = false
            button.addTarget(self, action: #selector(itemButtonTapped(_:)), for: .touchUpInside)
            button.heightAnchor.constraint(equalToConstant: 50).isActive = true
            
            // Store completion handler in button for later use
            button.layer.setValue(completion, forKey: "completionHandler")
            
            optionsStackView.addArrangedSubview(button)
        }
        
        // Add cancel button (separate from the items)
        let cancelButton = UIButton(type: .system)
        cancelButton.setTitle("取消", for: .normal)
        cancelButton.setTitleColor(.black, for: .normal)
        cancelButton.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .medium)
        cancelButton.backgroundColor = .white
        cancelButton.layer.cornerRadius = 10
        cancelButton.clipsToBounds = true
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.addTarget(self, action: #selector(cancelButtonTapped(_:)), for: .touchUpInside)
        cancelButton.heightAnchor.constraint(equalToConstant: 55).isActive = true
        
        // Store completion handler in button for later use
        cancelButton.layer.setValue(completion, forKey: "completionHandler")
        
        mainStackView.addArrangedSubview(cancelButton)
        
        // Set up constraints
        NSLayoutConstraint.activate([
            // Main stack view constraints
            mainStackView.topAnchor.constraint(equalTo: containerView.topAnchor, constant: 8),
            mainStackView.leadingAnchor.constraint(equalTo: containerView.leadingAnchor, constant: 8),
            mainStackView.trailingAnchor.constraint(equalTo: containerView.trailingAnchor, constant: -8),
            mainStackView.bottomAnchor.constraint(equalTo: containerView.bottomAnchor, constant: -8),
            
            // Container view constraints (at the bottom of the screen)
            containerView.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            containerView.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            containerView.bottomAnchor.constraint(equalTo: rootView.bottomAnchor)
        ])
        
        // Add corner radius to the top of the container
        containerView.layer.cornerRadius = 10
        containerView.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        containerView.clipsToBounds = true
    }
    
    // MARK: - Button Actions
    
    @objc private func itemButtonTapped(_ sender: UIButton) {
        if let completion = sender.layer.value(forKey: "completionHandler") as? ActionSheetCompletionHandler {
            hideActionSheet(selectedIndex: sender.tag, completion: completion)
        }
    }
    
    @objc private func cancelButtonTapped(_ sender: UIButton) {
        if let completion = sender.layer.value(forKey: "completionHandler") as? ActionSheetCompletionHandler {
            hideActionSheet(selectedIndex: -1, completion: completion) // -1 indicates cancel
        }
    }
    
    @objc private func backgroundTapped() {
        hideActionSheet(selectedIndex: -1, completion: nil) // -1 indicates cancel
    }
}
