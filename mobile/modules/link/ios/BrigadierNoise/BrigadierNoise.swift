import CryptoKit

/// The phone's end of the encrypted channel to a Mac: Noise_IKpsk2_25519_ChaChaPoly_SHA256, prologue
/// "brigadier/remote/v1", the psk at position 2, as the Mac's daemon speaks it. Nothing above this file knows
/// which library does the handshake.
final class BrigadierNoise {
    /// The largest plaintext one transport message carries (65,535 less the 16-byte tag).
    static let maxPlain = 65_535 - 16
    static let prologue = Array("brigadier/remote/v1".utf8)

    enum Failure: Error { case notReady, handshake, tooLong }

    private let state: Noise.HandshakeState
    private var sender: Noise.CipherState?
    private var receiver: Noise.CipherState?
    /// The handshake hash, once message 2 has opened.
    private(set) var h: [UInt8] = []

    init(staticKey: Curve25519.KeyAgreement.PrivateKey, macKey: [UInt8], psk: [UInt8]) throws {
        state = try Noise.HandshakeState(
            config: Noise.Config(
                cipherSuite: Noise.CipherSuite(keyCurve: .x25519, cipher: .ChaChaPoly1305, hashFunction: .sha256),
                handshakePattern: Noise.Handshakes.IK,
                initiator: true,
                prologue: Self.prologue,
                presharedKey: (key: psk, placement: 2),
                staticKeypair: staticKey,
                remoteStaticKeypair: try Curve25519.KeyAgreement.PublicKey(rawRepresentation: macKey)
            ))
    }

    /// Message 1, carrying `payload`.
    func start(_ payload: [UInt8]) throws -> [UInt8] {
        try state.writeMessage(payload: payload).buffer
    }

    /// Opens message 2 and returns its payload. It throws when the Mac doesn't hold the same psk; the channel is then
    /// dead and is dropped, never retried.
    func finish(_ message: [UInt8]) throws -> [UInt8] {
        let read = try state.readMessage(message)
        guard let c1 = read.c1, let c2 = read.c2 else { throw Failure.handshake }
        (sender, receiver, h) = (c1, c2, state.channelBinding())
        return read.payload
    }

    /// One transport message; `plain` is at most `maxPlain` bytes.
    func seal(_ plain: [UInt8]) throws -> [UInt8] {
        guard let sender else { throw Failure.notReady }
        guard plain.count <= Self.maxPlain else { throw Failure.tooLong }  // before a nonce is used
        return try sender.encrypt(plaintext: plain)
    }

    /// Opens one transport message. A message that doesn't open leaves the nonce where it was.
    func open(_ message: [UInt8]) throws -> [UInt8] {
        guard let receiver else { throw Failure.notReady }
        guard message.count <= Self.maxPlain + 16 else { throw Failure.tooLong }
        return try receiver.decrypt(ciphertext: message)
    }
}
