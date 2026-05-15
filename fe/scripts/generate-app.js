#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const process = require('node:process')
const archiver = require('archiver')

// Define paths
const publicPath = path.resolve(__dirname, '../packages/container/public')
const sharedJsappPath = path.resolve(__dirname, '../../shared/jsapp')

// Helper function to create zip file
function createZip(sourceDir, outputPath) {
	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(outputPath)
		const archive = archiver('zip', {
			zlib: { level: 9 }, // Maximum compression
		})

		output.on('close', () => {
			console.log(`Successfully created ${outputPath} (${archive.pointer()} bytes)`)
			resolve()
		})

		archive.on('error', (err) => {
			reject(err)
		})

		output.on('error', (err) => {
			reject(err)
		})

		archive.pipe(output)
		archive.directory(sourceDir, false)
		archive.finalize()
	})
}

// Main async function
async function main() {
	// Check if the shared/jsapp directory exists
	if (!fs.existsSync(sharedJsappPath)) {
		console.error(`Error: Directory ${sharedJsappPath} does not exist.`)
		console.error('Please create the directory first before running this command.')
		process.exit(1)
	}

	// Get all app directories from public
	const appDirs = fs.readdirSync(publicPath)
		.filter((item) => {
			const itemPath = path.join(publicPath, item)
			return fs.statSync(itemPath).isDirectory() && (item.startsWith('wx') || item.startsWith('dd'))
		})

	console.log('Found app directories:', appDirs)

	// Process each app directory
	for (const appId of appDirs) {
		const appPublicPath = path.join(publicPath, appId)
		const appSharedPath = path.join(sharedJsappPath, appId)

		// Create app directory in shared/jsapp if it doesn't exist
		if (!fs.existsSync(appSharedPath)) {
			fs.mkdirSync(appSharedPath, { recursive: true })
		}

		// Check if app-config.json exists in the app's main directory
		const appConfigPath = path.join(appPublicPath, 'main', 'app-config.json')
		let appName = `App ${appId}`
		let appPath = 'example/index'

		// Extract name and path from app-config.json if it exists
		if (fs.existsSync(appConfigPath)) {
			try {
				const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'))
				if (appConfig.app && appConfig.projectName) {
					appName = appConfig.projectName
				}
				// First try to get entryPagePath, if not available, use the first page from pages array
				if (appConfig.app && appConfig.app.entryPagePath) {
					appPath = appConfig.app.entryPagePath
				}
				else if (appConfig.app && appConfig.app.pages && appConfig.app.pages.length > 0) {
					appPath = appConfig.app.pages[0]
				}
				console.log(`Extracted from app-config.json for ${appId}: name=${appName}, path=${appPath}`)
			}
			catch (error) {
				console.error(`Error reading or parsing app-config.json for ${appId}:`, error)
			}
		}

		// Check if config.json exists in shared/jsapp
		const configPath = path.join(appSharedPath, 'config.json')
		let config = {
			appId,
			name: appName,
			path: appPath,
			versionCode: 1,
			versionName: '1.0.0',
		}

		// If config exists, read it and increment version
		if (fs.existsSync(configPath)) {
			try {
				config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
				config.versionCode += 1

				// Increment the last part of the version name (e.g., 1.0.0 -> 1.0.1)
				const versionParts = config.versionName.split('.')
				versionParts[versionParts.length - 1] = (Number.parseInt(versionParts[versionParts.length - 1]) + 1).toString()
				config.versionName = versionParts.join('.')

				console.log(`Incrementing version for ${appId}: ${config.versionName} (${config.versionCode})`)
			}
			catch (error) {
				console.error(`Error reading or parsing config for ${appId}:`, error)
			}
		}
		else {
			console.log(`Creating new config for ${appId}`)
		}

		// Write updated config
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

		// Create zip file from the app directory
		try {
			const zipPath = path.join(appSharedPath, `${appId}.zip`)
			await createZip(appPublicPath, zipPath)
		}
		catch (error) {
			console.error(`Error creating zip for ${appId}:`, error)
		}
	}

	console.log('App generation completed successfully!')
}

// Run the main function
main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
