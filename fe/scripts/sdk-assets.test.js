const assert = require('node:assert/strict')
const { test } = require('node:test')
const { getWebOnlySdkAssets } = require('./sdk-assets')

test('native SDK packaging excludes generator and compiler assets while retaining shared runtime chunks', () => {
	const manifest = {
		'src/generator.js': { isDynamicEntry: true, file: 'assets/generator.js', css: ['assets/generator.css'], assets: ['assets/compiler-worker-hash.js'], imports: ['shared.js'], dynamicImports: ['editor.js'] },
		'pageFrame.html': { isEntry: true, file: 'assets/pageFrame.js', css: ['assets/pageFrame.css'], imports: ['shared.js'] },
		'index.html': { isEntry: true, file: 'assets/index.js', assets: ['assets/service.js'], dynamicImports: ['src/generator.js'] },
		'shared.js': { file: 'assets/shared.js' },
		'editor.js': { file: 'assets/editor-hash.js', imports: ['shared.js'] },
	}
	assert.deepEqual([...getWebOnlySdkAssets(manifest)].sort(), ['compiler-worker-hash.js', 'editor-hash.js', 'generator.css', 'generator.js'])
})

test('packaging requires current build metadata rather than silently bundling the compiler', () => {
	assert.throws(() => getWebOnlySdkAssets({}), /rebuild/)
})
