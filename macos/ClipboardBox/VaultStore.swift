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
    var clearClipboardAfterCapture = false

    private let maxItems = 200
    private var clipboardTimer: Timer?
    private var captureStatusTask: Task<Void, Never>?
    private var lastChangeCount = NSPasteboard.general.changeCount
    private var ignoredFingerprints = Set<String>()
    private let syncedScreenshotsDir: URL
    private let vaultURL: URL

    init() {
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
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

    private func ingestClipboardIfNeeded(force: Bool = false) {
        let pb = NSPasteboard.general
        guard force || pb.changeCount != lastChangeCount else { return }
        lastChangeCount = pb.changeCount

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
        guard let data = try? Data(contentsOf: vaultURL),
              let decoded = try? JSONDecoder.vault.decode([VaultItem].self, from: data)
        else {
            if (try? Data(contentsOf: vaultURL)) != nil {
                let archivedURL = vaultURL.deletingLastPathComponent()
                    .appendingPathComponent("vault.encrypted.json")
                try? FileManager.default.moveItem(at: vaultURL, to: archivedURL)
            }
            return
        }
        items = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder.vault.encode(items) else { return }
        try? data.write(to: vaultURL, options: [.atomic, .completeFileProtection])
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
