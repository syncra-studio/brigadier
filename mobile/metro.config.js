// The phone takes the desktop's app/shared straight from the tree [D58].
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
// The desktop's theme.css becomes src/theme-values.js's values [D99].
config.transformer.babelTransformerPath = require.resolve("./theme-css");
config.watchFolders = [path.resolve(__dirname, "../app/shared")];
module.exports = config;
