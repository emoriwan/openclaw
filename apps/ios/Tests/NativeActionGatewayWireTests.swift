import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
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

        struct Voice: Decodable {
            let message: String
            let transcript: String
            let deniedMessage: String
            let deniedTranscript: String
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
        let voice: [String: Voice]

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
        let voiceSessionId: String?
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
            let aclVoice = try await Self.beginVoice(presentation, id: "controlACL")
            try await Self.closeVoice(presentation, id: "controlACL", voice: aclVoice)

            try await Self.retireAcceptedSubmission(presentation)
            try await Self.rejectAcrossSuspension(
                presentation, first: "profileSuspended", second: "profile", mutation: "merge-profile")
            let profileControl = try await presentation.prepare(
                "controlProfile", profileID: fixture.bobProfileID).submit()
            try await fixture.verify("controlProfile", runID: profileControl.runID)
            try await Self.verifyMedia(presentation, id: "controlProfile", session: "controlProfile", allowed: true)
            let profileVoice = try await Self.beginVoice(presentation, id: "controlProfile")
            try await Self.retireVoiceCleanup(presentation, voice: profileVoice)
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
        let voice = try await Self.beginVoice(presentation, id: second)
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
            try await Self.rejectVoice(presentation, id: second, voice: voice)
        } catch {
            await presentation.disconnect()
            submission.cancel()
            _ = await submission.result
            throw error
        }
    }

    private struct VoiceAttempt {
        let transport: RealtimeTalkRelayTransport
        let binding: IOSNativeActionBinding
        let voiceSessionID: String

        var target: [String: OpenClawProtocol.AnyCodable] {
            [
                "sessionKey": .init(self.binding.session.sessionKey),
                "voiceSessionId": .init(self.voiceSessionID),
            ]
        }
    }

    @MainActor
    private static func beginVoice(_ presentation: Presentation, id: String) async throws -> VoiceAttempt {
        let fixture = presentation.fixture
        let spec = try #require(fixture.voice[id])
        let binding = try #require(presentation.binding)
        let transport = RealtimeTalkRelayTransport.ios(
            gateway: binding.gateway, route: binding.route, nativeBinding: binding)
        _ = try await fixture.control("voice-start", fields: ["case": id])
        let data = try await transport.request(
            "talk.client.toolCall",
            [
                "sessionKey": .init(binding.session.sessionKey),
                "name": .init("openclaw_agent_consult"),
                "callId": .init(UUID().uuidString),
                "args": .init(["question": spec.message]),
            ],
            15000)
        struct Receipt: Decodable { let runId: String }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        try #require(!receipt.runId.isEmpty)
        // The fixture reads the owner record after terminal consult effects.
        // No test-created id or provider session substitutes for that record.
        let opened = try await fixture.control("voice-opened", fields: ["case": id, "runId": receipt.runId])
        let voiceID = try #require(opened.voiceSessionId)
        try #require(!voiceID.isEmpty)
        let voice = VoiceAttempt(transport: transport, binding: binding, voiceSessionID: voiceID)
        _ = try await transport.request(
            "talk.client.transcript",
            voice.target.merging([
                "entryId": .init(UUID().uuidString), "role": .init("user"), "text": .init(spec.transcript),
            ]) { _, next in next },
            15000)
        _ = try await fixture.control(
            "voice-baseline", fields: ["case": id, "voiceSessionId": voiceID])
        return voice
    }

    @MainActor
    private static func rejectVoice(
        _ presentation: Presentation,
        id: String,
        voice: VoiceAttempt) async throws
    {
        let fixture = presentation.fixture
        let spec = try #require(fixture.voice[id])
        let requests: [(String, [String: OpenClawProtocol.AnyCodable])] = [
            ("talk.client.toolCall", [
                "name": .init("openclaw_agent_consult"), "callId": .init(UUID().uuidString),
                "args": .init(["question": spec.deniedMessage]),
            ]),
            ("talk.client.transcript", [
                "entryId": .init(UUID().uuidString), "role": .init("user"), "text": .init(spec.deniedTranscript),
            ]),
            ("talk.client.close", [:]),
        ]
        for (method, fields) in requests {
            let rejection: Error?
            do {
                _ = try await voice.transport.request(
                    method, voice.target.merging(fields) { _, next in next }, 15000)
                rejection = nil
            } catch {
                rejection = error
            }
            let error = try #require(rejection, "Retired native voice authority was accepted.")
            try #require(error is GatewayResponseError)
            try #require(!error.localizedDescription.isEmpty)
        }
        _ = try await fixture.control(
            "voice-complete", fields: ["case": id, "outcome": "rejected", "voiceSessionId": voice.voiceSessionID])
    }

    @MainActor
    private static func closeVoice(
        _ presentation: Presentation,
        id: String,
        voice: VoiceAttempt) async throws
    {
        _ = try await voice.transport.request("talk.client.close", voice.target, 15000)
        _ = try await presentation.fixture.control(
            "voice-complete", fields: ["case": id, "outcome": "allowed", "voiceSessionId": voice.voiceSessionID])
    }

    @MainActor
    private final class VoiceStartBarrier {
        private var entered = false
        private var released = false
        private var continuation: CheckedContinuation<Void, Never>?

        func suspend() async {
            guard !self.entered else { return }
            self.entered = true
            guard !self.released else { return }
            await withCheckedContinuation { self.continuation = $0 }
        }

        func waitUntilEntered() async throws {
            let deadline = ContinuousClock.now + .seconds(10)
            while !self.entered, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            try #require(self.entered, "Native voice did not reach the pre-permission barrier.")
        }

        func release() {
            self.released = true
            self.continuation?.resume()
            self.continuation = nil
        }
    }

    @MainActor
    private static func retireVoiceCleanup(_ presentation: Presentation, voice: VoiceAttempt) async throws {
        let fixture = presentation.fixture
        let model = presentation.model
        let talk = model.talkMode
        let firstGate = VoiceStartBarrier()
        let successorGate = VoiceStartBarrier()
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "talk.enabled")
        var starts: [Task<Void, Error>] = []
        var cleanup: Task<Void, Never>?
        var holding = false
        let outcome: Result<Void, Error>
        do {
            talk.attachGateway(model.operatorSession)
            talk.updateGatewayConnected(true)
            talk._test_setStartEntryHandler { await firstGate.suspend() }
            talk.resumeAfterBackground()
            let first = Task { @MainActor in
                try await model.startNativeTalk(nativeBinding: voice.binding, presentationIsCurrent: { true })
            }
            starts.append(first)
            try await firstGate.waitUntilEntered()
            try #require(!talk.isListening && !talk._test_audioSessionIsActive())
            _ = try await fixture.control("hold-response", fields: ["method": "talk.client.close"])
            talk._test_preparePrefetchedRealtimeVoiceSession(voice.voiceSessionID)
            // Await the existing logical-close owner while preserving its real
            // Gateway request. Both startups stay before microphone permission.
            cleanup = Task { @MainActor in await talk._test_invalidatePrefetchedRealtimeSession() }
            let held = try #require(try await fixture.control("wait-held").heldResponse)
            holding = true
            try #require(held.method == "talk.client.close" && held.ok)
            talk.suspendForBackground()
            firstGate.release()
            do {
                try await first.value
                throw OpenClawNativeActionError("The retired voice startup completed.")
            } catch is CancellationError {}
            try #require(!talk.isEnabled && talk.activeNativeBinding == nil)
            talk._test_setStartEntryHandler { await successorGate.suspend() }
            talk.resumeAfterBackground()
            let successorStart = Task { @MainActor in
                try await model.startNativeTalk(nativeBinding: voice.binding, presentationIsCurrent: { true })
            }
            starts.append(successorStart)
            try await successorGate.waitUntilEntered()
            let successor = try #require(talk.setEnabled(true, nativeBinding: voice.binding))
            _ = try await fixture.control("release-response")
            holding = false
            await cleanup?.value
            try #require(talk.ownsNativeCall(successor.callID) && talk.isEnabled)
            try #require(!talk.isListening && !talk._test_audioSessionIsActive())
            _ = try await fixture.control("voice-lifecycle-complete")
            _ = try await fixture.control("voice-complete", fields: [
                "case": "controlProfile", "outcome": "allowed", "voiceSessionId": voice.voiceSessionID,
            ])
            outcome = .success(())
        } catch {
            outcome = .failure(error)
        }
        talk.suspendForBackground()
        for start in starts { start.cancel() }
        firstGate.release()
        successorGate.release()
        if holding { _ = try? await fixture.control("release-response") }
        await cleanup?.value
        for start in starts { _ = await start.result }
        talk._test_setStartEntryHandler(nil)
        if let previous {
            defaults.set(previous, forKey: "talk.enabled")
        } else {
            defaults.removeObject(forKey: "talk.enabled")
        }
        try outcome.get()
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
