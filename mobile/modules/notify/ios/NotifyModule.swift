import ExpoModulesCore

public class NotifyModule: Module {
    public func definition() -> ModuleDefinition {
        Name("Notify")

        AsyncFunction("key") { (device: String, words: [String: String]) -> String in
            try Sealed.keep(device: device, words: words).publicKey.rawRepresentation.base64EncodedString()
        }
    }
}
