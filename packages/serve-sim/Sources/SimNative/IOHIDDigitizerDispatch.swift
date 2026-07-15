import Foundation
import Darwin

/// Sends hardware-shaped digitizer events accepted by iOS 26 simulators.
/// Adapted from Baguette's Apache-2.0 IOHID digitizer implementation.
enum IOHIDDigitizerDispatch {
    enum Edge {
        case none, left, top, right, bottom

        var bit: UInt8 {
            switch self {
            case .none: return 0x00
            case .left: return 0x02
            case .top: return 0x08
            case .right: return 0x04
            case .bottom: return 0x01
            }
        }
    }

    enum Phase: Equatable {
        case down, move, up

        var eventMask: UInt32 {
            switch self {
            case .down, .move: return 0x07
            case .up: return 0x06
            }
        }

        var isTouching: Bool { self != .up }
    }

    static func send(
        point: CGPoint,
        identifier: UInt32,
        phase: Phase,
        edge: Edge,
        client: AnyObject
    ) -> Bool {
        guard ensureSymbols(),
              let event = makeDigitizerEvent(point: point, identifier: identifier, phase: phase)
        else { return false }

        let message = withExtendedLifetime(event) {
            trackpadWrapFn?(Unmanaged.passUnretained(event as AnyObject).toOpaque())
        }
        guard let message else { return false }
        patch(message: message, edge: edge)
        return send(message: message, to: client)
    }

    private static func makeDigitizerEvent(
        point: CGPoint,
        identifier: UInt32,
        phase: Phase
    ) -> CFTypeRef? {
        guard let createDigitizerFn,
              let createFingerFn,
              let appendEventFn
        else { return nil }

        let timestamp = mach_absolute_time()
        let touching = phase.isTouching
        guard let parent = createDigitizerFn(
            nil,
            timestamp,
            2,
            0,
            identifier,
            phase.eventMask,
            0,
            point.x,
            point.y,
            0,
            0,
            0,
            touching,
            touching,
            0
        )?.takeRetainedValue() else { return nil }

        guard let finger = createFingerFn(
            nil,
            timestamp,
            0,
            identifier,
            phase.eventMask,
            point.x,
            point.y,
            0,
            0,
            0,
            touching,
            touching,
            0
        )?.takeRetainedValue() else { return parent }

        appendEventFn(parent, finger, 0)
        return parent
    }

    private static func patch(message: UnsafeMutableRawPointer, edge: Edge) {
        message.storeBytes(of: UInt32(0x32), toByteOffset: 0x6c, as: UInt32.self)
        let size = malloc_size(message)
        if size >= 0x110 {
            message.storeBytes(of: UInt32(0x32), toByteOffset: 0x10c, as: UInt32.self)
        }

        let present: UInt8 = edge.bit == 0 ? 0 : 0x04
        message.storeBytes(of: present, toByteOffset: 0x3a, as: UInt8.self)
        message.storeBytes(of: edge.bit, toByteOffset: 0x3b, as: UInt8.self)
        if size >= 0xdc {
            message.storeBytes(of: present, toByteOffset: 0xda, as: UInt8.self)
            message.storeBytes(of: edge.bit, toByteOffset: 0xdb, as: UInt8.self)
        }
    }

    private static func send(message: UnsafeMutableRawPointer, to client: AnyObject) -> Bool {
        let selector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard let cls = object_getClass(client),
              let implementation = class_getMethodImplementation(cls, selector)
        else {
            free(message)
            return false
        }
        typealias Send = @convention(c) (
            AnyObject,
            Selector,
            UnsafeMutableRawPointer,
            ObjCBool,
            AnyObject?,
            AnyObject?
        ) -> Void
        unsafeBitCast(implementation, to: Send.self)(
            client,
            selector,
            message,
            ObjCBool(true),
            nil,
            nil
        )
        return true
    }

    private typealias CreateDigitizer = @convention(c) (
        CFAllocator?, UInt64, UInt32, UInt32, UInt32, UInt32, UInt32,
        Double, Double, Double, Double, Double, Bool, Bool, UInt32
    ) -> Unmanaged<CFTypeRef>?
    private typealias CreateFinger = @convention(c) (
        CFAllocator?, UInt64, UInt32, UInt32, UInt32,
        Double, Double, Double, Double, Double, Bool, Bool, UInt32
    ) -> Unmanaged<CFTypeRef>?
    private typealias AppendEvent = @convention(c) (CFTypeRef, CFTypeRef, UInt32) -> Void
    private typealias TrackpadWrap = @convention(c) (UnsafeRawPointer) -> UnsafeMutableRawPointer?

    nonisolated(unsafe) private static var createDigitizerFn: CreateDigitizer?
    nonisolated(unsafe) private static var createFingerFn: CreateFinger?
    nonisolated(unsafe) private static var appendEventFn: AppendEvent?
    nonisolated(unsafe) private static var trackpadWrapFn: TrackpadWrap?
    nonisolated(unsafe) private static var symbolsResolved = false

    private static func ensureSymbols() -> Bool {
        if symbolsResolved { return true }
        SimFrameworks.load()
        _ = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW | RTLD_GLOBAL)
        let symbols = UnsafeMutableRawPointer(bitPattern: -2)
        guard let createDigitizer = dlsym(symbols, "IOHIDEventCreateDigitizerEvent"),
              let createFinger = dlsym(symbols, "IOHIDEventCreateDigitizerFingerEvent"),
              let appendEvent = dlsym(symbols, "IOHIDEventAppendEvent"),
              let trackpadWrap = dlsym(symbols, "IndigoHIDMessageForTrackpadEventFromHIDEventRef")
        else { return false }

        createDigitizerFn = unsafeBitCast(createDigitizer, to: CreateDigitizer.self)
        createFingerFn = unsafeBitCast(createFinger, to: CreateFinger.self)
        appendEventFn = unsafeBitCast(appendEvent, to: AppendEvent.self)
        trackpadWrapFn = unsafeBitCast(trackpadWrap, to: TrackpadWrap.self)
        symbolsResolved = true
        return true
    }
}
