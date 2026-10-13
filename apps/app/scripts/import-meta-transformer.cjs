// A Metro transformer that runs Expo's own, after one change: pdf.js (pdfjs-dist) has `import.meta.url` in a path only Node takes, and a web bundle is a classic script, where `import.meta` is a syntax error
// that would stop the whole app, not just the PDF page. The expression is replaced with an empty string in that package's files only; nothing else is touched.
// Expo's own transformer, found from the expo package (it is nested under expo in node_modules).
const upstream = require(require.resolve("@expo/metro-config/babel-transformer", { paths: [require.resolve("expo/package.json")] }));

module.exports.transform = function transform(props) {
  const { filename, src } = props;
  if (/(^|[\\/])node_modules[\\/]pdfjs-dist[\\/]/.test(filename) && src.includes("import.meta")) {
    return upstream.transform({ ...props, src: src.replace(/import\.meta\.url/g, '""') });
  }
  return upstream.transform(props);
};
