import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { brotliDecompressSync } from 'node:zlib'
const here = dirname(fileURLToPath(import.meta.url))
const [buildDirectory, libpagPackage, serviceBundle] = process.argv.slice(2)
if (!buildDirectory) throw new Error('Usage: node native/wasm/tests/run.mjs <CMake build directory> [libpag-miniprogram package directory] [built service.js]')
const temporary = mkdtempSync(resolve(tmpdir(), 'dimina-wasm-tests-'))
const wrapper = readFileSync(resolve(here, '../../../fe/packages/service/src/core/webassembly.js'), 'utf8').replace('export function', 'function')
function run(script, name) {
	const path = resolve(temporary, `${name}.js`)
	writeFileSync(path, script)
	for (const executable of process.platform === 'darwin' ? ['wasm_qjs', 'wasm_jsc'] : ['wasm_qjs']) {
		const child = spawnSync(resolve(buildDirectory, executable), [path], { encoding: 'utf8' })
		if (child.error) throw child.error
		if (child.status !== 0) throw new Error(`${executable} ${name}: ${child.stderr || child.stdout || child.signal}`)
		console.log(`${executable} ${name}: passed`)
	}
}
try {
	const fixtures = `\nglobalThis.__valueFixtureBytes=${JSON.stringify([...readFileSync(resolve(here, 'fixtures/values.wasm'))])};\nglobalThis.__fixtureBytes=${JSON.stringify([...readFileSync(resolve(here, 'fixtures/memory.wasm'))])};\n`
	run(wrapper + fixtures + readFileSync(resolve(here, 'runtime.js'), 'utf8'), 'runtime')
	run(wrapper + fixtures + readFileSync(resolve(here, 'transfer.js'), 'utf8'), 'transfer')
	const hostFixtures = `\nglobalThis.__hostMemoryBytes=${JSON.stringify([...readFileSync(resolve(here, 'fixtures/host-memory.wasm'))])};\nglobalThis.__hostMemoryAuxBytes=${JSON.stringify([...readFileSync(resolve(here, 'fixtures/host-memory-aux.wasm'))])};\n`
	run(wrapper + hostFixtures + readFileSync(resolve(here, 'host-growth.js'), 'utf8'), 'host-growth')
	const layout = spawnSync(resolve(buildDirectory, 'wasm_memory_layout'), ['host-memory', 'host-memory-aux', 'private-memory-aux'].map(name => resolve(here, `fixtures/${name}.wasm`)), { encoding: 'utf8' })
	if (layout.error) throw layout.error
	if (layout.status !== 0) throw new Error(`memory layout: ${layout.stderr || layout.stdout || layout.signal}`)
	console.log('WAMR exported and private memory layout: passed')
	if (libpagPackage) {
		const wasm = brotliDecompressSync(readFileSync(resolve(libpagPackage, 'lib/libpag.wasm.br')))
		const uncompressed = readFileSync(resolve(libpagPackage, 'lib/libpag.wasm'))
		if (!wasm.equals(uncompressed)) throw new Error('Compressed libpag Wasm differs from uncompressed file')
		const fixture = readFileSync(resolve(here, 'fixtures/red.pag'))
		if (JSON.parse(readFileSync(resolve(libpagPackage, 'package.json'))).version !== '4.5.85') throw new Error('Expected libpag-miniprogram@4.5.85')
		const environment = `
            globalThis.__expectsAsync=true;
            globalThis.navigator={userAgent:'Dimina'};
            globalThis.console={log:()=>{},warn:()=>{},error:(...args)=>{globalThis.__testFailure=args.map(String).join(' ')}};
            globalThis.setTimeout=()=>0; globalThis.clearTimeout=()=>{}; globalThis.exports={};
            const wasmBytes=new Uint8Array(${JSON.stringify([...wasm])}).buffer;
            const pagBytes=new Uint8Array(${JSON.stringify([...fixture])}).buffer;
            globalThis.wx={env:{USER_DATA_PATH:'difile://usr'},getSystemInfoSync:()=>({platform:'ios',pixelRatio:1}),getFileSystemManager:()=>({accessSync:()=>{},mkdirSync:()=>{},readCompressedFile:opts=>{
                if(opts.filePath!=='/utils/libpag.wasm.br'||opts.compressionAlgorithm!=='br')throw new Error('Incorrect Wasm package path');
                opts.success({data:wasmBytes});
            }})};
        `
		const verification = `
            exports.PAGInit({locateFile:file=>'/utils/'+file}).then(async pag=>{
                const file=await pag.PAGFile.load(pagBytes);
                if(file.width()!==720||file.height()!==1280||file.duration()!==15000000||file.numChildren()!==1)throw new Error('Incorrect PAG metadata');
                const oldHeap=pag.HEAPU8;
                const pointer=pag._malloc(48*1024*1024);
                if(!pointer)throw new Error('PAG memory allocation failed');
                if(oldHeap.buffer.byteLength!==0 || pag.HEAPU8.byteLength<=48*1024*1024)throw new Error('PAG memory was not grown and detached');
                pag.HEAPU8[pointer]=73;
                if(pag.HEAPU8[pointer]!==73)throw new Error('PAG heap growth failed');
                pag._free(pointer);file.destroy();globalThis.__teardownBuffers=[pag.HEAPU8.buffer];globalThis.__testComplete=true;
            }).catch(error=>{globalThis.__testFailure=String(error)});
        `
		const library = readFileSync(resolve(libpagPackage, 'lib/libpag.js'), 'utf8')
		if (serviceBundle) {
			const prelude = `globalThis.__VIRTUAL_FILE_PREFIX__='difile://';globalThis.console={log:()=>{},error:()=>{},warn:()=>{}};
                globalThis.setTimeout=()=>0;globalThis.setInterval=()=>0;globalThis.clearTimeout=()=>{};globalThis.clearInterval=()=>{};
                globalThis.DiminaServiceBridge={invoke:()=>undefined,publish:()=>{},sendMessage:()=>{}};`
			const sdk = readFileSync(serviceBundle, 'utf8')
			const importCheck = `if(!wx.canIUse('WXWebAssembly'))throw new Error('Service startup did not install WXWebAssembly');`
			run(prelude + sdk + importCheck + environment + `modDefine('utils/libpag',function(require,module,exports){${library}\n});globalThis.exports=modRequire('utils/libpag');if(typeof exports.PAGInit!=='function')throw new Error(globalThis.__testFailure||'Missing libpag module exports');` + verification, 'service-libpag-import')
		} else run(wrapper + environment + library + verification, 'libpag-4.5.85')
	}
} finally { rmSync(temporary, { recursive: true, force: true }) }
