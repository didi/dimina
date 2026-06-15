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
		return invokeAPI('takePhoto', data)
	}

	startRecord() {
		return invokeAPI('startRecord')
	}

	stopRecord() {
		return invokeAPI('stopRecord')
	}
}
