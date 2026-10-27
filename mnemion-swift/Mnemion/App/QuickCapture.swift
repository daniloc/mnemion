#if os(macOS)
import AppKit
import Carbon.HIToolbox
import MnemionKit
import SwiftUI

/// Capture from anywhere: ⌃⌥N opens a floating panel over whatever app is in
/// front, without bringing Mnemion's window forward. Return saves, Escape or a
/// click elsewhere puts it away (an unsaved draft is kept for next time).
@MainActor
final class QuickCapture {
    static let shared = QuickCapture()
    nonisolated static let shortcut = "⌃⌥N"

    private var panel: CapturePanel?
    private var hotKey: EventHotKeyRef?
    private weak var session: SessionModel?

    /// Registers the global shortcut. A Carbon hot key needs no accessibility
    /// permission, unlike a key-event monitor.
    func install(session: SessionModel) {
        self.session = session
        guard hotKey == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            MainActor.assumeIsolated { QuickCapture.shared.toggle() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x4D4E_4D4E), id: 1) // "MNMN"
        RegisterEventHotKey(UInt32(kVK_ANSI_N), UInt32(controlKey | optionKey), id,
                            GetApplicationEventTarget(), 0, &hotKey)
    }

    func toggle() {
        if let panel, panel.isVisible { hide() } else { show() }
    }

    func show() {
        guard let session else { return }
        let panel = self.panel ?? makePanel(session: session)
        self.panel = panel
        panel.position()
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func makePanel(session: SessionModel) -> CapturePanel {
        let root = QuickCaptureRoot(close: { [weak self] in self?.hide() })
            .environment(session)
        return CapturePanel(content: root)
    }
}

/// The capture view, or a sign-in prompt, on a material card.
private struct QuickCaptureRoot: View {
    let close: () -> Void
    @Environment(SessionModel.self) private var session

    var body: some View {
        Group {
            switch session.phase {
            case .signedOut:
                SignedOutCapture()
            case .signedIn(let store):
                CaptureView(style: .panel, close: close)
                    .environment(store)
                    .id(ObjectIdentifier(store))
            }
        }
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(.white.opacity(0.12), lineWidth: 1)
        }
    }
}

/// The menu bar item and the quick capture panel before anyone has signed in.
struct SignedOutCapture: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray.and.arrow.down")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("Sign in to capture notes")
                .font(.headline)
            Text("Open Mnemion and sign in to your hive.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(28)
        .frame(width: 320)
    }
}

/// A borderless floating panel that takes keyboard focus without activating
/// the app, the way Spotlight does.
final class CapturePanel: NSPanel {
    init(content: some View) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 520, height: 200),
                   styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        isReleasedWhenClosed = false
        contentView = NSHostingView(rootView: content)
    }

    override var canBecomeKey: Bool { true }

    /// Escape, when nothing inside the panel handled it.
    override func cancelOperation(_ sender: Any?) { orderOut(nil) }

    /// Clicking elsewhere puts the panel away, like Spotlight.
    override func resignKey() {
        super.resignKey()
        orderOut(nil)
    }

    /// Keep the top edge fixed as the content grows or shrinks, so the text
    /// field never jumps under the pointer.
    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        var rect = frameRect
        if rect.origin == frame.origin, rect.height != frame.height, frame.height > 0 {
            rect.origin.y = frame.maxY - rect.height
        }
        super.setFrame(rect, display: flag)
    }

    /// Centered on the screen with the pointer, a little above the middle.
    func position() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let x = visible.midX - frame.width / 2
        let top = visible.maxY - visible.height * 0.22
        setFrameTopLeftPoint(NSPoint(x: x, y: top))
    }
}
#endif
