// Scans image files for faces and human figures with Apple's Vision framework (on-device).
// Usage: swift tools/overnight/facescan.swift <file-with-one-path-per-line>
// Prints one line per image that has a face or a human: "<path>\tfaces=N\thumans=M\tbest=<confidence>".
import Foundation
import Vision

let listPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/dev/stdin"
guard let text = try? String(contentsOfFile: listPath, encoding: .utf8) else { exit(1) }
var scanned = 0, hits = 0
for path in text.split(separator: "\n").map(String.init) where !path.isEmpty {
    let url = URL(fileURLWithPath: path)
    let faces = VNDetectFaceRectanglesRequest()
    let humans = VNDetectHumanRectanglesRequest()
    humans.upperBodyOnly = false
    let handler = VNImageRequestHandler(url: url, options: [:])
    do { try handler.perform([faces, humans]) } catch { continue }
    scanned += 1
    let f = (faces.results ?? []).filter { $0.confidence >= 0.5 }
    let h = (humans.results ?? []).filter { $0.confidence >= 0.5 }
    if !f.isEmpty || !h.isEmpty {
        hits += 1
        let best = (f.map { $0.confidence } + h.map { $0.confidence }).max() ?? 0
        print("\(path)\tfaces=\(f.count)\thumans=\(h.count)\tbest=\(String(format: "%.2f", best))")
    }
}
FileHandle.standardError.write("scanned \(scanned), hits \(hits)\n".data(using: .utf8)!)
