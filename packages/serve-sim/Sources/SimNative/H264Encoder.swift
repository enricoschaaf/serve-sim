import Foundation
import CoreVideo
import CoreMedia
import VideoToolbox

/// Real-time H.264 encoder backed by `VTCompressionSession`, producing AVCC
/// (length-prefixed NAL) output for the `/stream.avcc` endpoint.
///
/// Submission is fire-and-forget: the caller hands a `CVPixelBuffer` in and
/// the encoded chunk comes back via `onEncoded` on VideoToolbox's own queue.
/// FrameCapture owns the incoming private pooled buffer until this async encode
/// completes, so full-resolution frames can be submitted without another copy.
actor H264Encoder {
    let queue = DispatchSerialQueue(label: "h264-encoder", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    struct Encoded {
        /// avcC parameter-set blob — emitted once on the first IDR per session.
        let description: Data?
        let kind: Kind
        let presentationTimeStamp: CMTime
        /// Length-prefixed AVCC NAL bytes (not Annex-B start codes).
        let avcc: Data
        enum Kind { case keyframe, delta }
    }

    private var session: VTCompressionSession?
    private var scalePool: CVPixelBufferPool?
    private var transferSession: VTPixelTransferSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private let fps: Int32
    private let maxDimension: Int
    private var bitrate: Int
    private var emittedDescription = false
    private var needsKeyframe = true
    private var useSoftwareEncoder = false

    private static let encodeTimeout: Duration = .milliseconds(500)

    init(fps: Int = 60, bitrate: Int = 6_000_000, maxDimension: Int = 0) {
        self.fps = Int32(fps)
        self.bitrate = bitrate
        self.maxDimension = maxDimension
    }

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
    }

    /// Submit a frame. Returns immediately; `onEncoded` fires on VT's queue.
    func encode(
        _ source: CVPixelBuffer,
        presentationTimeStamp: CMTime,
        forceKeyframe: Bool = false
    ) async throws -> Encoded {
        guard let inputBuffer = preparedBuffer(source) else {
            throw Errors.couldNotPrepareBuffer
        }
        let w = Int32(CVPixelBufferGetWidth(inputBuffer))
        let h = Int32(CVPixelBufferGetHeight(inputBuffer))
        if session == nil || w != width || h != height {
            width = w
            height = h
            rebuildSession()
        }
        guard let session else {
            throw Errors.couldNotCreateSession
        }
        let frameProps: NSDictionary? = forceKeyframe || needsKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as NSDictionary
            : nil

        let request = EncodeRequest()
        let buffer: CMSampleBuffer? = await withCheckedContinuation { continuation in
            request.install(continuation)
            request.installTimeout(Task {
                try? await Task.sleep(for: Self.encodeTimeout)
                guard !Task.isCancelled else { return }
                request.resume(nil, failure: .timedOut)
            })
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: inputBuffer,
                presentationTimeStamp: presentationTimeStamp,
                duration: .invalid,
                frameProperties: frameProps,
                infoFlagsOut: nil
            ) { @Sendable status, _, sampleBuffer in
                request.resume(
                    status == noErr ? sampleBuffer : nil,
                    failure: status == noErr ? .missingSampleBuffer : .callback(status),
                )
            }
            if status != noErr { request.resume(nil, failure: .submission(status)) }
        }
        guard let buffer else {
            let failure = request.resolvedFailure() ?? .missingSampleBuffer
            if !useSoftwareEncoder {
                recoverFromEncodingFailure(failure)
            }
            throw Errors.encodingFailed(failure)
        }
        let encoded = try extract(from: buffer)
        needsKeyframe = false
        return encoded
    }

    func stop() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        scalePool = nil
        transferSession = nil
    }

    func requestKeyframe() {
        needsKeyframe = true
    }

    // MARK: - private

    private func preparedBuffer(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let sourceWidth = CVPixelBufferGetWidth(source)
        let sourceHeight = CVPixelBufferGetHeight(source)
        let longest = max(sourceWidth, sourceHeight)
        guard maxDimension > 0, longest > maxDimension else { return source }
        let scale = Double(maxDimension) / Double(longest)
        let targetWidth = max(2, Int(Double(sourceWidth) * scale) / 2 * 2)
        let targetHeight = max(2, Int(Double(sourceHeight) * scale) / 2 * 2)
        if scalePool == nil
            || Int(width) != targetWidth
            || Int(height) != targetHeight {
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: targetWidth,
                kCVPixelBufferHeightKey as String: targetHeight,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
            var pool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(
                kCFAllocatorDefault,
                nil,
                attributes as CFDictionary,
                &pool,
            )
            scalePool = pool
            var transfer: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(
                allocator: kCFAllocatorDefault,
                pixelTransferSessionOut: &transfer,
            ) == noErr else {
                return nil
            }
            if let transfer {
                VTSessionSetProperty(
                    transfer,
                    key: kVTPixelTransferPropertyKey_ScalingMode,
                    value: kVTScalingMode_Normal,
                )
            }
            transferSession = transfer
        }
        guard let scalePool, let transferSession else { return nil }
        var output: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(
            kCFAllocatorDefault,
            scalePool,
            &output,
        ) == kCVReturnSuccess, let output else { return nil }
        return VTPixelTransferSessionTransferImage(
            transferSession,
            from: source,
            to: output,
        ) == noErr ? output : nil
    }

    private func rebuildSession() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }

        // Low-latency rate control puts VideoToolbox in its real-time/low-delay
        // pipeline and, crucially, emits a bitstream the *decoder* treats as
        // low-latency (small max_dec_frame_buffering). Without it the decoder
        // fills a large DPB before emitting, adding ~300ms of latency on the
        // client even though the stream carries no B-frames. Falls back to the
        // default spec on the rare hardware that rejects it.
        let hardwareSpec: NSDictionary = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue!,
        ]
        let softwareSpec: NSDictionary = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanFalse!,
        ]
        var sess: VTCompressionSession?
        func create(spec: CFDictionary?) -> OSStatus {
            VTCompressionSessionCreate(
                allocator: kCFAllocatorDefault,
                width: width, height: height,
                codecType: kCMVideoCodecType_H264,
                encoderSpecification: spec,
                imageBufferAttributes: nil,
                compressedDataAllocator: kCFAllocatorDefault,
                outputCallback: nil,
                refcon: nil,
                compressionSessionOut: &sess
            )
        }
        var status = create(spec: useSoftwareEncoder ? softwareSpec : hardwareSpec)
        if (status != noErr || sess == nil) && !useSoftwareEncoder {
            useSoftwareEncoder = true
            sess = nil
            status = create(spec: softwareSpec)
        }
        guard status == noErr, let sess else { return }

        let props: [(CFString, Any)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            // 5s keyframe interval: IDRs are far larger than P-frames, so
            // spacing them out keeps scroll/animation smooth. Late joiners
            // don't wait for the natural IDR — we force one on connect.
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps * 5)),
        ]
        for (key, value) in props {
            VTSessionSetProperty(sess, key: key, value: value as CFTypeRef)
        }
        VTCompressionSessionPrepareToEncodeFrames(sess)
        session = sess
        emittedDescription = false
        needsKeyframe = true
        print("[h264] Encoder ready (\(useSoftwareEncoder ? "software" : "hardware"))")
    }

    private func recoverFromEncodingFailure(_ failure: EncodeFailure) {
        print("[h264] \(failure); rebuilding with software encoder")
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
        scalePool = nil
        transferSession = nil
        useSoftwareEncoder = true
        emittedDescription = false
        needsKeyframe = true
    }

    private func extract(from sample: CMSampleBuffer) throws -> Encoded {
        let isKeyframe = !notSync(sample)
        guard let dataBuf = CMSampleBufferGetDataBuffer(sample) else {
            throw Errors.invalidSampleBuffer
        }

        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            dataBuf, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer
        ) == noErr, let dataPointer else {
            throw Errors.invalidSampleBuffer
        }
        let avcc = Data(bytes: dataPointer, count: totalLength)

        var description: Data?
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            let nextDescription = avcCBlob(from: format)
            if !emittedDescription && nextDescription != nil {
                emittedDescription = true
                description = nextDescription
            }
        }
        return Encoded(
            description: description,
            kind: isKeyframe ? .keyframe : .delta,
            presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sample),
            avcc: avcc,
        )
    }

    private func notSync(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0,
              let dict = CFArrayGetValueAtIndex(attachments, 0) else { return false }
        let cfDict = unsafeBitCast(dict, to: CFDictionary.self)
        return CFDictionaryContainsKey(cfDict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque())
    }

    /// avcC parameter-set blob (ISO/IEC 14496-15 §5.2.4.1) carrying SPS + PPS.
    private func avcCBlob(from format: CMFormatDescription) -> Data? {
        var spsCount = 0
        var spsPtr: UnsafePointer<UInt8>?
        var spsSize = 0
        var nalSize: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0,
            parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize,
            parameterSetCountOut: &spsCount, nalUnitHeaderLengthOut: &nalSize
        ) == noErr, let spsPtr, spsSize >= 4 else { return nil }

        var ppsPtr: UnsafePointer<UInt8>?
        var ppsSize = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPtr else { return nil }

        let sps = UnsafeBufferPointer(start: spsPtr, count: spsSize)
        let pps = UnsafeBufferPointer(start: ppsPtr, count: ppsSize)
        var blob = Data()
        blob.append(0x01)
        blob.append(sps[1]); blob.append(sps[2]); blob.append(sps[3])
        blob.append(0xFF)
        blob.append(0xE1)
        blob.append(UInt8((spsSize >> 8) & 0xFF)); blob.append(UInt8(spsSize & 0xFF))
        blob.append(contentsOf: sps)
        blob.append(0x01)
        blob.append(UInt8((ppsSize >> 8) & 0xFF)); blob.append(UInt8(ppsSize & 0xFF))
        blob.append(contentsOf: pps)
        return blob
    }

    enum Errors: Error {
        case couldNotCreateSession
        case couldNotPrepareBuffer
        case encodingFailed(EncodeFailure)
        case invalidSampleBuffer
    }
}

