module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      ["module:metro-react-native-babel-preset"],
      ["@babel/plugin-proposal-decorators", { legacy: true }],
    ],
  };
};
