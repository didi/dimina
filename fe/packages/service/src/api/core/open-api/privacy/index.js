import { invokeAPI } from '@/api/common'

export function getPrivacySetting(opts) {
	return invokeAPI('getPrivacySetting', opts)
}
