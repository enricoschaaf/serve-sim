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
    let timestamp: CMTime
}

protocol FrameEncoder: Sendable {
    associatedtype Encoded: Sendable
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

    init(
        encoder: E,
        minimumFrameInterval: Duration? = nil,
        maxInFlight: Int = 1,
        onFrame: @escaping @Sendable (E.Encoded) async -> Void
    ) {
        let (stream, continuation) = AsyncStream.makeStream(
            of: Frame.self,
            bufferingPolicy: .bufferingNewest(1)
        )
        self.continuation = continuation
        let pipeline = LatestFrameEncodingPipeline(
            encoder: encoder,
            maxInFlight: maxInFlight,
            onFrame: onFrame,
        )
        Task {
            var lastEncodedAt: ContinuousClock.Instant?
            for await frame in stream {
                let now = ContinuousClock.now
                if let minimumFrameInterval, let lastEncodedAt,
                   now - lastEncodedAt < minimumFrameInterval {
                    continue
                }
                lastEncodedAt = now
                await pipeline.submit(frame)
            }
        }
    }

    nonisolated func handleFrame(_ frame: Frame) {
        continuation.yield(frame)
    }

    deinit { continuation.finish() }
}

private actor LatestFrameEncodingPipeline<E: FrameEncoder> {
    private enum Completion: Sendable {
        case encoded(E.Encoded)
        case failed(String)
    }

    private let encoder: E
    private let maxInFlight: Int
    private let onFrame: @Sendable (E.Encoded) async -> Void
    private var inFlight = 0
    private var pending: Frame?
    private var nextSequence: UInt64 = 0
    private var nextOutput: UInt64 = 0
    private var completions = [UInt64: Completion]()
    private var delivering = false

    init(
        encoder: E,
        maxInFlight: Int,
        onFrame: @escaping @Sendable (E.Encoded) async -> Void
    ) {
        self.encoder = encoder
        self.maxInFlight = max(1, maxInFlight)
        self.onFrame = onFrame
    }

    func submit(_ frame: Frame) {
        guard inFlight < maxInFlight else {
            pending = frame
            return
        }
        start(frame)
    }

    private func start(_ frame: Frame) {
        let sequence = nextSequence
        nextSequence += 1
        inFlight += 1
        Task { [encoder] in
            do {
                await self.finish(sequence, .encoded(try await encoder.encode(frame)))
            } catch {
                await self.finish(sequence, .failed(String(describing: error)))
            }
        }
    }

    private func finish(_ sequence: UInt64, _ completion: Completion) async {
        inFlight -= 1
        completions[sequence] = completion
        if !delivering {
            delivering = true
            await deliverReadyFrames()
            delivering = false
        }
        if let pending, inFlight < maxInFlight {
            self.pending = nil
            start(pending)
        }
    }

    private func deliverReadyFrames() async {
        while let completion = completions.removeValue(forKey: nextOutput) {
            nextOutput += 1
            switch completion {
            case let .encoded(frame):
                await onFrame(frame)
            case let .failed(message):
                print("error encoding frame: \(message)")
            }
        }
    }
}

