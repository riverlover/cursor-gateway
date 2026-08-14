// Cursor Usage HUD (macOS) — floating overlay, polls official usage API every 60s.
// Mirrors hud/Program.cs (Windows WinForms). System SQLite3 + AppKit, no third-party deps.
import AppKit
import Foundation
import SQLite3

// MARK: - SQLite (state.vscdb)

enum CursorDB {
    static var path: String {
        let home = NSHomeDirectory()
        return (home as NSString).appendingPathComponent(
            "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
        )
    }

    static func readItem(_ dbPath: String, key: String) throws -> String {
        // Prefer live DB + WAL (avoids stale FileManager.copyItem snapshots).
        if let v = try? queryItem(dbPath, key: key, uri: true), !v.isEmpty {
            return v
        }
        if let v = try? queryItem(dbPath, key: key, uri: false), !v.isEmpty {
            return v
        }

        let tmp = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("cuh-\(UUID().uuidString).vscdb")
        defer {
            try? FileManager.default.removeItem(atPath: tmp)
            try? FileManager.default.removeItem(atPath: tmp + "-wal")
            try? FileManager.default.removeItem(atPath: tmp + "-shm")
        }
        try FileManager.default.copyItem(atPath: dbPath, toPath: tmp)
        let wal = dbPath + "-wal"
        let shm = dbPath + "-shm"
        if FileManager.default.fileExists(atPath: wal) {
            try? FileManager.default.copyItem(atPath: wal, toPath: tmp + "-wal")
        }
        if FileManager.default.fileExists(atPath: shm) {
            try? FileManager.default.copyItem(atPath: shm, toPath: tmp + "-shm")
        }
        return try queryItem(tmp, key: key, uri: false)
    }

    private static func queryItem(_ path: String, key: String, uri: Bool) throws -> String {
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | (uri ? SQLITE_OPEN_URI : 0)
        let openPath = uri
            ? "file:\(path)?mode=ro"
            : path
        guard sqlite3_open_v2(openPath, &db, flags, nil) == SQLITE_OK, let db else {
            throw NSError(domain: "sqlite", code: 1, userInfo: [NSLocalizedDescriptionKey: "open db failed"])
        }
        defer { sqlite3_close_v2(db) }
        sqlite3_busy_timeout(db, 1500)

        var stmt: OpaquePointer?
        let sql = "SELECT value FROM ItemTable WHERE key=?"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw NSError(domain: "sqlite", code: 2, userInfo: [NSLocalizedDescriptionKey: "prepare failed"])
        }
        defer { sqlite3_finalize(stmt) }

        let keyData = Array(key.utf8)
        sqlite3_bind_text(stmt, 1, keyData, Int32(keyData.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))

        guard sqlite3_step(stmt) == SQLITE_ROW else { return "" }
        guard let c = sqlite3_column_text(stmt, 0) else { return "" }
        return String(cString: c)
    }
}

// MARK: - Auth (prefer AI助手 seamless_state, else IDE state.vscdb)

enum CursorAuth {
    static let sourceRenewal = "renewal"
    static let sourceIde = "ide"

    static var renewalDir: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".cursor-renewal")
    }

    static var seamlessPath: String {
        (renewalDir as NSString).appendingPathComponent("seamless_state.json")
    }

    struct Session {
        var jwt: String
        var email: String
        var membership: String
        var source: String
    }

    static func load() throws -> Session {
        // 1) AI助手领号态
        let seamless = seamlessPath
        if FileManager.default.fileExists(atPath: seamless),
           let data = try? Data(contentsOf: URL(fileURLWithPath: seamless)),
           let json = String(data: data, encoding: .utf8) {
            let jwt = CursorAPI.extractString(json, "accessToken").trimmingCharacters(in: .whitespacesAndNewlines)
            if !jwt.isEmpty {
                var membership = ""
                if FileManager.default.fileExists(atPath: CursorDB.path) {
                    membership = (try? CursorDB.readItem(CursorDB.path, key: "cursorAuth/stripeMembershipType")) ?? ""
                }
                return Session(
                    jwt: jwt,
                    email: CursorAPI.extractString(json, "email"),
                    membership: membership,
                    source: sourceRenewal
                )
            }
        }

        // 2) Cursor IDE
        guard FileManager.default.fileExists(atPath: CursorDB.path) else {
            throw NSError(
                domain: "auth",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Cursor state.vscdb not found - sign in first"]
            )
        }
        let jwt = try CursorDB.readItem(CursorDB.path, key: "cursorAuth/accessToken")
        if jwt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NSError(
                domain: "auth",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "No accessToken - sign in to Cursor"]
            )
        }
        let email = (try? CursorDB.readItem(CursorDB.path, key: "cursorAuth/cachedEmail")) ?? ""
        let membership = (try? CursorDB.readItem(CursorDB.path, key: "cursorAuth/stripeMembershipType")) ?? ""
        return Session(jwt: jwt, email: email, membership: membership, source: sourceIde)
    }
}

