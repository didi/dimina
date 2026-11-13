import { Dimina as NodeDimina } from '@dimina/desktop-sdk'
import { Dimina as TauriDimina } from '@dimina/desktop-sdk/tauri'
import type { DiminaWindow } from '@dimina/desktop-sdk'

async function consume() {
  const node = await NodeDimina.start({ runtimePath: '/runtime', packagesDir: '/apps', dataDir: '/data' })
  const tauri = await TauriDimina.start()
  await node.registerApi('getNetworkType', async () => ({ networkType: 'wifi' }), { appIds: ['demo'] })
  for (const sdk of [node, tauri]) {
    const app: DiminaWindow = await sdk.openApp({ appId: 'demo' })
    await app.focus()
    await app.close()
    await sdk.dispose()
  }
}
void consume
