import CryptoKit
import Foundation
import Security

struct EncryptedPayload: Codable, Equatable {
    let ephemeralPublicKey: Data
    let nonce: Data
    let ciphertext: Data
    let tag: Data
}

enum VaultCrypto {
    private static let keychainService = "io.github.dfxe.clipboard-box"
    private static let privateKeyAccount = "vault-keyagreement-private-key"
    private static let fingerprintKeyAccount = "vault-fingerprint-key"

    static var publicKeyData: Data {
        privateKey.publicKey.rawRepresentation
    }

    static func encrypt(_ data: Data) throws -> EncryptedPayload {
        let recipientPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKeyData)
        let ephemeralPrivateKey = Curve25519.KeyAgreement.PrivateKey()
        let sharedSecret = try ephemeralPrivateKey.sharedSecretFromKeyAgreement(with: recipientPublicKey)
        let key = symmetricKey(from: sharedSecret, ephemeralPublicKey: ephemeralPrivateKey.publicKey.rawRepresentation)
        let sealed = try AES.GCM.seal(data, using: key)

        return EncryptedPayload(
            ephemeralPublicKey: ephemeralPrivateKey.publicKey.rawRepresentation,
            nonce: sealed.nonce.data,
            ciphertext: sealed.ciphertext,
            tag: sealed.tag
        )
    }

    static func decrypt(_ payload: EncryptedPayload) throws -> Data {
        let ephemeralPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: payload.ephemeralPublicKey)
        let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: ephemeralPublicKey)
        let key = symmetricKey(from: sharedSecret, ephemeralPublicKey: payload.ephemeralPublicKey)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: payload.nonce),
            ciphertext: payload.ciphertext,
            tag: payload.tag
        )
        return try AES.GCM.open(box, using: key)
    }

    static func fingerprint(kind: String, data: Data) -> String {
        var bytes = Data(kind.utf8)
        bytes.append(0)
        bytes.append(data)

        let code = HMAC<SHA256>.authenticationCode(for: bytes, using: SymmetricKey(data: fingerprintKeyData))
        return Data(code).map { String(format: "%02x", $0) }.joined()
    }

    private static let privateKey: Curve25519.KeyAgreement.PrivateKey = {
        if let data = readKeychainData(account: privateKeyAccount),
           let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data) {
            return key
        }

        let key = Curve25519.KeyAgreement.PrivateKey()
        saveKeychainData(key.rawRepresentation, account: privateKeyAccount)
        return key
    }()

    private static let fingerprintKeyData: Data = {
        if let data = readKeychainData(account: fingerprintKeyAccount), data.count == 32 {
            return data
        }

        var key = Data(count: 32)
        let status = key.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
        }
        if status != errSecSuccess {
            key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        }
        saveKeychainData(key, account: fingerprintKeyAccount)
        return key
    }()

    private static func symmetricKey(from sharedSecret: SharedSecret, ephemeralPublicKey: Data) -> SymmetricKey {
        sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: ephemeralPublicKey + publicKeyData,
            sharedInfo: Data("clipboard-box-vault-v1".utf8),
            outputByteCount: 32
        )
    }

    private static func readKeychainData(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func saveKeychainData(_ data: Data, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)

        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attrs as CFDictionary, nil)
    }
}

private extension AES.GCM.Nonce {
    var data: Data {
        Data(self)
    }
}
