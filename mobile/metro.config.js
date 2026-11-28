// The phone takes the desktop's app/shared straight from the tree [D58].
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
// The desktop's theme.css becomes src/theme-values.js's values [D99].
config.transformer.babelTransformerPath = require.resolve("./theme-css");
// The desktop's icon files are drawn as they are: their JSX goes through src/svg-jsx.ts [D99].
const ICONS = path.resolve(__dirname, "../app/ui/src/icons") + path.sep;
const GIT_ICONS = path.resolve(__dirname, "../app/ui/src/landing/icons.tsx");
const SVG_JSX = path.resolve(__dirname, "src/svg-jsx.ts");
const isIcons = (file) => file.startsWith(ICONS) || file === GIT_ICONS;
config.resolver.resolveRequest = (context, name, platform) =>
  /^react\/jsx(-dev)?-runtime$/.test(name) && isIcons(context.originModulePath)
    ? { type: "sourceFile", filePath: SVG_JSX }
    : context.resolveRequest(context, name, platform);
config.watchFolders = [path.resolve(__dirname, "../app/shared"), path.resolve(__dirname, "../app/ui/src")];
module.exports = config;
