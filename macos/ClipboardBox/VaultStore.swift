import AppKit
import Combine
import CryptoKit
import Foundation

enum VaultItemKind: String, Codable {
    case text
    case image
    case file
}

enum ScreenshotCaptureMode {
    case fullScreen
    case interactive
}

struct VaultItem: Identifiable, Codable, Equatable {
    let id: UUID
    let kind: VaultItemKind
    let title: String
    let createdAt: Date
    let contentType: String
    let byteCount: Int
    let fingerprint: String
    let payloadData: Data
}

@MainActor
final class VaultStore: ObservableObject {
    @Published private(set) var items: [VaultItem] = []
    @Published private(set) var selectedItemID: UUID?
    @Published private(set) var captureStatus: String?
    /// Incognito: stop recording without quitting. Settable from the popover.
    @Published var isPaused = false
    var clearClipboardAfterCapture = false

    private let maxItems = 200
    private var clipboardTimer: Timer?
    private var captureStatusTask: Task<Void, Never>?
    private var lastChangeCount = NSPasteboard.general.changeCount
    private var ignoredFingerprints = Set<String>()
    /// Set when the on-disk vault could not be read *and* could not be archived.
    /// Blocks save() so the unreadable original is never overwritten.
    private var loadFailed = false
    private let syncedScreenshotsDir: URL
    private let vaultURL: URL

    init() {
        // Falling back rather than force-unwrapping: an empty search result here
        // is unlikely but crashes the app at launch, which is a poor trade for
        // one saved line.
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        let dir = support.appendingPathComponent("clipboard-box", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        vaultURL = dir.appendingPathComponent("vault.json")
        syncedScreenshotsDir = dir.appendingPathComponent("synced-screenshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: syncedScreenshotsDir, withIntermediateDirectories: true)

        load()
        startClipboardMonitor()
    }

    deinit {
        clipboardTimer?.invalidate()
        captureStatusTask?.cancel()
    }

    func decryptedData(for item: VaultItem) -> Data? {
        item.payloadData
    }

    func copyToClipboard(_ item: VaultItem) {
        selectForPaste(item)
    }

    func selectForPaste(_ item: VaultItem) {
        selectedItemID = item.id
    }

    func pasteLatestItem() -> Bool {
        preparePasteboardForSelectedItem() != nil
    }

    func preparePasteboardForSelectedItem() -> String? {
        ingestClipboardIfNeeded(force: true)
        guard let item = selectedItem ?? items.first else { return nil }
        guard copyToPasteboard(item) else { return nil }
        return item.fingerprint
    }

    func clearClipboardIfCurrentFingerprint(_ fingerprint: String) {
        clearPasteboardIfCurrentFingerprint(fingerprint)
    }

    func captureScreenshot(mode: ScreenshotCaptureMode) {
        let outputURL = nextCapturedScreenshotURL()
        setCaptureStatus(mode == .interactive ? "Select an area to save into ClipboardBox." : "Capturing screenshot...")

        Task.detached(priority: .userInitiated) { [outputURL] in
            let didCapture = Self.runScreencapture(mode: mode, outputURL: outputURL)

            await MainActor.run { [weak self] in
                guard let self else { return }
                guard didCapture else {
                    try? FileManager.default.removeItem(at: outputURL)
                    self.setCaptureStatus("Screenshot was canceled or blocked by macOS permissions.")
                    return
                }
                self.ingestStoredScreenshot(at: outputURL)
            }
        }
    }

    private var selectedItem: VaultItem? {
        guard let selectedItemID else { return nil }
        return items.first { $0.id == selectedItemID }
    }

    private func copyToPasteboard(_ item: VaultItem) -> Bool {
        guard let data = decryptedData(for: item) else { return false }
        let pb = NSPasteboard.general
        pb.clearContents()

        switch item.kind {
        case .text:
            if let string = String(data: data, encoding: .utf8) {
                pb.setString(string, forType: .string)
            } else {
                return false
            }
        case .image:
            pb.declareTypes([.png], owner: nil)
            pb.setData(data, forType: .png)
        case .file:
            let pasteboardType = NSPasteboard.PasteboardType(item.contentType)
            pb.declareTypes([pasteboardType], owner: nil)
            pb.setData(data, forType: pasteboardType)
        }

        ignoredFingerprints.insert(item.fingerprint)
        lastChangeCount = pb.changeCount
        return true
    }

    private func startClipboardMonitor() {
        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.ingestClipboardIfNeeded()
            }
        }
    }

