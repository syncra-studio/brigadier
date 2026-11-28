// The phone takes the desktop's app/shared straight from the tree [D58].
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../app/shared")];
module.exports = config;
