// Draws the iPhone SE (3rd generation) and iPhone 17e frames in src/assets from plain shapes, with no
// Apple artwork, styled after the iPhone 16 Pro frame: dark outline, bright metal band, black glass.
// The geometry must match iosModelConfig in src/components/remote-control.tsx.
// Usage: swift scripts/draw-iphone-frames.swift <out dir>, then convert each PNG to webp:
//   cwebp -q 90 -alpha_q 100 <out dir>/iphonese_own_portrait.png -o src/assets/iphonese_black_bg.webp
// and likewise for iphonese_own_landscape (iphonese_black_landscape_bg) and the two iphone17e images.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let outDir = CommandLine.arguments[1]
let scale: CGFloat = 3

struct Button { let left: Bool; let y: CGFloat; let height: CGFloat }
struct Model {
    let name: String
    let frame: CGSize          // whole image, points
    let sidePad: CGFloat       // room for the side buttons on each side
    let bodyRadius: CGFloat
    let screen: CGRect         // screen opening, points
    let screenRadius: CGFloat
    let buttons: [Button]
    let homeButton: Bool
}

let models = [
    Model(name: "iphonese", frame: CGSize(width: 429, height: 889), sidePad: 9, bodyRadius: 61,
          screen: CGRect(x: 27, y: 111, width: 375, height: 667), screenRadius: 0,
          buttons: [Button(left: true, y: 114, height: 36), Button(left: true, y: 188, height: 68),
                    Button(left: true, y: 269, height: 68), Button(left: false, y: 188, height: 68)],
          homeButton: true),
    Model(name: "iphone17e", frame: CGSize(width: 452, height: 888), sidePad: 9, bodyRadius: 68,
          screen: CGRect(x: 31, y: 22, width: 390, height: 844), screenRadius: 47.33,
          buttons: [Button(left: true, y: 160, height: 32), Button(left: true, y: 221, height: 72),
                    Button(left: true, y: 300, height: 72), Button(left: false, y: 262, height: 117)],
          homeButton: false),
]

func gray(_ v: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(red: v / 255, green: v / 255, blue: v / 255, alpha: a) }

func roundedRect(_ r: CGRect, _ radius: CGFloat) -> CGPath {
    let rad = max(0, min(radius, min(r.width, r.height) / 2))
    return CGPath(roundedRect: r, cornerWidth: rad, cornerHeight: rad, transform: nil)
}

func write(_ img: CGImage, _ path: String) {
    let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, img, nil)
    CGImageDestinationFinalize(d)
}

for m in models {
    let W = m.frame.width, H = m.frame.height
    let pxW = Int(W * scale), pxH = Int(H * scale)
    let ctx = CGContext(data: nil, width: pxW, height: pxH, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: 0, y: H)
    ctx.scaleBy(x: 1, y: -1)   // top-left coordinates from here on

    let body = CGRect(x: m.sidePad, y: 0, width: W - 2 * m.sidePad, height: H)

    // Side buttons sit behind the body and stick out 8 points.
    for b in m.buttons {
        let x = b.left ? body.minX - 8 : body.maxX - 8
        let r = CGRect(x: x, y: b.y, width: 16, height: b.height)
        ctx.addPath(roundedRect(r, 3)); ctx.setFillColor(gray(62)); ctx.fillPath()
        ctx.addPath(roundedRect(r.insetBy(dx: 0.6, dy: 0.6), 2.5)); ctx.setFillColor(gray(34)); ctx.fillPath()
    }

    // The body edge, outside in: dark outline, bright metal band, dark band, faint highlight, black glass.
    let rings: [(inset: CGFloat, value: CGFloat)] = [
        (0, 27), (0.7, 48), (1.3, 82), (1.9, 104), (2.7, 70), (3.4, 30), (4.3, 44), (5.2, 20), (6.4, 9), (7.6, 4),
    ]
    for ring in rings {
        ctx.addPath(roundedRect(body.insetBy(dx: ring.inset, dy: ring.inset), m.bodyRadius - ring.inset))
        ctx.setFillColor(gray(ring.value)); ctx.fillPath()
    }

    // The screen opening is pure black, like the existing frames, and the video covers it exactly.
    ctx.addPath(roundedRect(m.screen, m.screenRadius)); ctx.setFillColor(gray(0)); ctx.fillPath()

    if m.homeButton {
        let cx = body.midX
        // Home button centered in the bottom bezel, with a thin metal ring.
        let bottomBezel = CGRect(x: body.minX, y: m.screen.maxY, width: body.width, height: H - m.screen.maxY)
        let d: CGFloat = 64
        let home = CGRect(x: cx - d / 2, y: bottomBezel.midY - d / 2, width: d, height: d)
        ctx.addEllipse(in: home); ctx.setFillColor(gray(70)); ctx.fillPath()
        ctx.addEllipse(in: home.insetBy(dx: 1.6, dy: 1.6)); ctx.setFillColor(gray(10)); ctx.fillPath()
        // Earpiece and front camera in the top bezel.
        let topMid = m.screen.minY / 2
        let ear = CGRect(x: cx - 24, y: topMid - 3, width: 48, height: 6)
        ctx.addPath(roundedRect(ear, 3)); ctx.setFillColor(gray(38)); ctx.fillPath()
        ctx.addPath(roundedRect(ear.insetBy(dx: 0.8, dy: 0.8), 2.2)); ctx.setFillColor(gray(18)); ctx.fillPath()
        let cam = CGRect(x: cx - 46 - 5, y: topMid - 5, width: 10, height: 10)
        ctx.addEllipse(in: cam); ctx.setFillColor(gray(30)); ctx.fillPath()
        ctx.addEllipse(in: cam.insetBy(dx: 2.2, dy: 2.2)); ctx.setFillColor(CGColor(red: 0.08, green: 0.09, blue: 0.16, alpha: 1)); ctx.fillPath()
    }

    let portrait = ctx.makeImage()!
    write(portrait, "\(outDir)/\(m.name)_own_portrait.png")

    // Landscape is the portrait turned 90 degrees counterclockwise, like the existing iPhone 16 Pro art.
    let lctx = CGContext(data: nil, width: pxH, height: pxW, bitsPerComponent: 8, bytesPerRow: 0,
                         space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    lctx.translateBy(x: CGFloat(pxH), y: 0)
    lctx.rotate(by: .pi / 2)
    lctx.draw(portrait, in: CGRect(x: 0, y: 0, width: pxW, height: pxH))
    write(lctx.makeImage()!, "\(outDir)/\(m.name)_own_landscape.png")
    print("\(m.name): \(pxW)x\(pxH) px")
}