// MARK: - HTTP + JWT helpers

enum CursorAPI {
    static func postJSON(jwt: String, url: String) throws -> String {
        // Use curl for reliable sync HTTP from CLI (avoids URLSession+main-thread deadlocks).
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        proc.arguments = [
            "-sS", "-m", "25",
            "-X", "POST", url,
            "-H", "Content-Type: application/json",
            "-H", "Authorization: Bearer \(jwt)",
            "-d", "{}",
            "-w", "\n%{http_code}",
        ]
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        try proc.run()
        proc.waitUntilExit()
        let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if proc.terminationStatus != 0 {
            throw NSError(
                domain: "api",
                code: Int(proc.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: err.isEmpty ? "curl failed" : err]
            )
        }
        var lines = out.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let codeStr = lines.popLast() ?? "0"
        let body = lines.joined(separator: "\n")
        let status = Int(codeStr) ?? 0
        guard (200..<300).contains(status) else {
            throw NSError(
                domain: "api",
                code: status,
                userInfo: [NSLocalizedDescriptionKey: "HTTP \(status)"]
            )
        }
        return body
    }

    static func postUsage(jwt: String) throws -> String {
        try postJSON(jwt: jwt, url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage")
    }

    static func postGetEmail(jwt: String) throws -> String {
        try postJSON(jwt: jwt, url: "https://api2.cursor.sh/aiserver.v1.AuthService/GetEmail")
    }

    static func postPlanInfo(jwt: String) throws -> String {
        try postJSON(jwt: jwt, url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo")
    }

    /// Server planName (e.g. Free/Pro) — local stripeMembershipType is often stale.
    static func resolvePlan(jwt: String, cachedMembership: String) -> String {
        if let body = try? postPlanInfo(jwt: jwt) {
            let name = extractString(body, "planName")
            if !name.isEmpty { return name.lowercased() }
        }
        return cachedMembership
    }

    static func jwtClaim(_ jwt: String, _ claim: String) -> String {
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2 else { return "" }
        var p = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        switch p.count % 4 {
        case 2: p += "=="
        case 3: p += "="
        default: break
        }
        guard let data = Data(base64Encoded: p),
              let json = String(data: data, encoding: .utf8) else { return "" }
        return extractString(json, claim)
    }

    static func extractString(_ json: String, _ key: String) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: key)
        let pattern = "\"\(escaped)\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\""
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: json, range: NSRange(json.startIndex..., in: json)),
              let r = Range(m.range(at: 1), in: json) else { return "" }
        let raw = String(json[r])
        return raw
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\t", with: "\t")
    }

    static func parseDouble(_ json: String, _ key: String) -> Double {
        let escaped = NSRegularExpression.escapedPattern(for: key)
        let pattern = "\"\(escaped)\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)"
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: json, range: NSRange(json.startIndex..., in: json)),
              let r = Range(m.range(at: 1), in: json) else { return 0 }
        return Double(json[r]) ?? 0
    }

    static func shortSub(_ sub: String) -> String {
        if sub.isEmpty { return "(unknown)" }
        if let i = sub.lastIndex(of: "|") {
            return String(sub[sub.index(after: i)...])
        }
        return sub
    }

    static func truncate(_ s: String, _ n: Int) -> String {
        if s.isEmpty { return "" }
        if s.count <= n { return s }
        return String(s.prefix(n - 1)) + "..."
    }
}

// MARK: - HUD window

