import AppKit
import ImageIO
import SwiftUI

struct PopoverView: View {
    @EnvironmentObject var store: VaultStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Clipboard Vault")
                    .font(.headline)
                Spacer()
                Text("\(store.items.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)

            if let captureStatus = store.captureStatus {
                Label(captureStatus, systemImage: "camera.viewfinder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.horizontal, 4)
            }

            if store.items.isEmpty {
                EmptyVaultState()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(store.items) { item in
                            VaultItemRow(item: item)
                                .environmentObject(store)
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .frame(maxHeight: .infinity)
            }

            Divider()

            HStack {
                Label("Local plaintext history", systemImage: "tray.full")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Toggle("Pause", isOn: $store.isPaused)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .help("Stop recording the clipboard without quitting")

                Button {
                    store.captureScreenshot(mode: .interactive)
                } label: {
                    Label("Area", systemImage: "camera.viewfinder")
                }
                .help("Capture an area into cBoite (Control-Option-S)")

                Button {
                    store.captureScreenshot(mode: .fullScreen)
                } label: {
                    Label("Screen", systemImage: "display")
                }
                .help("Capture the screen into cBoite")

                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("q")
            }
            .padding(.horizontal, 4)
        }
        .padding(14)
        .frame(width: 620)
        .frame(minHeight: 760, idealHeight: 760, maxHeight: 760)
    }
}

private struct EmptyVaultState: View {
    var body: some View {
        GeometryReader { proxy in
            let textWidth = min(max(proxy.size.width - 80, 220), 420)

            VStack(spacing: 12) {
                Spacer(minLength: 24)

                Image(systemName: "tray")
                    .font(.system(size: 34, weight: .regular))
                    .foregroundStyle(.secondary)

                Text("Copy text, images, files, or take a screenshot.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: textWidth)

                Spacer(minLength: 24)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(minHeight: 420)
    }
}

private struct VaultItemRow: View {
    @EnvironmentObject var store: VaultStore

    let item: VaultItem
    @State private var thumbnail: NSImage?
    @State private var textPreview: String?
    @State private var copied = false

    var body: some View {
        Button {
            store.copyToClipboard(item)
            copied = true
            Task {
                try? await Task.sleep(nanoseconds: 850_000_000)
                copied = false
            }
        } label: {
            HStack(spacing: 10) {
                preview

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Image(systemName: iconName)
                            .foregroundStyle(.secondary)
                            .frame(width: 14)
                        Text(displayTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                    }

                    HStack(spacing: 6) {
                        Text(item.kind.rawValue.capitalized)
                        Text("·")
                        Text(item.byteCount.formatted(.byteCount(style: .file)))
                        Text("·")
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            Text(relativeAge(from: item.createdAt, to: context.date))
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer(minLength: 6)

                if copied {
                    Image(systemName: "target")
                        .foregroundStyle(Color.accentColor)
                        .font(.title3)
                } else {
                    Image(systemName: "cursorarrow.click")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Color.secondary.opacity(0.16), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .help("Use this item for the next Cmd-V")
        .task(id: item.id) {
            guard item.kind == .image,
                  let data = store.decryptedData(for: item)
            else {
                if item.kind == .text,
                   let data = store.decryptedData(for: item),
                   let string = String(data: data, encoding: .utf8) {
                    textPreview = Self.previewText(string)
                }
                return
            }

            let cg = await Task.detached(priority: .utility) {
                Self.makeThumbnailCGImage(data: data, maxPixel: 180)
            }.value
            if let cg {
                thumbnail = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
            }
        }
    }

    @ViewBuilder
    private var preview: some View {
        ZStack {
            if item.kind == .image, let thumbnail {
                Image(nsImage: thumbnail)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle().fill(Color.secondary.opacity(0.12))
                Image(systemName: iconName)
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 96, height: 68)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(Color.secondary.opacity(0.18), lineWidth: 1)
        )
    }

    private var iconName: String {
        switch item.kind {
        case .text: return "text.alignleft"
        case .image: return "photo"
        case .file: return "doc"
        }
    }

    private var displayTitle: String {
        guard item.kind == .text, let textPreview else { return item.title }
        return textPreview
    }

    private static func previewText(_ text: String) -> String {
        let collapsed = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if collapsed.count <= 84 { return collapsed }
        return String(collapsed.prefix(81)) + "..."
    }

    private func relativeAge(from date: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "\(seconds)s" }

        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }

        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }

        let days = hours / 24
        if days < 7 { return "\(days)d" }

        let weeks = days / 7
        if weeks < 5 { return "\(weeks)w" }

        let months = days / 30
        return "\(max(1, months))mo"
    }

    nonisolated private static func makeThumbnailCGImage(data: Data, maxPixel: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
    }
}
