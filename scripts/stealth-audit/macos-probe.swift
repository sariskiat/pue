import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

func countMagentaPixels(_ cgImage: CGImage) -> Int {
    let width = cgImage.width
    let height = cgImage.height
    guard width > 0, height > 0 else { return 0 }
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    var raw = [UInt8](repeating: 0, count: height * bytesPerRow)
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(
              data: &raw,
              width: width,
              height: height,
              bitsPerComponent: 8,
              bytesPerRow: bytesPerRow,
              space: colorSpace,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else {
        return -1
    }
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    var hits = 0
    var i = 0
    let total = raw.count
    while i + 3 < total {
        let r = raw[i]
        let g = raw[i + 1]
        let b = raw[i + 2]
        if r >= 235 && g <= 25 && b >= 235 {
            hits += 1
        }
        i += 4
    }
    return hits
}

func countMagentaInPng(_ path: String) -> Int {
    guard let dataProvider = CGDataProvider(filename: path),
          let img = CGImage(
              pngDataProviderSource: dataProvider,
              decode: nil,
              shouldInterpolate: false,
              intent: .defaultIntent
          ) else {
        return -1
    }
    return countMagentaPixels(img)
}

@main
struct MacOSProbe {
    static func main() async {
        let args = CommandLine.arguments
        guard let pidIdx = args.firstIndex(of: "--pid"), pidIdx + 1 < args.count,
              let targetPid = Int32(args[pidIdx + 1]) else {
            fputs("Usage: macos-probe --pid <pid> [--png <screencapture.png>]\n", stderr)
            exit(2)
        }
        var pngPath: String? = nil
        if let pIdx = args.firstIndex(of: "--png"), pIdx + 1 < args.count {
            pngPath = args[pIdx + 1]
        }

        var report: [String: Any] = ["pid": targetPid]

        // 1. NSRunningApplication activationPolicy (Dock & Cmd+Tab visibility) + frontmost focus theft
        if let runningApp = NSRunningApplication(processIdentifier: targetPid) {
            let policyName: String
            switch runningApp.activationPolicy {
            case .regular: policyName = "regular"          // visible in Cmd+Tab & Dock
            case .accessory: policyName = "accessory"      // hidden from Cmd+Tab & Dock
            case .prohibited: policyName = "prohibited"    // background only
            @unknown default: policyName = "unknown"
            }
            report["activationPolicy"] = policyName
            report["isActiveApp"] = runningApp.isActive
        } else {
            report["activationPolicy"] = "not_found"
        }
        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        report["stoleFrontmostFocus"] = (frontPid == targetPid)

        // 2. CGWindowListCopyWindowInfo inspection
        let cgList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        let myCgWindows = cgList.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == targetPid }
        report["cgWindowCount"] = myCgWindows.count
        report["cgSharingStates"] = myCgWindows.compactMap { $0[kCGWindowSharingState as String] as? Int }
        report["cgWindowLayers"] = myCgWindows.compactMap { $0[kCGWindowLayer as String] as? Int }

        // 3. /usr/sbin/screencapture PNG magenta pixel count (if supplied)
        if let path = pngPath {
            report["screencaptureMagentaPixels"] = countMagentaInPng(path)
        }

        // 4. ScreenCaptureKit (SCShareableContent + SCScreenshotManager)
        do {
            let onScreenShareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let listedWindowsOnScreen = onScreenShareable.windows.filter { $0.owningApplication?.processID == targetPid }
            report["sckShareableOnScreenWindowCount"] = listedWindowsOnScreen.count

            let allShareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let listedAllWindows = allShareable.windows.filter { $0.owningApplication?.processID == targetPid }
            report["sckAllKnownWindowCount"] = listedAllWindows.count

            if let display = onScreenShareable.displays.first {
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let cfg = SCStreamConfiguration()
                cfg.width = display.width
                cfg.height = display.height
                cfg.showsCursor = false
                let displayImg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
                report["sckFullDisplayMagentaPixels"] = countMagentaPixels(displayImg)
            }

            // Direct single-window capture attempt (even if a tool forces desktopIndependentWindow)
            if let targetWin = listedAllWindows.first(where: { $0.frame.width >= 300 && $0.frame.height >= 200 }) {
                do {
                    let winFilter = SCContentFilter(desktopIndependentWindow: targetWin)
                    let wCfg = SCStreamConfiguration()
                    wCfg.width = max(1, Int(targetWin.frame.width))
                    wCfg.height = max(1, Int(targetWin.frame.height))
                    let winImg = try await SCScreenshotManager.captureImage(contentFilter: winFilter, configuration: wCfg)
                    report["sckForcedWindowMagentaPixels"] = countMagentaPixels(winImg)
                } catch {
                    report["sckForcedWindowBlockedError"] = error.localizedDescription
                    report["sckForcedWindowMagentaPixels"] = 0
                }
            } else {
                report["sckForcedWindowMagentaPixels"] = 0
            }
        } catch {
            report["sckError"] = error.localizedDescription
        }

        let jsonData = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(data: jsonData, encoding: .utf8)!)
    }
}
