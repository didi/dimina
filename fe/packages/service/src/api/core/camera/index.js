import { invokeAPI } from '@/api/common'
import router from '@/core/router'

export function createCameraContext() {
	return new CameraContext()
}

class CameraContext {
	constructor() {
		this.bridgeId = router.getPageInfo().id
	}

	takePhoto(data) {
		invokeAPI('takePhoto', data)
	}

	startRecord() {
		invokeAPI('startRecord')
	}

	stopRecord() {
		invokeAPI('stopRecord')
	}
}
