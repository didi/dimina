// The browser compiler does not load the desktop Browserslist database.
// Keep this static plugin separate from the lazily loaded style-tool adapters.
export default function () { return { postcssPlugin: 'dimina-browser-noop', Once() {} } }
