import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

import axios from 'axios'
import cors from 'cors'
import express from 'express'

import {
	assertSafeTarget,
	createSafeLookup,
	isAllowedBrowserOrigin,
	sanitizeRequestHeaders,
} from './security.js'

const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
const ALLOWED_RESPONSE_TYPES = new Set(['json', 'text', 'arraybuffer'])

export function createProxyApp({ allowedOrigins = process.env.DIMINA_PROXY_ALLOWED_ORIGINS } = {}) {
	const app = express()

	app.use(cors({
		origin(origin, callback) {
			callback(null, isAllowedBrowserOrigin(origin, allowedOrigins))
		},
	}))
	app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }))

	const safeLookup = createSafeLookup()
	const httpAgent = new http.Agent({ lookup: safeLookup })
	const httpsAgent = new https.Agent({ lookup: safeLookup })

	app.post('/proxy', async (req, res) => {
		try {
			const {
				url,
				data,
				header = {},
				timeout = 30000,
				method = 'GET',
				responseType = 'json',
			} = req.body ?? {}

			const normalizedMethod = String(method).toUpperCase()
			if (!ALLOWED_METHODS.has(normalizedMethod)) {
				return res.status(400).json({ error: 'Invalid HTTP method' })
			}
			if (!ALLOWED_RESPONSE_TYPES.has(responseType)) {
				return res.status(400).json({ error: 'Invalid response type' })
			}

			const target = await assertSafeTarget(url)
			const parsedTimeout = Number.parseInt(timeout, 10)
			const boundedTimeout = Number.isFinite(parsedTimeout)
				? Math.min(Math.max(parsedTimeout, 1), 30000)
				: 30000

			const response = await axios({
				method: normalizedMethod,
				url: target.href,
				timeout: boundedTimeout,
				headers: {
					'Content-Type': 'application/json',
					...sanitizeRequestHeaders(header),
				},
				...(normalizedMethod !== 'GET' && { data }),
				...(normalizedMethod === 'GET' && data && { params: data }),
				responseType,
				validateStatus: () => true,
				// Redirects must be validated independently; disabling them prevents
				// a public endpoint from redirecting the proxy into a private network.
				maxRedirects: 0,
				maxContentLength: MAX_RESPONSE_BODY_BYTES,
				maxBodyLength: MAX_REQUEST_BODY_BYTES,
				proxy: false,
				httpAgent,
				httpsAgent,
			})

			if (responseType === 'arraybuffer') {
				const contentType = response.headers['content-type'] || 'application/octet-stream'
				res.set('Content-Type', contentType)
				res.status(response.status).send(response.data)
			}
			else if (responseType === 'text') {
				const contentType = response.headers['content-type'] || 'text/plain; charset=utf-8'
				res.set('Content-Type', contentType)
				res.status(response.status).send(response.data)
			}
			else {
				res.set('Content-Type', 'application/json')
				res.status(response.status).json(response.data)
			}
		}
		catch (error) {
			const statusCode = error.response?.status || (error.code === 'DIMINA_UNSAFE_TARGET' ? 403 : 500)
			const errorMessage = error.response?.data?.message || error.message || 'Internal Server Error'

			res.status(statusCode).json({
				error: errorMessage,
				status: statusCode,
				timestamp: new Date().toISOString(),
			})
		}
	})

	return app
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntrypoint) {
	const host = process.env.DIMINA_PROXY_HOST || '127.0.0.1'
	const port = Number.parseInt(process.env.DIMINA_PROXY_PORT || '7788', 10)
	createProxyApp().listen(port, host, () => {
		console.log(`Dimina proxy is listening on http://${host}:${port}`)
	})
}
