import SwiftUI

@main
struct CBoiteApp: App {
    @StateObject private var store: VaultStore
    private let clipboardOverride: ClipboardOverrideController

    init() {
        let store = VaultStore()
        _store = StateObject(wrappedValue: store)
        clipboardOverride = ClipboardOverrideController(store: store)
    }

    var body: some Scene {
        MenuBarExtra("cboite", systemImage: "lock.rectangle.stack") {
            PopoverView()
                .environmentObject(store)
        }
        .menuBarExtraStyle(.window)
    }
}
