import Network
import XCTest

final class RunnerTests: XCTestCase {
  private let queue = DispatchQueue(label: "serve-sim.xctest.runner")
  private var listener: NWListener?
  private var lifetime: XCTestExpectation?
  private var applications: [String: XCUIApplication] = [:]

  override func setUp() {
    continueAfterFailure = true
  }

  @MainActor
  func testCommand() throws {
    let port = UInt16(ProcessInfo.processInfo.environment["SERVE_SIM_XCTEST_PORT"] ?? "") ?? 0
    guard port > 0, let endpointPort = NWEndpoint.Port(rawValue: port) else {
      XCTFail("SERVE_SIM_XCTEST_PORT is missing")
      return
    }

    lifetime = expectation(description: "serve-sim runner lifetime")
    listener = try NWListener(using: .tcp, on: endpointPort)
    listener?.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      connection.start(queue: self.queue)
      self.receive(connection, data: Data())
    }
    listener?.start(queue: queue)

    guard let lifetime else { return }
    let result = XCTWaiter.wait(for: [lifetime], timeout: 24 * 60 * 60)
    if result != .completed {
      XCTFail("serve-sim runner ended with \(result)")
    }
  }

  private func receive(_ connection: NWConnection, data: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 2 * 1024 * 1024) {
      [weak self] chunk, _, _, error in
      guard let self, error == nil, let chunk else {
        connection.cancel()
        return
      }
      let combined = data + chunk
      guard let body = self.requestBody(combined) else {
        self.receive(connection, data: combined)
        return
      }
      DispatchQueue.main.async { [weak self] in
        guard let self else {
          connection.cancel()
          return
        }
        let response = self.response(for: body)
        connection.send(content: response, isComplete: true, completion: .contentProcessed { _ in
          connection.cancel()
        })
      }
    }
  }

  private func requestBody(_ data: Data) -> Data? {
    guard let boundary = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let header = String(decoding: data[..<boundary.lowerBound], as: UTF8.self)
    guard let contentLengthLine = header
      .components(separatedBy: "\r\n")
      .first(where: { $0.lowercased().hasPrefix("content-length:") }),
      let separator = contentLengthLine.firstIndex(of: ":"),
      let contentLength = Int(contentLengthLine[contentLengthLine.index(after: separator)...]
        .trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    let start = boundary.upperBound
    guard data.count >= start + contentLength else { return nil }
    return data.subdata(in: start..<(start + contentLength))
  }

  private func response(for body: Data) -> Data {
    do {
      let request = try JSONDecoder().decode(Request.self, from: body)
      let payload: Any
      switch request.command {
      case "status":
        payload = ["ok": true, "backend": "xctest"]
      case "snapshot":
        guard let bundleId = request.bundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !bundleId.isEmpty else {
          throw RunnerError.invalidBundleId
        }
        let app = applications[bundleId] ?? XCUIApplication(bundleIdentifier: bundleId)
        applications[bundleId] = app
        let snapshot = try app.snapshot()
        payload = ["ok": true, "tree": serialize(snapshot)]
      case "typeText":
        guard let bundleId = request.bundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !bundleId.isEmpty else {
          throw RunnerError.invalidBundleId
        }
        guard let text = request.text, !text.isEmpty else {
          throw RunnerError.invalidText
        }
        let app = applications[bundleId] ?? XCUIApplication(bundleIdentifier: bundleId)
        applications[bundleId] = app
        if let target = textInput(in: app, normalizedX: request.x, normalizedY: request.y) {
          target.typeText(text)
        } else {
          app.typeText(text)
        }
        payload = ["ok": true]
      case "shutdown":
        payload = ["ok": true]
        lifetime?.fulfill()
      default:
        throw RunnerError.invalidCommand
      }
      return http(status: 200, json: try JSONSerialization.data(withJSONObject: payload))
    } catch {
      let payload: [String: Any] = ["ok": false, "error": error.localizedDescription]
      let json = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{\"ok\":false}".utf8)
      return http(status: 500, json: json)
    }
  }

  private func textInput(in app: XCUIApplication, normalizedX: Double?, normalizedY: Double?) -> XCUIElement? {
    guard let normalizedX, let normalizedY else { return nil }
    let window = app.windows.firstMatch
    guard window.exists, !window.frame.isEmpty else { return nil }
    let frame = window.frame
    let point = CGPoint(
      x: frame.minX + normalizedX * frame.width,
      y: frame.minY + normalizedY * frame.height
    )
    return [
      app.textFields,
      app.secureTextFields,
      app.searchFields,
      app.textViews,
    ]
      .flatMap { $0.allElementsBoundByIndex }
      .filter { element in
        guard element.exists, element.frame.contains(point) else { return false }
        return true
      }
      .min { lhs, rhs in
        lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
      }
  }

  private func serialize(_ snapshot: XCUIElementSnapshot) -> [String: Any] {
    var node: [String: Any] = [
      "type": typeName(snapshot.elementType),
      "role_description": typeName(snapshot.elementType),
      "AXLabel": snapshot.label,
      "AXValue": snapshot.value.map(String.init(describing:)) ?? "",
      "enabled": snapshot.isEnabled,
      "frame": [
        "x": snapshot.frame.origin.x,
        "y": snapshot.frame.origin.y,
        "width": snapshot.frame.size.width,
        "height": snapshot.frame.size.height,
      ],
      "children": snapshot.children.map(serialize),
    ]
    if !snapshot.identifier.isEmpty {
      node["AXUniqueId"] = snapshot.identifier
      node["identifier"] = snapshot.identifier
    }
    return node
  }

  private func typeName(_ type: XCUIElement.ElementType) -> String {
    switch type {
    case .application: return "Application"
    case .window: return "Window"
    case .button: return "Button"
    case .cell: return "Cell"
    case .staticText: return "StaticText"
    case .textField: return "TextField"
    case .textView: return "TextView"
    case .secureTextField: return "SecureTextField"
    case .switch: return "Switch"
    case .slider: return "Slider"
    case .link: return "Link"
    case .image: return "Image"
    case .navigationBar: return "NavigationBar"
    case .tabBar: return "TabBar"
    case .collectionView: return "CollectionView"
    case .table: return "Table"
    case .scrollView: return "ScrollView"
    case .searchField: return "SearchField"
    case .segmentedControl: return "SegmentedControl"
    case .stepper: return "Stepper"
    case .picker: return "Picker"
    case .checkBox: return "CheckBox"
    case .menuItem: return "MenuItem"
    case .keyboard: return "Keyboard"
    case .key: return "Key"
    case .other: return "Other"
    default: return "Other"
    }
  }

  private func http(status: Int, json: Data) -> Data {
    var response = Data("HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n".utf8)
    response.append(json)
    return response
  }
}

private struct Request: Decodable {
  let command: String
  let bundleId: String?
  let text: String?
  let x: Double?
  let y: Double?
}

private enum RunnerError: LocalizedError {
  case invalidBundleId
  case invalidText
  case invalidCommand

  var errorDescription: String? {
    switch self {
    case .invalidBundleId: return "command requires bundleId"
    case .invalidText: return "typeText requires non-empty text"
    case .invalidCommand: return "unsupported runner command"
    }
  }
}
