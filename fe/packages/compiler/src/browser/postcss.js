// Browser builds retain scoping/rpx/url transforms, without desktop browser
// database discovery or production-only minification.
export default function () { return { postcssPlugin: 'dimina-browser-noop', Once() {} } }
export function render() { throw new Error('The browser compiler supports WXSS, not Less or Sass') }
export function compileString() { throw new Error('The browser compiler supports WXSS, not Less or Sass') }
