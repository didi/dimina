import { expect, it } from 'vitest'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { BarcodeFormat, BinaryBitmap, HybridBinarizer, QRCodeWriter, RGBLuminanceSource } from '@zxing/library'
import { decoded, scanHints } from './scan-formats.js'

it('decodes a QR image through the scanner reader and produces the mobile scanCode result', () => {
	const content = 'dimina://desktop/扫码?value=1'
	const matrix = new QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, 300, 300, new Map())
	const pixels = new Int32Array(300 * 300)
	for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) pixels[y * 300 + x] = matrix.get(x, y) ? 0 : 0xffffff
	const image = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, 300, 300)))
	const reader = new BrowserMultiFormatReader(scanHints(['qrCode']))
	const result = decoded(reader.decodeBitmap(image))
	expect(result.result).toBe(content)
	expect(result.scanType).toBe('QR_CODE')
	expect(result.rawData).toMatch(/^[A-Za-z0-9+/]+=*$/)
	expect(result.charSet).toBe('UTF-8')
})
