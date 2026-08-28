#!/usr/bin/env swift

// Transcribe text from flyer images using the macOS Vision framework.
// Free, offline, no API key. macOS only.
//
//   swift scripts/ocr_flyers.swift                       # every image in data/flyers/
//   swift scripts/ocr_flyers.swift data/flyers/foo.png   # specific files
//   swift scripts/ocr_flyers.swift ~/Downloads/*.jpg

import Foundation
import Vision
import AppKit

let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"]

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let args = Array(CommandLine.arguments.dropFirst())
var paths: [String]
if args.isEmpty {
    let dir = "data/flyers"
    paths = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
        .filter { imageExts.contains(($0 as NSString).pathExtension.lowercased()) }
        .sorted()
        .map { dir + "/" + $0 }
    if paths.isEmpty { err("No images in \(dir)/ - pass file paths instead."); exit(1) }
} else {
    paths = args
}

func transcribe(_ path: String) -> String? {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { return nil }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do { try handler.perform([request]) } catch { return nil }

    let observations = (request.results ?? [])
        .sorted { $0.boundingBox.midY > $1.boundingBox.midY }  // top-to-bottom
    return observations
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

for path in paths {
    print("===== \(path) =====")
    if let text = transcribe(path) {
        print(text.isEmpty ? "(no text detected)" : text)
    } else {
        err("could not read image: \(path)")
    }
    print()
}
