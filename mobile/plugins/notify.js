// The Notification Service Extension (plan §1.3), which Expo has no option for: at prebuild, a target
// BrigadierNotify (sh.brigadier.mobile.notify) built from modules/notify/ios/Sealed.swift and Service/, embedded in the
// app, and the Keychain group both read the notification key from: the app's own, so its other items stay where they are.
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const NAME = "BrigadierNotify";
const GROUP = "$(AppIdentifierPrefix)sh.brigadier.mobile";
const SOURCES = ["Sealed.swift", "Service/NotificationService.swift"];
const FILES = ["Sealed.swift", "NotificationService.swift", "Info.plist", `${NAME}.entitlements`];

const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>
`;

const INFO = plist(`
  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>BrigadierKeychainGroup</key><string>${GROUP}</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>`);

const ENTITLEMENTS = plist(`
  <key>keychain-access-groups</key><array><string>${GROUP}</string></array>`);

module.exports = function withNotify(config) {
  config = withEntitlementsPlist(config, (c) => {
    c.modResults["keychain-access-groups"] = [GROUP];
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults.BrigadierKeychainGroup = GROUP;
    return c;
  });
  config = withDangerousMod(config, [
    "ios",
    (c) => {
      const from = path.join(c.modRequest.projectRoot, "modules/notify/ios");
      const to = path.join(c.modRequest.platformProjectRoot, NAME);
      fs.mkdirSync(to, { recursive: true });
      for (const s of SOURCES) fs.copyFileSync(path.join(from, s), path.join(to, path.basename(s)));
      fs.writeFileSync(path.join(to, "Info.plist"), INFO);
      fs.writeFileSync(path.join(to, `${NAME}.entitlements`), ENTITLEMENTS);
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    if (project.pbxTargetByName(NAME)) return c;
    const objects = project.hash.project.objects;
    // addTarget expects these sections, which a fresh prebuild doesn't have yet.
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};
    const group = project.addPbxGroup(FILES, NAME, NAME);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    const target = project.addTarget(NAME, "app_extension", NAME, `${c.ios.bundleIdentifier}.notify`);
    project.addBuildPhase(["Sealed.swift", "NotificationService.swift"], "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
    const configs = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configs)) {
      const settings = configs[key].buildSettings;
      if (!settings || settings.PRODUCT_NAME !== `"${NAME}"`) continue;
      Object.assign(settings, {
        CODE_SIGN_ENTITLEMENTS: `${NAME}/${NAME}.entitlements`,
        CODE_SIGN_STYLE: "Automatic",
        CURRENT_PROJECT_VERSION: c.ios.buildNumber,
        DEVELOPMENT_TEAM: c.ios.appleTeamId,
        GENERATE_INFOPLIST_FILE: "NO",
        INFOPLIST_FILE: `${NAME}/Info.plist`,
        IPHONEOS_DEPLOYMENT_TARGET: "16.4",
        MARKETING_VERSION: c.version,
        SWIFT_VERSION: "5.0",
        TARGETED_DEVICE_FAMILY: '"1"',
      });
    }
    project.addTargetAttribute("DevelopmentTeam", c.ios.appleTeamId, target);
    return c;
  });
};
