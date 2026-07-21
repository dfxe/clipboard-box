import AppKit
import Foundation

final class ClipboardOverrideController {
    private weak var store: VaultStore?
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var bypassNextPaste = false

    init(store: VaultStore) {
        self.store = store
        start()
    }

    deinit {
        stop()
    }

    private func start() {
        let options: NSDictionary = [kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true]
        let isTrusted = AXIsProcessTrustedWithOptions(options)

        let mask = 1 << CGEventType.keyDown.rawValue
        guard isTrusted else {
            setClearClipboardAfterCapture(false)
            return
        }

        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let controller = Unmanaged<ClipboardOverrideController>
                    .fromOpaque(refcon)
                    .takeUnretainedValue()
                return controller.handle(type: type, event: event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )

        guard let eventTap else {
            setClearClipboardAfterCapture(false)
            return
        }
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        if let runLoopSource {
            CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        CGEvent.tapEnable(tap: eventTap, enable: true)
        setClearClipboardAfterCapture(true)
    }

    private func stop() {
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        eventTap = nil
        runLoopSource = nil
        setClearClipboardAfterCapture(false)
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        guard type == .keyDown else {
            return Unmanaged.passUnretained(event)
        }

        if let screenshotMode = screenshotCaptureMode(for: event) {
            captureScreenshot(mode: screenshotMode)
            return nil
        }

        guard isCommandV(event) else {
            return Unmanaged.passUnretained(event)
        }

        if bypassNextPaste {
            bypassNextPaste = false
            return Unmanaged.passUnretained(event)
        }

        guard let pastedFingerprint = preparePasteboardForPaste() else {
            return Unmanaged.passUnretained(event)
        }

        postCommandV()

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            self?.store?.clearClipboardIfCurrentFingerprint(pastedFingerprint)
        }

        return nil
    }

    private func captureScreenshot(mode: ScreenshotCaptureMode) {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                store?.captureScreenshot(mode: mode)
            }
            return
        }

        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.store?.captureScreenshot(mode: mode)
            }
        }
    }

    private func preparePasteboardForPaste() -> String? {
        if Thread.isMainThread {
            return MainActor.assumeIsolated {
                store?.preparePasteboardForSelectedItem()
            }
        }

        return DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                store?.preparePasteboardForSelectedItem()
            }
        }
    }

    private func isCommandV(_ event: CGEvent) -> Bool {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        return keyCode == 9 &&
            flags.contains(.maskCommand) &&
            !flags.contains(.maskControl) &&
            !flags.contains(.maskAlternate) &&
            !flags.contains(.maskShift)
    }

    private func screenshotCaptureMode(for event: CGEvent) -> ScreenshotCaptureMode? {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags

        if keyCode == 1 &&
            flags.contains(.maskControl) &&
            flags.contains(.maskAlternate) &&
            !flags.contains(.maskCommand) &&
            !flags.contains(.maskShift) {
            return .interactive
        }

        guard flags.contains(.maskCommand),
              flags.contains(.maskShift),
              !flags.contains(.maskAlternate)
        else { return nil }

        switch keyCode {
        case 20:
            return .fullScreen
        case 21, 23:
            return .interactive
        default:
            return nil
        }
    }

    private func postCommandV() {
        bypassNextPaste = true

        let source = CGEventSource(stateID: .hidSystemState)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
        keyDown?.flags = .maskCommand
        keyUp?.flags = .maskCommand
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
    }

    private func setClearClipboardAfterCapture(_ value: Bool) {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                store?.clearClipboardAfterCapture = value
            }
            return
        }

        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.store?.clearClipboardAfterCapture = value
            }
        }
    }
}
