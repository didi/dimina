import { BrowserMultiFormatReader } from '@zxing/browser'
import { decoded, scanHints } from './scan-formats.js'
import './scan.css'

const call = (name, ...args) => window.mygo.call(`Desktop.${name}`, ...args)
const status = document.querySelector('#status')
const video = document.querySelector('#camera')
const devices = document.querySelector('#devices')
const retry = document.querySelector('#retry')
let controls, reader, onlyFromCamera = false, finished = false, generation = 0
const stop = () => { controls?.stop(); controls = undefined; for (const track of video.srcObject?.getTracks() || []) track.stop(); video.srcObject = null }
const complete = async (result, error = '') => { if (finished) return; finished = true; ++generation; stop(); await call('ScanComplete', result, error) }
async function startCamera(deviceId) {
	const current = ++generation; stop(); retry.hidden = true; status.textContent = '正在打开相机…'
	try {
		const active = await reader.decodeFromConstraints({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' } }, video, (result) => { if (result && current === generation) complete(decoded(result)) })
		if (finished || current !== generation) { active.stop(); return }
		controls = active; status.textContent = '将二维码或条码置于取景框内'
		const cameras = await BrowserMultiFormatReader.listVideoInputDevices()
		devices.replaceChildren(...cameras.map((camera, i) => new Option(camera.label || `相机 ${i + 1}`, camera.deviceId)))
		devices.value = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId || deviceId || cameras[0]?.deviceId || ''
		devices.hidden = cameras.length < 2
	} catch (error) {
		if (finished || current !== generation) return
		status.textContent = error.name === 'NotAllowedError' ? '相机权限未开启，请在系统设置中允许访问相机' : error.name === 'NotFoundError' ? (onlyFromCamera ? '未找到可用相机' : '未找到可用相机，可选择图片识别') : `无法打开相机：${error.message || error}`
		retry.hidden = false
	}
}
document.querySelector('#close').onclick = () => complete(null, 'cancel')
document.addEventListener('keydown', event => { if (event.key === 'Escape') complete(null, 'cancel') })
window.addEventListener('pagehide', () => { ++generation; stop() })
retry.onclick = () => startCamera(devices.value)
devices.onchange = () => startCamera(devices.value)
document.querySelector('#image').onclick = () => { ++generation; stop(); status.textContent = '请选择包含二维码或条码的图片'; retry.hidden = false }
document.querySelector('#image').onchange = async (event) => {
	const file = event.target.files[0]; if (!file || finished) return
	++generation; stop(); const url = URL.createObjectURL(file)
	try { const result = await reader.decodeFromImageUrl(url); await complete(decoded(result)) }
	catch { status.textContent = '未识别到所选类型的码，请更换图片或重试相机'; retry.hidden = false }
	finally { URL.revokeObjectURL(url); event.target.value = '' }
}
try {
	const params = await call('ScanBootstrap')
	const hints = scanHints(params.scanType)
	reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 })
	onlyFromCamera = !!params.onlyFromCamera
	document.querySelector('#image-picker').hidden = onlyFromCamera
	await startCamera()
} catch (error) { status.textContent = `无法启动扫码：${error.message || error}` }
