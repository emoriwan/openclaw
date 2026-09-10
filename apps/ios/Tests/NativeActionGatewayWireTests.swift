import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing
@testable import OpenClaw

/// The harness requires every case's completion, so an absent or mis-selected suite cannot pass CI.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"] != nil))
struct NativeActionGatewayWireTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let sessionKey: String
            let marker: String
            let message: String
        }

        struct Media: Decodable {
            struct Session: Decodable {
                let sessionKey: String
                let artifactID: String
            }

            let pngBase64: String
            let sha256: String
            let sessions: [String: Session]
        }

        let version: Int
        let gatewayURL: URL
        let controlURL: URL
        let controlToken: String
        let gatewayID: String
        let aliceProfileID: String
        let bobProfileID: String
        let cases: [String: Case]
        let media: Media

        func control(_ action: String, fields: [String: String] = [:]) async throws -> ControlResponse {
            var request = URLRequest(url: self.controlURL)
            request.httpMethod = "POST"
            request.timeoutInterval = 210
            request.setValue(self.controlToken, forHTTPHeaderField: "x-qa-fixture-token")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(fields.merging(["action": action]) { _, next in next })
            let (data, response) = try await URLSession.shared.data(for: request)
            try #require((response as? HTTPURLResponse)?.statusCode == 200)
            return try JSONDecoder().decode(ControlResponse.self, from: data)
        }

        func verify(_ id: String, runID: String? = nil, complete: Bool = true) async throws {
            var fields = ["case": id, "outcome": runID == nil ? "rejected" : "allowed"]
            fields["runId"] = runID
            _ = try await self.control("verify", fields: fields)
            if complete {
                _ = try await self.control("complete", fields: ["case": id])
            }
        }
    }

    private struct ControlResponse: Decodable {
        struct HeldResponse: Decodable {
            let method: String
            let ok: Bool
            let runId: String?
            let sha256: String?
            let sizeBytes: Int?
        }

        let heldResponse: HeldResponse?
    }

    @MainActor
    private final class Presentation {
        let fixture: Fixture
        let model: NodeAppModel
        let controller: GatewayConnectionController
        let router: NativeActionRouter
        var presentationID: UUID?
        var binding: IOSNativeActionBinding?
        var chat: OpenClawChatViewModel?
        var transport: IOSGatewayChatTransport?

        init(fixture: Fixture) {
            self.fixture = fixture
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            self.model = model
            let controller = GatewayConnectionController(appModel: model, startDiscovery: false)
            self.controller = controller
            self.router = NativeActionRouter(appModel: model, gatewayController: controller)
            self.presentationID = self.router.registerPresentation { [weak self] request, binding in
                guard let self else { throw CancellationError() }
                self.model.focusChatSession(request.session.sessionKey)
                if self.binding?.matches(binding) == true { return }
                self.chat?.detachTransport()
                let transport = try #require(
                    self.model.makeChatTransport(nativeBinding: binding) as? IOSGatewayChatTransport)
                let chat = OpenClawChatViewModel(
                    sessionKey: request.session.sessionKey,
                    transport: transport,
                    activeAgentId: request.session.agentID,
                    sessionRoutingContract: binding.sessionRoutingContract)
                self.binding = binding
                self.chat = chat
                self.transport = transport
                self.router.registerChat(
                    chat,
                    ownerID: self.model.chatViewModelOwnerID,
                    agentID: request.session.agentID,
                    transport: transport,
                    presentationID: self.presentationID)
                chat.load()
            }
        }

        func connect() async throws {
            let options = GatewayConnectOptions(
                role: "operator",
                scopes: ["operator.read", "operator.write"],
                scopesAreExplicit: true,
                caps: [OpenClawGatewayClientCapability.agentKind, OpenClawGatewayClientCapability.inlineWidgets],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "ui",
                clientDisplayName: "Native wire proof",
                includeDeviceIdentity: true,
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: self.fixture.gatewayID)
            let connect = {
                try await self.model.operatorSession.connect(
                    url: self.fixture.gatewayURL,
                    credentials: .init(),
                    connectOptions: options,
                    sessionBox: nil,
                    onConnected: {},
                    onDisconnected: { _ in },
                    onInvoke: { BridgeInvokeResponse(id: $0.id, ok: false) })
            }
            do {
                try await connect()
            } catch {
                // The first signed native connection must enter real device pairing.
                // The fixture fails if this was any other connect failure.
                _ = try await self.fixture.control("pair")
                try await connect()
            }
            self.model.activeGatewayConnectConfig = GatewayConnectConfig(
                url: self.fixture.gatewayURL,
                stableID: self.fixture.gatewayID,
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: options)
            self.model.connectedGatewayID = self.fixture.gatewayID
            self.model.setOperatorConnected(true)
            let route = try #require(await self.model.operatorSession.currentRoute(ifGatewayID: self.fixture.gatewayID))
            let scopes = await self.model.operatorSession.currentOperatorScopes(ifCurrentRoute: route)
            try #require(scopes == Set(["operator.read", "operator.write"]))
        }

        func prepare(_ id: String, profileID: String? = nil) async throws -> OpenClawNativePreparedSend {
            let spec = try #require(self.fixture.cases[id])
            return try await self.router.prepareSend(
                to: OpenClawNativeSessionRef(
                    owner: .init(
                        gatewayID: self.fixture.gatewayID,
                        profileID: profileID ?? self.fixture.aliceProfileID),
                    agentID: "qa",
                    sessionKey: spec.sessionKey),
                message: spec.message)
        }

        func disconnect() async {
            self.chat?.detachTransport()
            self.chat = nil
            self.transport = nil
            self.binding = nil
            self.model.setOperatorConnected(false)
            await self.model.operatorSession.disconnect()
        }

        func close() async {
            if let presentationID {
                self.router.unregisterPresentation(presentationID)
            }
            await self.disconnect()
            self.model.activeGatewayConnectConfig = nil
            self.model.voiceWake.stop()
            self.model.setTalkEnabled(false)
            await self.model.purgeChatTranscriptCache(gatewayID: self.fixture.gatewayID)
        }
    }

    @Test @MainActor
    func `prepared native actions use real gateway authority and receipts`() async throws {
        let raw = try #require(ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"])
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(raw.utf8))
        try #require(fixture.version == 1)
        try #require(fixture.gatewayURL.scheme == "ws" && fixture.gatewayURL.host == "127.0.0.1")
        try #require(fixture.controlURL.scheme == "http" && fixture.controlURL.host == "127.0.0.1")
        try #require(!fixture.controlToken.isEmpty && fixture.aliceProfileID != fixture.bobProfileID)
        let presentation = Presentation(fixture: fixture)
        do {
            try await presentation.connect()
            let prepared = try await presentation.prepare("allowed")
            let accepted = try await prepared.submit()
            try await fixture.verify("allowed", runID: accepted.runID, complete: false)
            let replay = try await prepared.submit()
            try #require(replay == accepted)
            try await fixture.verify("allowed", runID: replay.runID)

            let distinct = try await presentation.prepare("distinct").submit()
            try #require(distinct.runID != accepted.runID)
            try await fixture.verify("distinct", runID: distinct.runID)
            await #expect(throws: Error.self) {
                _ = try await presentation.prepare("foreign", profileID: fixture.bobProfileID)
            }
            try await fixture.verify("foreign")

            try await Self.rejectAcrossSuspension(
                presentation, first: "aclSuspended", second: "acl", mutation: "revoke-acl")
            let aclControl = try await presentation.prepare("controlACL").submit()
            try await fixture.verify("controlACL", runID: aclControl.runID)
            try await Self.verifyMedia(presentation, id: "controlACL", session: "controlACL", allowed: true)
            try await Self.retireMediaResult(presentation)

            try await Self.retireAcceptedSubmission(presentation)
            try await Self.rejectAcrossSuspension(
                presentation, first: "profileSuspended", second: "profile", mutation: "merge-profile")
            let profileControl = try await presentation.prepare(
                "controlProfile", profileID: fixture.bobProfileID).submit()
            try await fixture.verify("controlProfile", runID: profileControl.runID)
            try await Self.verifyMedia(presentation, id: "controlProfile", session: "controlProfile", allowed: true)
        } catch {
            await presentation.close()
            throw error
        }
        await presentation.close()
    }

    @MainActor
    private static func requireRejection(_ result: Result<OpenClawNativeRunRef, Error>) throws {
        guard case let .failure(error) = result else {
            throw OpenClawNativeActionError("A retired native action was unexpectedly accepted")
        }
        try #require(!error.localizedDescription.isEmpty)
    }

    @MainActor
    private static func rejectAcrossSuspension(
        _ presentation: Presentation,
        first: String,
        second: String,
        mutation: String) async throws
    {
        let fixture = presentation.fixture
        let suspended = try await presentation.prepare(first)
        let beforeAdmission = try await presentation.prepare(second)
        let retainedTransport = try #require(presentation.transport)
        try await Self.verifyMedia(
            presentation, id: "\(second)Allowed", session: second, allowed: true, transport: retainedTransport)
        _ = try await fixture.control("hold-response", fields: ["method": "users.self"])
        let submission = Task { @MainActor in try await suspended.submit() }
        do {
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            try #require(held.method == "users.self" && held.ok)
            _ = try await fixture.control(mutation)
            _ = try await fixture.control("release-response")
            try await Self.requireRejection(submission.result)
            try await fixture.verify(first)
            let direct = Task { @MainActor in try await beforeAdmission.submit() }
            try await Self.requireRejection(direct.result)
            try await fixture.verify(second)
            try await Self.verifyMedia(
                presentation, id: second, session: second, allowed: false, transport: retainedTransport)
        } catch {
            await presentation.disconnect()
            submission.cancel()
            _ = await submission.result
            throw error
        }
    }

    @MainActor
    private static func verifyMedia(
        _ presentation: Presentation,
        id: String,
        session: String,
        allowed: Bool,
        transport retained: (any OpenClawChatTransport)? = nil) async throws
    {
        let fixture = presentation.fixture
        let media = try #require(fixture.media.sessions[session])
        let transport = try #require(retained ?? presentation.transport)
        _ = try await fixture.control("media-start", fields: ["case": id])
        var fields = ["case": id, "outcome": allowed ? "allowed" : "rejected"]
        if allowed {
            let loaded = try await transport.loadMediaArtifact(
                sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
            guard case let .data(image) = loaded else {
                throw OpenClawNativeActionError("The native media loader did not return image bytes.")
            }
            let expected = try #require(Data(base64Encoded: fixture.media.pngBase64))
            try #require(image.mimeType == "image/png" && image.data == expected)
            let digest = SHA256.hash(data: image.data).map { String(format: "%02x", $0) }.joined()
            try #require(digest == fixture.media.sha256)
            fields["sha256"] = digest
        } else {
            let rejection: Error?
            do {
                _ = try await transport.loadMediaArtifact(
                    sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
                rejection = nil
            } catch {
                rejection = error
            }
            let error = try #require(rejection, "Retired native media authority was accepted.")
            try #require(!error.localizedDescription.isEmpty)
        }
        _ = try await fixture.control("media-complete", fields: fields)
    }

    @MainActor
    private static func retireMediaResult(_ presentation: Presentation) async throws {
        let fixture = presentation.fixture
        let media = try #require(fixture.media.sessions["controlACL"])
        let transport = try #require(presentation.transport)
        _ = try await fixture.control("media-start", fields: ["case": "retiredResult"])
        _ = try await fixture.control("hold-response", fields: ["method": "media.get"])
        let loading = Task { @MainActor in
            try await transport.loadMediaArtifact(
                sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
        }
        var holding = false
        do {
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            holding = true
            let expected = try #require(Data(base64Encoded: fixture.media.pngBase64))
            try #require(held.method == "media.get" && held.ok)
            try #require(held.sha256 == fixture.media.sha256 && held.sizeBytes == expected.count)
            await presentation.disconnect()
            _ = try await fixture.control("release-response")
            holding = false
            switch await loading.result {
            case .success:
                throw OpenClawNativeActionError("A retired media request published its held result.")
            case let .failure(error):
                try #require(error is CancellationError)
            }
            _ = try await fixture.control(
                "media-complete", fields: ["case": "retiredResult", "outcome": "rejected"])
            try await presentation.connect()
            _ = try await presentation.prepare("controlACL")
            try await Self.verifyMedia(presentation, id: "retiredControl", session: "controlACL", allowed: true)
        } catch {
            if holding { _ = try? await fixture.control("release-response") }
            loading.cancel()
            _ = await loading.result
            throw error
        }
    }

    @MainActor
    private static func retireAcceptedSubmission(_ presentation: Presentation) async throws {
        let fixture = presentation.fixture
        let prepared = try await presentation.prepare("accepted")
        _ = try await fixture.control("hold-response", fields: ["method": "chat.send"])
        let submission = Task { @MainActor in try await prepared.submit() }
        do {
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            try #require(held.method == "chat.send" && held.ok)
            let runID = try #require(held.runId)
            await presentation.disconnect()
            _ = try await fixture.control("release-response")
            switch await submission.result {
            case let .success(receipt):
                try #require(receipt.runID == runID)
            case let .failure(error):
                // A real successful ACK already exists; retirement is not proof of non-execution.
                try #require(error.localizedDescription.localizedCaseInsensitiveContains("unconfirmed"))
            }
            try await fixture.verify("accepted", runID: runID, complete: false)
            try await presentation.connect()
            let replay = Task { @MainActor in try await prepared.submit() }
            try await Self.requireRejection(replay.result)
            try await fixture.verify("accepted", runID: runID)
        } catch {
            await presentation.disconnect()
            submission.cancel()
            _ = await submission.result
            throw error
        }
    }
}