final class HudController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let userLabel = NSTextField(labelWithString: "")
    private let planLabel = NSTextField(labelWithString: "")
    private let pctLabel = NSTextField(labelWithString: "")
    private let msgLabel = NSTextField(labelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let bar = NSProgressIndicator()
    private let refreshBtn = NSButton()
    private var pollTimer: Timer?
    private var debounceWork: DispatchWorkItem?
    private var dirSource: DispatchSourceFileSystemObject?
    private var dirFD: Int32 = -1
    private var renewalSource: DispatchSourceFileSystemObject?
    private var renewalFD: Int32 = -1
    private var lastSub = ""
    private var busy = false

    override init() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let size = NSSize(width: 280, height: 92)
        let origin = NSPoint(x: screen.maxX - size.width - 20, y: screen.maxY - size.height - 40)
        panel = NSPanel(
            contentRect: NSRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = NSColor(calibratedRed: 28 / 255, green: 28 / 255, blue: 30 / 255, alpha: 0.94)
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.delegate = self
        panel.title = "Cursor Usage"

        guard let content = panel.contentView else { return }
        content.wantsLayer = true
        content.layer?.cornerRadius = 8
        content.layer?.masksToBounds = true

        configureLabel(userLabel, bold: true, size: 12, color: .white)
        userLabel.frame = NSRect(x: 10, y: 66, width: 175, height: 18)

        configureLabel(planLabel, bold: false, size: 11, color: NSColor(white: 0.63, alpha: 1))
        planLabel.alignment = .right
        planLabel.frame = NSRect(x: 185, y: 66, width: 50, height: 18)

        refreshBtn.title = "R"
        refreshBtn.bezelStyle = .flexiblePush
        refreshBtn.isBordered = false
        refreshBtn.wantsLayer = true
        refreshBtn.layer?.backgroundColor = NSColor(white: 0.18, alpha: 1).cgColor
        refreshBtn.layer?.cornerRadius = 4
        refreshBtn.font = NSFont.boldSystemFont(ofSize: 12)
        refreshBtn.contentTintColor = NSColor(white: 0.95, alpha: 1)
        refreshBtn.frame = NSRect(x: 242, y: 64, width: 28, height: 22)
        refreshBtn.target = self
        refreshBtn.action = #selector(manualRefresh)

        bar.isIndeterminate = false
        bar.minValue = 0
        bar.maxValue = 1000
        bar.doubleValue = 0
        bar.style = .bar
        bar.frame = NSRect(x: 10, y: 48, width: 200, height: 14)

        configureLabel(pctLabel, bold: true, size: 13, color: .white)
        pctLabel.alignment = .right
        pctLabel.frame = NSRect(x: 214, y: 44, width: 56, height: 20)

        configureLabel(msgLabel, bold: false, size: 11, color: NSColor(white: 0.71, alpha: 1))
        msgLabel.frame = NSRect(x: 10, y: 24, width: 260, height: 18)

        configureLabel(statusLabel, bold: false, size: 10, color: NSColor(white: 0.48, alpha: 1))
        statusLabel.frame = NSRect(x: 10, y: 6, width: 260, height: 16)

        content.addSubview(userLabel)
        content.addSubview(planLabel)
        content.addSubview(refreshBtn)
        content.addSubview(bar)
        content.addSubview(pctLabel)
        content.addSubview(msgLabel)
        content.addSubview(statusLabel)

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Refresh now", action: #selector(manualRefresh), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Exit", action: #selector(quit), keyEquivalent: "q"))
        content.menu = menu

        startWatch()
        refreshNow(manual: false)
        pollTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.refreshNow(manual: false)
        }
    }

    func show() {
        panel.orderFrontRegardless()
    }

    private func configureLabel(_ label: NSTextField, bold: Bool, size: CGFloat, color: NSColor) {
        label.isEditable = false
        label.isBordered = false
        label.isBezeled = false
        label.drawsBackground = false
        label.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
        label.textColor = color
        label.lineBreakMode = .byTruncatingTail
    }

    private func startWatch() {
        startWatchDir((CursorDB.path as NSString).deletingLastPathComponent, fd: &dirFD, source: &dirSource)
        startWatchDir(CursorAuth.renewalDir, fd: &renewalFD, source: &renewalSource)
    }

    private func startWatchDir(
        _ dir: String,
        fd: inout Int32,
        source: inout DispatchSourceFileSystemObject?
    ) {
        guard FileManager.default.fileExists(atPath: dir) else { return }
        let opened = open(dir, O_EVTONLY)
        guard opened >= 0 else { return }
        fd = opened
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: opened,
            eventMask: [.write, .rename, .delete, .extend, .attrib],
            queue: .main
        )
        src.setEventHandler { [weak self] in
            self?.scheduleDebouncedRefresh()
        }
        src.setCancelHandler {
            if opened >= 0 { close(opened) }
        }
        source = src
        src.resume()
    }

    private func scheduleDebouncedRefresh() {
        debounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.refreshNow(manual: false)
        }
        debounceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: work)
    }

    @objc private func manualRefresh() {
        pollTimer?.invalidate()
        refreshNow(manual: true)
        pollTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.refreshNow(manual: false)
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func refreshNow(manual: Bool) {
        if busy { return }
        busy = true
        refreshBtn.isEnabled = false

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            defer {
                DispatchQueue.main.async {
                    self.busy = false
                    self.refreshBtn.isEnabled = true
                }
            }
            do {
                let session = try CursorAuth.load()
                let jwt = session.jwt
                var membership = session.membership
                let sub = CursorAPI.jwtClaim(jwt, "sub")

                var email = session.email
                if email.isEmpty {
                    if let body = try? CursorAPI.postGetEmail(jwt: jwt) {
                        email = CursorAPI.extractString(body, "email")
                    }
                }
                if email.isEmpty { email = CursorAPI.jwtClaim(jwt, "email") }
                if email.isEmpty { email = CursorAPI.shortSub(sub) }

                let switched = !sub.isEmpty && !self.lastSub.isEmpty && sub != self.lastSub
                self.lastSub = sub

                membership = CursorAPI.resolvePlan(jwt: jwt, cachedMembership: membership)
                let json = try CursorAPI.postUsage(jwt: jwt)
                let used = CursorAPI.parseDouble(json, "totalPercentUsed")
                let rem = max(0, min(100, 100.0 - used))
                var display = CursorAPI.extractString(json, "displayMessage")
                if display.isEmpty {
                    display = String(format: "Used %.1f%% · Remaining %.1f%%", used, rem)
                }

                let prefix: String
                if manual { prefix = "refreshed · " }
                else if switched { prefix = "switched · " }
                else if session.source == CursorAuth.sourceRenewal { prefix = "renewal · " }
                else { prefix = "left=remaining · " }
                let next = Date().addingTimeInterval(60)
                let fmt = DateFormatter()
                fmt.dateFormat = "HH:mm:ss"
                let status = prefix + "next @" + fmt.string(from: next)

                DispatchQueue.main.async {
                    self.userLabel.stringValue = CursorAPI.truncate(email, 26)
                    self.planLabel.stringValue = membership
                    self.bar.doubleValue = rem * 10
                    self.pctLabel.stringValue = String(format: "%.1f%%", rem)
                    if rem <= 10 {
                        self.pctLabel.textColor = NSColor(calibratedRed: 250 / 255, green: 128 / 255, blue: 114 / 255, alpha: 1)
                    } else if rem <= 30 {
                        self.pctLabel.textColor = NSColor(calibratedRed: 1, green: 215 / 255, blue: 0, alpha: 1)
                    } else {
                        self.pctLabel.textColor = NSColor(calibratedRed: 120 / 255, green: 220 / 255, blue: 140 / 255, alpha: 1)
                    }
                    self.msgLabel.stringValue = CursorAPI.truncate(display, 42)
                    self.statusLabel.stringValue = status
                }
            } catch {
                self.failOnMain(error.localizedDescription)
            }
        }
    }

    private func failOnMain(_ msg: String) {
        DispatchQueue.main.async {
            self.userLabel.stringValue = "Cursor Usage"
            self.planLabel.stringValue = ""
            self.bar.doubleValue = 0
            self.pctLabel.stringValue = "-"
            self.pctLabel.textColor = NSColor(calibratedRed: 250 / 255, green: 128 / 255, blue: 114 / 255, alpha: 1)
            self.msgLabel.stringValue = CursorAPI.truncate(msg, 42)
            let fmt = DateFormatter()
            fmt.dateFormat = "HH:mm:ss"
            self.statusLabel.stringValue = fmt.string(from: Date())
        }
    }
}

