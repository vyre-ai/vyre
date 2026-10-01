// ocr.swift <png>: the text in a screenshot, one line per recognised line (Apple's Vision, on the
// macOS runner). For screens with no DOM to read: the iOS simulator and a whole desktop.
import Foundation
import Vision
import AppKit

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("ocr: cannot read \(path)\n".data(using: .utf8)!)
  exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
try VNImageRequestHandler(cgImage: cg).perform([request])
for o in request.results ?? [] { if let t = o.topCandidates(1).first { print(t.string) } }