enum EncodeFailure: Error, Sendable {
    case timedOut
    case submission(OSStatus)
    case callback(OSStatus)
    case missingSampleBuffer
}

private final class EncodeRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CMSampleBuffer?, Never>?
    private var timeout: Task<Void, Never>?
    private var failure: EncodeFailure?

    func install(_ continuation: CheckedContinuation<CMSampleBuffer?, Never>) {
        lock.withLock {
            self.continuation = continuation
        }
    }

    func installTimeout(_ timeout: Task<Void, Never>) {
        let cancel = lock.withLock {
            if continuation == nil { return true }
            self.timeout = timeout
            return false
        }
        if cancel { timeout.cancel() }
    }

    func resume(_ buffer: CMSampleBuffer?, failure: EncodeFailure?) {
        let result = lock.withLock { () -> (CheckedContinuation<CMSampleBuffer?, Never>, Task<Void, Never>?)? in
            guard let continuation else { return nil }
            self.continuation = nil
            self.failure = buffer == nil ? failure : nil
            let timeout = self.timeout
            self.timeout = nil
            return (continuation, timeout)
        }
        guard let (continuation, timeout) = result else { return }
        timeout?.cancel()
        continuation.resume(returning: buffer)
    }

    func resolvedFailure() -> EncodeFailure? {
        lock.withLock { failure }
    }
}