actor CaptureEngine {
    private struct AVCCSubscription: Sendable {
        let maxDimension: Int
        let fps: Int
        let bitrate: Int
        let onFrame: @Sendable (Dimensions, Data, Int32, Int64) async -> Void
    }

    private struct AVCCProfile: Equatable {
        let maxDimension: Int
        let fps: Int
        let bitrate: Int
    }

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
    private var avccSubscriptions = [UUID: AVCCSubscription]()
    private var avccConsumerId: UUID?
    private var avccEncoder: AVCCEncoder?
    private var avccProfile: AVCCProfile?

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
        try await frameCapture.start(deviceUDID: deviceUDID) { pixelBuffer, timestamp in
            frameContinuation.yield(Frame(pixelBuffer: pixelBuffer, timestamp: timestamp))
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
        id: UUID = UUID(),
        minimumFrameInterval: Duration? = nil,
        maxInFlight: Int = 1,
        onFrame: @escaping @Sendable (E.Encoded) async -> Void
    ) -> (@Sendable () async -> Void) {
        let callback = onFrame
        let consumer = CaptureConsumer(
            encoder: encoder,
            minimumFrameInterval: minimumFrameInterval,
            maxInFlight: maxInFlight
        ) { [weak self] encoded in
            guard let self, await self.phase == .running else { return }
            await callback(encoded)
        }
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
        onFrame: @escaping @Sendable (Dimensions, Data) async -> Void
    ) -> (@Sendable () async -> Void) {
        let callback = onFrame
        return addConsumer(encoder: mjpegEncoder, onFrame: { [weak self] data in
            guard let self else { return }
            await callback(screenSize, data)
        })
    }

    func addAVCCConsumer(
        maxDimension: Int,
        fps: Int,
        bitrate: Int,
        onFrame: @escaping @Sendable (Dimensions, Data, Int32, Int64) async -> Void
    ) -> (@Sendable () async -> Void) {
        let subscriptionId = UUID()
        avccSubscriptions[subscriptionId] = AVCCSubscription(
            maxDimension: max(0, maxDimension),
            fps: max(1, fps),
            bitrate: max(100_000, bitrate),
            onFrame: onFrame,
        )
        reconfigureSharedAVCCEncoder()
        return { [weak self] in
            await self?.removeAVCCSubscription(subscriptionId)
        }
    }

    func requestAVCCKeyframe() async {
        await avccEncoder?.requestKeyframe()
    }

    func stop() {
        if phase == .stopped { return }
        phase = .stopped
        Task { [frameCapture] in await frameCapture.stop() }
        consumers.removeAll()
        avccSubscriptions.removeAll()
        avccEncoder = nil
        avccConsumerId = nil
        avccProfile = nil
    }

    private func removeAVCCSubscription(_ id: UUID) {
        avccSubscriptions.removeValue(forKey: id)
        reconfigureSharedAVCCEncoder()
    }

    private func reconfigureSharedAVCCEncoder() {
        guard !avccSubscriptions.isEmpty else {
            if let avccConsumerId { consumers.removeValue(forKey: avccConsumerId) }
            avccConsumerId = nil
            avccEncoder = nil
            avccProfile = nil
            return
        }

        let subscriptions = Array(avccSubscriptions.values)
        let dimensions = subscriptions.map(\.maxDimension)
        let profile = AVCCProfile(
            maxDimension: dimensions.contains(0) ? 0 : dimensions.max() ?? 0,
            fps: subscriptions.map(\.fps).max() ?? 30,
            bitrate: subscriptions.map(\.bitrate).max() ?? 6_000_000,
        )
        guard profile != avccProfile else { return }
        if let avccConsumerId { consumers.removeValue(forKey: avccConsumerId) }

        let consumerId = UUID()
        let encoder = AVCCEncoder(
            fps: profile.fps,
            bitrate: profile.bitrate,
            maxDimension: profile.maxDimension,
        )
        avccProfile = profile
        avccConsumerId = consumerId
        avccEncoder = encoder
        consumers[consumerId] = CaptureConsumer(
            encoder: encoder,
            minimumFrameInterval: .milliseconds(Int64(max(1, 1_000 / profile.fps))),
            maxInFlight: 3
        ) { [weak self] encoded in
            await self?.publishAVCC(encoded)
        }
    }

    private func publishAVCC(_ encoded: H264Encoder.Encoded) async {
        let flagDescription: Int32 = 1 << 0
        let flagKeyframe: Int32 = 1 << 1
        let timestampUs = encoded.presentationTimeStamp.isValid
            ? Int64(CMTimeGetSeconds(encoded.presentationTimeStamp) * 1_000_000)
            : 0
        let subscribers = avccSubscriptions.values.map(\.onFrame)
        if let description = encoded.description {
            let frame = AVCCEnvelope.description(avcc: description)
            for subscriber in subscribers {
                await subscriber(screenSize, frame, flagDescription, timestampUs)
            }
        }
        let frame: Data
        let flags: Int32
        switch encoded.kind {
        case .keyframe:
            frame = AVCCEnvelope.keyframe(avcc: encoded.avcc)
            flags = flagKeyframe
        case .delta:
            frame = AVCCEnvelope.delta(avcc: encoded.avcc)
            flags = 0
        }
        for subscriber in subscribers {
            await subscriber(screenSize, frame, flags, timestampUs)
        }
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
    let h264Encoder: H264Encoder
    var forceKeyframe = true

    init(fps: Int, bitrate: Int, maxDimension: Int) {
        h264Encoder = H264Encoder(
            fps: fps,
            bitrate: bitrate,
            maxDimension: maxDimension,
        )
    }

    func encode(_ frame: Frame) async throws -> H264Encoder.Encoded {
        let result = try await h264Encoder.encode(
            frame.pixelBuffer,
            presentationTimeStamp: frame.timestamp,
            forceKeyframe: forceKeyframe,
        )
        forceKeyframe = false
        return result
    }

    func requestKeyframe() async {
        forceKeyframe = true
        await h264Encoder.requestKeyframe()
    }

    deinit {
        Task { [h264Encoder] in await h264Encoder.stop() }
    }
}
