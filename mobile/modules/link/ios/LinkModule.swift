import ExpoModulesCore
import LocalAuthentication

public class LinkModule: Module {
    public func definition() -> ModuleDefinition {
        Name("Link")

        Constant("screen") { UserDefaults.standard.string(forKey: "screen") }

        AsyncFunction("unlock") { (reason: String, promise: Promise) in
            LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in promise.resolve(ok) }
        }
    }
}