    // Cross-app markers meaning "this is a transient secret, don't record it".
    // Password managers set them precisely so that clipboard-history tools skip
    // the entry. GNOME has honoured the equivalent hints from the start
    // (SENSITIVE_HINTS in clipboardMonitor.js); macOS did not, so 1Password and
    // Keychain Access content was landing in plaintext vault.json.
    private static let sensitivePasteboardTypes: Set<String> = [
        "org.nspasteboard.TransientType",
        "org.nspasteboard.ConcealedType",
        "org.nspasteboard.AutoGeneratedType",
        "com.agilebits.onepassword",
    ]

    private func pasteboardIsSensitive(_ pb: NSPasteboard) -> Bool {
        guard let types = pb.types else { return false }
        return types.contains { Self.sensitivePasteboardTypes.contains($0.rawValue) }
    }

    private func ingestClipboardIfNeeded(force: Bool = false) {
        let pb = NSPasteboard.general
        guard force || pb.changeCount != lastChangeCount else { return }
        lastChangeCount = pb.changeCount

        // Incognito. Noting the new changeCount above and only then bailing is
        // deliberate: returning any earlier leaves the counter stale, and the
        // first tick after unpausing would ingest whatever was copied while
        // paused — the opposite of what the toggle promises.
        guard !isPaused else { return }

        guard !pasteboardIsSensitive(pb) else { return }

        guard let payload = currentClipboardPayload() else { return }
        if ignoredFingerprints.remove(payload.fingerprint) != nil { return }

        ingest(payload: payload)
        if clearClipboardAfterCapture {
            clearPasteboardIfCurrentFingerprint(payload.fingerprint)
        }
    }

    private func currentClipboardPayload() -> ClipboardPayload? {
        let pb = NSPasteboard.general

        if let text = pb.string(forType: .string), !text.isEmpty {
            return makePayload(
                data: Data(text.utf8),
                kind: .text,
                title: "Text clipping",
                contentType: NSPasteboard.PasteboardType.string.rawValue
            )
        }

        if let png = pb.data(forType: .png), isPNG(png) {
            return makePayload(
                data: png,
                kind: .image,
                title: "Clipboard image",
                contentType: NSPasteboard.PasteboardType.png.rawValue
            )
        }

        if let tiff = pb.data(forType: .tiff),
           let image = NSImage(data: tiff),
           let png = image.pngData {
            return makePayload(
                data: png,
                kind: .image,
                title: "Clipboard image",
                contentType: NSPasteboard.PasteboardType.png.rawValue
            )
        }

        for type in pb.types ?? [] {
            guard let data = pb.data(forType: type), !data.isEmpty else { continue }
            return makePayload(data: data, kind: .file, title: type.rawValue, contentType: type.rawValue)
        }

        return nil
    }

    private func ingest(data: Data, kind: VaultItemKind, title: String, contentType: String) -> VaultItem? {
        ingest(payload: makePayload(data: data, kind: kind, title: title, contentType: contentType))
    }

    @discardableResult
    private func ingest(payload clipboardPayload: ClipboardPayload) -> VaultItem? {
        if let existing = items.first(where: { $0.fingerprint == clipboardPayload.fingerprint }) {
            selectedItemID = existing.id
            return existing
        }

        let item = VaultItem(
            id: UUID(),
            kind: clipboardPayload.kind,
            title: clipboardPayload.title,
            createdAt: Date(),
            contentType: clipboardPayload.contentType,
            byteCount: clipboardPayload.data.count,
            fingerprint: clipboardPayload.fingerprint,
            payloadData: clipboardPayload.data
        )

        items.insert(item, at: 0)
        selectedItemID = item.id
        if items.count > maxItems {
            items.removeLast(items.count - maxItems)
        }
        save()
        return item
    }

    private func ingestStoredScreenshot(at url: URL) {
        guard let data = pngDataForImageFile(url),
              let vaultItem = ingest(
                data: data,
                kind: .image,
                title: url.lastPathComponent,
                contentType: NSPasteboard.PasteboardType.png.rawValue
              )
        else { return }

        _ = copyToPasteboard(vaultItem)
        setCaptureStatus("Screenshot saved in ClipboardBox.")
    }

