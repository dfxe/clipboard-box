import SwiftUI

@main
struct OmeletteApp: App {
    @StateObject private var store: VaultStore
    private let clipboardOverride: ClipboardOverrideController

    init() {
        let store = VaultStore()
        _store = StateObject(wrappedValue: store)
        clipboardOverride = ClipboardOverrideController(store: store)
    }

    var body: some Scene {
        MenuBarExtra("omelette", systemImage: "lock.rectangle.stack") {
            PopoverView()
                .environmentObject(store)
        }
        .menuBarExtraStyle(.window)
    }
}
