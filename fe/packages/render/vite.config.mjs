import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
	return {
		build: {
			minify: mode === 'production',
			lib: {
				entry: resolve(__dirname, 'src/index.js'),
				formats: ['es'],
				fileName: 'render',
			},
		},
		define: {
			__DEV__: mode !== 'production',
			__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
		},
		plugins: [vue()],
	}
})
