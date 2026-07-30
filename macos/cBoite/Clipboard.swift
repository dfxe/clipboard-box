import AppKit

enum Clipboard {
    static func copy(url: URL) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.declareTypes([.png, .fileURL], owner: nil)
        if let data = try? Data(contentsOf: url) {
            pb.setData(data, forType: .png)
        }
        pb.setString(url.absoluteString, forType: .fileURL)
    }
}
