import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private struct MacNativeWireDescriptor: Decodable, Sendable {
    struct Case: Decodable, Sendable {
        let sessionKey: String
        let marker: String
        let message: String
    }

    let version: Int
    let gatewayURL: URL
    let controlURL: URL
    let controlToken: String
    let aliceProfileID: String
    let bobProfileID: String
    let cases: [String: Case]
}

private struct MacNativeWireControlResponse: Decodable, Sendable {
    struct HeldResponse: Decodable, Sendable {
        let method: String
        let ok: Bool
        let runId: String?
    }

    let paired: Bool?
    let revoked: Bool?
    let profileID: String?
    let verified: String?
    let completed: String?
    let heldResponse: HeldResponse?
}

@MainActor
private final class MacNativeWireControl {
    let descriptor: MacNativeWireDescriptor
    private let session = URLSession(configuration: .ephemeral)

    init(descriptor: MacNativeWireDescriptor) {
        self.descriptor = descriptor
    }

    func close() {
        self.session.invalidateAndCancel()
    }

    @discardableResult
    func request(
        _ action: String,
        fields: [String: String] = [:]) async throws -> MacNativeWireControlResponse
    {
        var request = URLRequest(url: self.descriptor.controlURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue(self.descriptor.controlToken, forHTTPHeaderField: "x-qa-fixture-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization
            .data(withJSONObject: fields.merging(["action": action]) { _, rhs in rhs })
        let (data, response) = try await self.session.data(for: request)
        try #require((response as? HTTPURLResponse)?.statusCode == 200, "Fixture control failed: \(action)")
        try #require(data.count <= 32768)
        return try JSONDecoder().decode(MacNativeWireControlResponse.self, from: data)
    }

    func verify(_ id: String, run: OpenClawNativeRunRef? = nil) async throws {
        var fields = ["case": id, "outcome": run == nil ? "rejected" : "allowed"]
        if let run { fields["runId"] = run.runID }
        let response = try await self.request("verify", fields: fields)
        try #require(response.verified == id)
    }

    func complete(_ id: String) async throws {
        let response = try await self.request("complete", fields: ["case": id])
        try #require(response.completed == id)
    }

    func submitHolding(
        _ method: String,
        prepared: OpenClawNativePreparedSend,
        whileHeld: (MacNativeWireControlResponse.HeldResponse) async throws -> Void) async throws
        -> Result<OpenClawNativeRunRef, Error>
    {
        try await self.request("hold-response", fields: ["method": method])
        let submission = Task { try await prepared.submit() }
        var holding = false
        do {
            let response = try await self.request("wait-held")
            holding = true
            let held = try #require(response.heldResponse)
            try #require(held.method == method && held.ok)
            try await whileHeld(held)
            try await self.request("release-response")
            holding = false
            return await submission.result
        } catch {
            if holding { try? await self.request("release-response") }
            submission.cancel()
            _ = await submission.result
            throw error
        }
    }
}

@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"] != nil))
@MainActor
struct NativeActionGatewayWireTests {
    @Test func `native submissions retain exact authority through real Gateway effects`() async throws {
        let raw = try #require(ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"])
        let descriptor = try JSONDecoder().decode(MacNativeWireDescriptor.self, from: Data(raw.utf8))
        try #require(descriptor.version == 1)
        let control = MacNativeWireControl(descriptor: descriptor)
        defer { control.close() }
        let configuration: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": ["transport": "direct", "url": descriptor.gatewayURL.absoluteString],
            ],
        ]
        // macOS derives its primary Gateway owner from the configured endpoint.
        // The fixture's gatewayID is an iOS selection ID, not a Gateway-issued identity to compare.
        let gatewayID = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: configuration))
        // Use the production initializer: the test-only endpoint initializer omits device identity.
        let connection = GatewayConnection(
            endpointProvider: {
                .init(
                    config: (descriptor.gatewayURL, nil, nil),
                    routeAuthority: nil,
                    deviceAuthGatewayID: gatewayID)
            },
            supportsSharedEndpointRecovery: false)
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        do {
            try await withIsolatedWebChatManager(
                primaryConnection: connection,
                env: ["OPENCLAW_CONFIG_PATH": configPath])
            { manager in
                try JSONSerialization.data(withJSONObject: configuration)
                    .write(to: URL(fileURLWithPath: configPath))
                do {
                    _ = try await connection.acquireServerLease()
                    throw OpenClawNativeActionError("An unpaired native device was admitted.")
                } catch let error as GatewayConnectAuthError {
                    try #require(error.detailCodeRaw == GatewayConnectAuthDetailCode.pairingRequired.rawValue)
                }
                let pairing = try await control.request("pair")
                try #require(pairing.paired == true)
                _ = try await connection.acquireServerLease()
                let hello = try #require(await connection.lastSnapshot)
                let scopes = try #require(hello.auth["scopes"]?.arrayValue?.compactMap(\.stringValue))
                try #require(Set(scopes) == ["operator.read", "operator.write"])
                try #require(!scopes.contains("operator.admin"))

                let router = NativeActionRouter(windows: manager, launchPlan: .init(arguments: ["OpenClaw"]))
                try await self.exercise(
                    control: control, gatewayID: gatewayID, manager: manager, router: router)
            }
        } catch {
            await connection.shutdown()
            throw error
        }
        await connection.shutdown()
    }

    private func exercise(
        control: MacNativeWireControl,
        gatewayID: String,
        manager: WebChatManager,
        router: NativeActionRouter) async throws
    {
        let descriptor = control.descriptor
        func prepare(_ id: String, profileID: String? = nil) async throws -> OpenClawNativePreparedSend {
            let spec = try #require(descriptor.cases[id])
            let target = OpenClawNativeSessionRef(
                owner: .init(gatewayID: gatewayID, profileID: profileID ?? descriptor.aliceProfileID),
                agentID: "qa",
                sessionKey: spec.sessionKey)
            return try await router.prepareSend(to: target, message: spec.message)
        }
        func allowed(_ id: String, profileID: String? = nil) async throws -> OpenClawNativeRunRef {
            let prepared = try await prepare(id, profileID: profileID)
            let run = try await prepared.submit()
            try #require(!run.runID.isEmpty)
            try await control.verify(id, run: run)
            if id == "allowed" {
                let replay = try await prepared.submit()
                try #require(replay == run)
                try await control.verify(id, run: replay)
            }
            try await control.complete(id)
            return run
        }

        let first = try await allowed("allowed")
        let distinct = try await allowed("distinct")
        try #require(first.runID != distinct.runID)
        try await self.requireVisibleRejection {
            _ = try await prepare("foreign", profileID: descriptor.bobProfileID)
        }
        try await control.verify("foreign")
        try await control.complete("foreign")

        // Each pair shares a session, so preparing the second must preserve the first presentation.
        let acl = try await prepare("acl")
        let aclSuspended = try await prepare("aclSuspended")
        let aclResult = try await control.submitHolding("users.self", prepared: aclSuspended) { _ in
            let response = try await control.request("revoke-acl")
            try #require(response.revoked == true)
        }
        try await self.requireVisibleRejection { _ = try aclResult.get() }
        try await self.requireVisibleRejection { _ = try await acl.submit() }
        for id in ["acl", "aclSuspended"] {
            try await control.verify(id)
            try await control.complete(id)
        }
        _ = try await allowed("controlACL")

        let accepted = try await prepare("accepted")
        var acceptedRunID: String?
        let acceptedResult = try await control.submitHolding("chat.send", prepared: accepted) { held in
            acceptedRunID = try #require(held.runId)
            // Keep the real socket alive; only the presenting native window is retired.
            manager.resetPrimaryConnections()
        }
        let receipt = try acceptedResult.get()
        try #require(receipt.runID == acceptedRunID)
        try await control.verify("accepted", run: receipt)
        try await self.requireVisibleRejection { _ = try await accepted.submit() }
        try await control.verify("accepted", run: receipt)
        try await control.complete("accepted")

        let profile = try await prepare("profile")
        let profileSuspended = try await prepare("profileSuspended")
        let profileResult = try await control.submitHolding("users.self", prepared: profileSuspended) { _ in
            let response = try await control.request("merge-profile")
            try #require(response.profileID == descriptor.bobProfileID)
        }
        try await self.requireVisibleRejection { _ = try profileResult.get() }
        try await self.requireVisibleRejection { _ = try await profile.submit() }
        for id in ["profile", "profileSuspended"] {
            try await control.verify(id)
            try await control.complete(id)
        }
        _ = try await allowed("controlProfile", profileID: descriptor.bobProfileID)
    }

    private func requireVisibleRejection(_ operation: () async throws -> Void) async throws {
        let rejection: Error?
        do {
            try await operation()
            rejection = nil
        } catch {
            rejection = error
        }
        let error = try #require(rejection, "Retired or foreign native authority was accepted.")
        try #require(error is OpenClawNativeActionError || error is GatewayResponseError)
        try #require(!error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}
