# Brigadier for iPhone

Brigadier's iPhone app: your Mac's Brigadier sessions on your phone, paired on the same Wi-Fi.

- Expo SDK 58 / React Native 0.88, iPhone only, iOS 16.4 and later.
- `modules/link/` is the app's native module (Swift): Face ID, the phone's keys in its Keychain, the Secure Enclave key, and the encrypted channel to the Mac.
- `modules/link/ios/BrigadierNoise/` is the handshake: Noise `IKpsk2_25519_ChaChaPoly_SHA256` on Apple's CryptoKit, through [swift-noise](https://github.com/swift-libp2p/swift-noise) (MIT), copied in at a fixed commit.
- `vendor/brigadier-shared/` is the desktop's `app/shared` (the wire's client, the thread's types and words), copied by `scripts/sync-shared <desktop repository> [commit]`; never edited here. `SOURCE` holds the commit.
- The app uses no encryption library other than Apple's: no OpenSSL, BoringSSL, libsodium or the like. Check this before every upload.

## Build and upload (team SYNCRA, SRL)

1. Run `scripts/ios`. It installs the packages and makes `ios/`. It needs Node and CocoaPods.
2. Run `open ios/Brigadier.xcworkspace`.
3. In Xcode, choose Product › Archive, with team **SYNCRA, SRL**, not Personal Team.
4. In the Organizer, choose Distribute App › TestFlight Internal Only › Upload.
5. Raise `ios.buildNumber` in `app.json` for each upload.
