import Foundation

// Where cBoite keeps its files, and the only place the clipboard-box → cBoite
// rename is still visible at runtime.
//
// The rename moved the Application Support directory. The first access renames
// the old one into place rather than asking anyone to move it by hand — a move
// rather than a copy, so vault.json and synced-screenshots/ arrive together or
// not at all. A half-copied vault is the one outcome worth ruling out.
//
// `static let` is resolved once and lazily, which is exactly the guarantee the
// migration needs: it cannot run twice, and it does not run at all until
// something actually asks for the directory.
//
// This whole file can go once nobody is running a build from before the rename.
enum DataDirectory {
    private static let name = "cboite"
    private static let legacyName = "clipboard-box"

    static let url: URL = {
        let fm = FileManager.default

        // Falling back rather than force-unwrapping: an empty search result is
        // unlikely but crashes the app at launch, a poor trade for one line.
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)

        let dir = support.appendingPathComponent(name, isDirectory: true)
        let legacy = support.appendingPathComponent(legacyName, isDirectory: true)

        var legacyIsDir: ObjCBool = false
        let legacyExists = fm.fileExists(atPath: legacy.path, isDirectory: &legacyIsDir)

        if !fm.fileExists(atPath: dir.path), legacyExists, legacyIsDir.boolValue {
            do {
                try fm.moveItem(at: legacy, to: dir)
                NSLog("cboite: migrated \(legacy.path) to \(dir.path)")
            } catch {
                // Deliberately not fatal. The caller goes on to create the new
                // directory and start empty, which loses nothing — the old
                // history is still sitting under its old name, and the log says
                // where.
                NSLog("cboite: could not migrate \(legacy.path), leaving it alone: \(error)")
            }
        }

        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
}
