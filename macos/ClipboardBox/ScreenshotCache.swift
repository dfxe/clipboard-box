import Foundation

// On-disk cache inside ClipboardBox's Application Support directory.
@MainActor
final class ScreenshotCache {
    private let dir: URL
    private let limit: Int

    init(limit: Int = 10) {
        self.limit = limit
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        dir = support
            .appendingPathComponent("clipboard-box", isDirectory: true)
            .appendingPathComponent("cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    var directory: URL { dir }

    @discardableResult
    func ingest(from source: URL) -> URL? {
        let target = dir.appendingPathComponent(source.lastPathComponent)
        if FileManager.default.fileExists(atPath: target.path) {
            return target
        }
        do {
            let data = try Data(contentsOf: source)
            // Sanity: PNGs start with 0x89 0x50 0x4E 0x47. Skip partial writes.
            guard data.count > 8,
                  data[0] == 0x89, data[1] == 0x50, data[2] == 0x4E, data[3] == 0x47
            else { return nil }
            try data.write(to: target, options: .atomic)
            return target
        } catch {
            return nil
        }
    }

    func recent() -> [URL] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        let pngs = entries.filter { $0.pathExtension.lowercased() == "png" }
        let sorted = pngs.sorted { lhs, rhs in
            let l = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate) ?? .distantPast
            let r = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate) ?? .distantPast
            return l > r
        }

        // Evict anything beyond the limit so the cache stays small.
        for url in sorted.dropFirst(limit) {
            try? fm.removeItem(at: url)
        }

        return Array(sorted.prefix(limit))
    }
}
