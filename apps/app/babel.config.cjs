// Expo's preset, with NativeWind's JSX transform so `className` works on every React Native view (apps/app/ui).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
  };
};
