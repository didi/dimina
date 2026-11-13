import { BarcodeFormat, DecodeHintType } from '@zxing/library'

const types = {
	qrCode: [BarcodeFormat.QR_CODE],
	barCode: [BarcodeFormat.AZTEC, BarcodeFormat.CODABAR, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.CODE_128, BarcodeFormat.EAN_8, BarcodeFormat.EAN_13, BarcodeFormat.ITF, BarcodeFormat.RSS_14, BarcodeFormat.RSS_EXPANDED, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.UPC_EAN_EXTENSION],
	datamatrix: [BarcodeFormat.DATA_MATRIX], pdf417: [BarcodeFormat.PDF_417],
}
export function decoded(result) {
	const format = result.getBarcodeFormat()
	const scanType = format === BarcodeFormat.QR_CODE ? 'QR_CODE' : format === BarcodeFormat.DATA_MATRIX ? 'DATA_MATRIX' : format === BarcodeFormat.PDF_417 ? 'PDF_417' : BarcodeFormat[format]
	const bytes = result.getRawBytes() || new TextEncoder().encode(result.getText())
	let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte)
	return { result: result.getText(), scanType, charSet: 'UTF-8', rawData: btoa(raw) }
}

export function scanHints(scanType) {
    return new Map([[DecodeHintType.POSSIBLE_FORMATS, (scanType?.length ? scanType : Object.keys(types)).flatMap(type => types[type] || [])], [DecodeHintType.TRY_HARDER, true]])
}
