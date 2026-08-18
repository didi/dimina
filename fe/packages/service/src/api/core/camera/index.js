import { invokeAPI } from '@/api/common'

export function createCameraContext() {
	return new CameraContext()
}

class CameraContext {
	takePhoto(data = {}) {
		return invokeAPI('takePhoto', data)
	}

	startRecord(data = {}) {
		// Keep camera recording separate from the legacy voice startRecord API.
		return invokeAPI('startRecordCamera', data)
	}

	stopRecord(data = {}) {
		return invokeAPI('stopRecordCamera', data)
	}
}