// MARK: - CLI --once

func runOnce() {
    do {
        let session = try CursorAuth.load()
        let jwt = session.jwt
        var email = session.email
        if email.isEmpty, let body = try? CursorAPI.postGetEmail(jwt: jwt) {
            email = CursorAPI.extractString(body, "email")
        }
        let cachedMembership = session.membership
        let planJSON = (try? CursorAPI.postPlanInfo(jwt: jwt)) ?? ""
        var membership = CursorAPI.extractString(planJSON, "planName").lowercased()
        if membership.isEmpty { membership = cachedMembership }
        let json = try CursorAPI.postUsage(jwt: jwt)
        let used = CursorAPI.parseDouble(json, "totalPercentUsed")
        print("source=\(session.source)")
        print("email=\(email)")
        print("plan=\(membership)")
        print("db_stripeMembershipType=\(cachedMembership)")
        print("used=\(used)%")
        print("remaining=\(100.0 - used)%")
        print("--- GetPlanInfo ---")
        print(planJSON.isEmpty ? "(empty)" : planJSON)
        print("--- GetCurrentPeriodUsage ---")
        print(json)
    } catch {
        fputs("ERROR: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

// MARK: - Entry

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var hud: HudController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let controller = HudController()
        controller.show()
        hud = controller
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

let args = CommandLine.arguments
if args.count > 1, args[1].lowercased() == "--once" {
    runOnce()
} else {
    let app = NSApplication.shared
    // NSApplication.delegate is weak — keep a strong ref for the process lifetime.
    let delegate = AppDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) {
        app.run()
    }
}
