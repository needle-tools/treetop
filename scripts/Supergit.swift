import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var daemon: Process?
    let port: UInt16 = 27787
    var ownsDaemon = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        checkExistingDaemon { alreadyRunning in
            if alreadyRunning {
                // Reuse the existing daemon — sessions, PTYs, and all
                // state are preserved.
                DispatchQueue.main.async { self.openWindow() }
            } else {
                self.startDaemon()
                self.waitForPort {
                    DispatchQueue.main.async { self.openWindow() }
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Only kill the daemon if we started it.
        if ownsDaemon, let d = daemon, d.isRunning {
            d.terminate()
            d.waitUntilExit()
        }
    }

    // MARK: - Existing daemon check

    private func checkExistingDaemon(completion: @escaping (Bool) -> Void) {
        let url = URL(string: "http://localhost:\(port)/api/debug/mem")!
        let task = URLSession.shared.dataTask(with: url) { _, response, _ in
            let running = (response as? HTTPURLResponse)?.statusCode == 200
            completion(running)
        }
        task.resume()
    }

    // MARK: - Daemon

    private func startDaemon() {
        let bundle = Bundle.main
        let resourcePath = bundle.resourcePath ?? bundle.bundlePath
        let binary = (resourcePath as NSString).appendingPathComponent("supergit")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)

        // Clean env: strip inherited SUPERGIT_* so the binary uses its
        // own bundled ui/ and picks a clean port.
        var env = ProcessInfo.processInfo.environment
        for key in env.keys where key.hasPrefix("SUPERGIT_") {
            env.removeValue(forKey: key)
        }
        env["SUPERGIT_PORT"] = String(port)
        proc.environment = env

        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            daemon = proc
            ownsDaemon = true
        } catch {
            let alert = NSAlert()
            alert.messageText = "Failed to start supergit"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    // MARK: - Port readiness

    private func waitForPort(attempts: Int = 0, completion: @escaping () -> Void) {
        if attempts > 50 {
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "supergit failed to start"
                alert.informativeText = "Daemon didn't respond on port \(self.port) after 10 seconds."
                alert.runModal()
                NSApp.terminate(nil)
            }
            return
        }

        let url = URL(string: "http://localhost:\(port)/api/debug/mem")!
        let task = URLSession.shared.dataTask(with: url) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                completion()
            } else {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
                    self.waitForPort(attempts: attempts + 1, completion: completion)
                }
            }
        }
        task.resume()
    }

    // MARK: - Window

    private func openWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let w: CGFloat = min(1400, screenRect.width * 0.85)
        let h: CGFloat = min(900, screenRect.height * 0.85)
        let x = screenRect.origin.x + (screenRect.width - w) / 2
        let y = screenRect.origin.y + (screenRect.height - h) / 2

        window = NSWindow(
            contentRect: NSRect(x: x, y: y, width: w, height: h),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "supergit"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 600, height: 400)

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(webView)

        let url = URL(string: "http://localhost:\(port)")!
        webView.load(URLRequest(url: url))

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
