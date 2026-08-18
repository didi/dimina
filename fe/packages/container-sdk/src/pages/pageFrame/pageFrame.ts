import { modDefine, modRequire } from '@dimina/common'
import './pageFrame.scss'
import '@dimina/components/style'
import '@dimina/render'

if (import.meta.env.DEV) {
	void import('./vconsole')
}

window.modDefine = modDefine
window.modRequire = modRequire
