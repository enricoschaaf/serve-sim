import Foundation
import CoreVideo
import CoreMedia
import os

// The capture + encode engine, reused verbatim from SimStreamHelper. Replicates
// main.swift's frameHandler: MJPEG always encodes while clients exist; H.264 runs
// only while AVCC is active. Encoded bytes (JPEG, or natively-framed AVCC
// envelopes) are handed back through a Swift closure on a native encode thread;
// the node-swift binding (sim-module.swift) marshals them onto the JS thread via
// a NodeAsyncQueue (threadsafe function).

struct Frame: Identifiable {
    let id = UUID()
    let pixelBuffer: CVPixelBuffer
}

protocol FrameEncoder {
    associatedtype Encoded
    func encode(_ frame: Frame) async throws -> Encoded
}

protocol CaptureConsuming: Sendable {
    // this is intentionally synchronous. CaptureEngine sends all frames to all consumers,
    // and lets them handle internal backpressure as they see fit. if instead this were async
    // (and CaptureEngine waited for all consumers to finish), a single bad consumer could
    // jam up the entire pipeline.
    func handleFrame(_ frame: Frame)
}

actor CaptureConsumer<E: FrameEncoder>: CaptureConsuming {
    nonisolated let continuation: AsyncStream<Frame>.Continuation
    private let minimumFrameInterval: Duration?

    init(
        encoder: E,
        minimumFrameInterval: Duration? = nil,
        onFrame: @escaping @isolated(any) (E.Encoded) async -> Void
    ) {
        self.minimumFrameInterval = minimumFrameInterval
        let (stream, continuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        self.continuation = continuation
        Task {
            _ = onFrame.isolation
            var lastEncodedAt: ContinuousClock.Instant?
            for await frame in stream {
                let now = ContinuousClock.now
                if let minimumFrameInterval, let lastEncodedAt,
                   now - lastEncodedAt < minimumFrameInterval {
                    continue
                }
                lastEncodedAt = now
                do {
                    let encoded = try await encoder.encode(frame)
                    await onFrame(encoded)
                } catch {
                    print("error encoding frame: \(error)")
                    continue
                }
            }
        }
    }

    nonisolated func handleFrame(_ frame: Frame) {
        continuation.yield(frame)
    }

    deinit { continuation.finish() }
}

actor CaptureEngine {
    private enum Phase {
        case unstarted
        case starting
        case running
        case stopped
    }

    private let deviceUDID: String
    private let frameCapture = FrameCapture()
    private var phase = Phase.unstarted

    // mjpeg is stateless so we can share a single encoder instance
    private let mjpegEncoder = MJPEGEncoder()

    private(set) var screenSize = Dimensions(width: 0, height: 0)
    private var consumers = [UUID: CaptureConsuming]()

    init(deviceUDID: String) {
        self.deviceUDID = deviceUDID
    }

    func start() async throws {
        guard phase == .unstarted else { return }
        phase = .starting
        // Latch `started` only after capture actually begins: if start() throws
        // (e.g. device not booted), a later retry should still be allowed.
        let (frames, frameContinuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        try await frameCapture.start(deviceUDID: deviceUDID) { pixelBuffer, _ in
            frameContinuation.yield(Frame(pixelBuffer: pixelBuffer))
        }
        Task {
            for await frame in frames {
                handleFrame(frame)
            }
        }
        phase = .running
    }

    private func addConsumer<E: FrameEncoder>(
        encoder: E,
        minimumFrameInterval: Duration? = nil,
        onFrame: sending @escaping @isolated(any) (E.Encoded) async -> Void
    ) -> (@Sendable () async -> Void) {
        let consumer = CaptureConsumer(
            encoder: encoder,
            minimumFrameInterval: minimumFrameInterval
        ) { [weak self] encoded in
            guard let self, await self.phase == .running else { return }
            await onFrame(encoded)
        }
        let id = UUID()
        consumers[id] = consumer
        return { await self.removeConsumer(id) }
    }

    private func removeConsumer(
        _ id: UUID
    ) {
        consumers.removeValue(forKey: id)
    }

    private func handleFrame(_ frame: Frame) {
        guard phase == .running else { return }
        screenSize = frame.pixelBuffer.dimensions
        for consumer in consumers.values {
            consumer.handleFrame(frame)
        }
    }

    func addMJPEGConsumer(
        onFrame: sending @escaping (Dimensions, Data) async -> Void
    ) -> (@Sendable () async -> Void) {
        return addConsumer(encoder: mjpegEncoder, onFrame: { [weak self] data in
            guard let self else { return }
            await onFrame(screenSize, data)
        })
    }

    func addAVCCConsumer(
        onFrame: sending @escaping (Dimensions, Data, Int32) async -> Void
    ) -> (@Sendable () async -> Void) {
        addConsumer(
            encoder: AVCCEncoder(),
            minimumFrameInterval: .milliseconds(33)
        ) { [weak self] encoded in
            let flagDescription: Int32 = 1 << 0
            let flagKeyframe: Int32 = 1 << 1

            guard let self else { return }
            if let description = encoded.description {
                await onFrame(
                    screenSize,
                    AVCCEnvelope.description(avcc: description),
                    flagDescription,
                )
            }
            switch encoded.kind {
            case .keyframe:
                await onFrame(
                    screenSize,
                    AVCCEnvelope.keyframe(avcc: encoded.avcc),
                    flagKeyframe,
                )
            case .delta:
                await onFrame(
                    screenSize,
                    AVCCEnvelope.delta(avcc: encoded.avcc),
                    0,
                )
            }
        }
    }

    func stop() {
        if phase == .stopped { return }
        phase = .stopped
        Task { [frameCapture] in await frameCapture.stop() }
        consumers.removeAll()
    }
}

actor MJPEGEncoder: FrameEncoder {
    private let videoEncoder = VideoEncoder(quality: 0.7)
    private var lastImage: (UUID, Data)?

    init() {}

    func encode(_ frame: Frame) async throws -> Data {
        if let (id, data) = lastImage, id == frame.id { return data }
        let data = try await videoEncoder.encode(pixelBuffer: frame.pixelBuffer)
        lastImage = (frame.id, data)
        return data
    }
}

actor AVCCEncoder: FrameEncoder {
    let h264Encoder = H264Encoder(fps: 30, bitrate: 8_000_000)
    var forceKeyframe = true

    init() {}

    func encode(_ frame: Frame) async throws -> H264Encoder.Encoded {
        let result = try await h264Encoder.encode(
            frame.pixelBuffer,
            forceKeyframe: forceKeyframe,
        )
        forceKeyframe = false
        return result
    }

    deinit {
        Task { [h264Encoder] in await h264Encoder.stop() }
    }
}