    private func setCaptureStatus(_ message: String?) {
        captureStatus = message
        captureStatusTask?.cancel()
        guard message != nil else { return }

        captureStatusTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.captureStatus = nil
        }
    }

    private func load() {
        // No vault yet is the ordinary first-run case, not a failure.
        guard let data = try? Data(contentsOf: vaultURL) else { return }

        guard let decoded = try? JSONDecoder.vault.decode([VaultItem].self, from: data) else {
            // Archive under a unique name. The old fixed "vault.encrypted.json"
            // meant a second corruption made moveItem throw, and with the error
            // swallowed the next save() then wrote over the user's real history.
            let stamp = DateFormatter()
            // Fixed-format formatters need a fixed locale, or a non-Gregorian
            // user calendar produces a surprising filename.
            stamp.locale = Locale(identifier: "en_US_POSIX")
            stamp.dateFormat = "yyyyMMdd-HHmmss"
            let archived = vaultURL.deletingLastPathComponent()
                .appendingPathComponent("vault.corrupt-\(stamp.string(from: Date())).json")
            do {
                try FileManager.default.moveItem(at: vaultURL, to: archived)
                setCaptureStatus("History could not be read; saved a copy as \(archived.lastPathComponent).")
            } catch {
                // Could not rescue it, so refuse to persist for the rest of the
                // session. A session that saves nothing beats one that destroys
                // recoverable history.
                loadFailed = true
                NSLog("clipboard-box: vault.json unreadable and could not be archived: \(error)")
                setCaptureStatus("History could not be read. Nothing will be saved this session.")
            }
            return
        }
        items = decoded
    }

    private func save() {
        // See load(): the real history is still sitting at vaultURL.
        guard !loadFailed else { return }
        do {
            let data = try JSONEncoder.vault.encode(items)
            try data.write(to: vaultURL, options: [.atomic, .completeFileProtection])
            // History holds whatever the user copied; keep it owner-only.
            // .completeFileProtection is an iOS Data Protection class and does
            // nothing here, so the POSIX mode is what actually guards the file.
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: vaultURL.path)
        } catch {
            // Previously both the encode and the write error were discarded, so
            // a full disk meant history silently stopped persisting.
            NSLog("clipboard-box: could not save vault.json: \(error)")
            setCaptureStatus("History could not be saved to disk.")
        }
    }

    private func makeFingerprint(kind: VaultItemKind, data: Data) -> String {
        var bytes = Data(kind.rawValue.utf8)
        bytes.append(0)
        bytes.append(data)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private func makePayload(data: Data, kind: VaultItemKind, title: String, contentType: String) -> ClipboardPayload {
        ClipboardPayload(
            data: data,
            kind: kind,
            title: title,
            contentType: contentType,
            fingerprint: makeFingerprint(kind: kind, data: data)
        )
    }

    private func clearPasteboardIfCurrentFingerprint(_ fingerprint: String) {
        guard currentClipboardPayload()?.fingerprint == fingerprint else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        lastChangeCount = pb.changeCount
    }

    private func isPNG(_ data: Data) -> Bool {
        data.count > 8 &&
            data[0] == 0x89 &&
            data[1] == 0x50 &&
            data[2] == 0x4E &&
            data[3] == 0x47
    }

    private func pngDataForImageFile(_ url: URL) -> Data? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        if isPNG(data) { return data }

        guard let image = NSImage(data: data) else { return nil }
        return image.pngData
    }

    private func uniqueSyncedScreenshotURL(for url: URL) -> URL {
        let baseName = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        var candidate = syncedScreenshotsDir.appendingPathComponent(url.lastPathComponent)
        var index = 2

        while FileManager.default.fileExists(atPath: candidate.path) {
            let name = "\(baseName)-\(index)"
            candidate = syncedScreenshotsDir
                .appendingPathComponent(name)
                .appendingPathExtension(ext)
            index += 1
        }

        return candidate
    }

    private func nextCapturedScreenshotURL() -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let name = "Screenshot \(formatter.string(from: Date())).png"
        return uniqueSyncedScreenshotURL(for: URL(fileURLWithPath: name))
    }

    nonisolated private static func runScreencapture(mode: ScreenshotCaptureMode, outputURL: URL) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")

        switch mode {
        case .fullScreen:
            process.arguments = ["-x", "-t", "png", outputURL.path]
        case .interactive:
            process.arguments = ["-i", "-x", "-t", "png", outputURL.path]
        }

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return false
        }

        guard process.terminationStatus == 0,
              let values = try? outputURL.resourceValues(forKeys: [.fileSizeKey]),
              (values.fileSize ?? 0) > 0
        else { return false }

        return true
    }
}

private struct ClipboardPayload {
    let data: Data
    let kind: VaultItemKind
    let title: String
    let contentType: String
    let fingerprint: String
}

private extension JSONEncoder {
    static var vault: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

private extension JSONDecoder {
    static var vault: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

private extension NSImage {
    var pngData: Data? {
        guard let tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffRepresentation)
        else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }
}
