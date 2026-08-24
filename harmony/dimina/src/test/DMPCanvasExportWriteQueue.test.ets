import { describe, expect, it } from '@ohos/hypium'
import { CanvasExportJob } from '../main/ets/Bridges/CanvasExportJobRegistry'
import { enqueueCanvasWrite } from '../main/ets/Bridges/DMPContainerBridgesModule+Canvas'

function flush(): Promise<void> {
  return new Promise<void>((resolve): void => {
    setTimeout(() => resolve(), 0)
  })
}

export default function dmpCanvasExportWriteQueueTest() {
  describe('canvas export write queue', () => {
    // 销毁只取消还没开始的任务：旧 runtime 已经进入写盘的那个任务会继续跑完。串行链按 owner 分片时，
    // 新 runtime 的任务会拿到一条空链立刻开始，两份最多 32 MB 的位图同时在内存里。
    it('holdsANewOwnersExportUntilThePreviousOwnersWriteFinishes', 0, async () => {
      const appId = `app-write-queue-${Date.now()}`
      const order: string[] = []
      let releaseOldWrite: () => void = () => {
      }
      const oldWriteGate: Promise<void> = new Promise<void>((resolve): void => {
        releaseOldWrite = () => resolve()
      })

      enqueueCanvasWrite(new CanvasExportJob(appId, '1:0', 'old'), async () => {
        order.push('old-start')
        await oldWriteGate
        order.push('old-end')
      })
      enqueueCanvasWrite(new CanvasExportJob(appId, '1:1', 'new'), async () => {
        order.push('new-start')
      })

      await flush()
      expect(order.join(',')).assertEqual('old-start')

      releaseOldWrite()
      await flush()
      expect(order.join(',')).assertEqual('old-start,old-end,new-start')
    })

    // 两个小程序之间没有共享预算，也不该互相排队。
    it('keepsExportsOfDifferentAppsIndependent', 0, async () => {
      const stamp = Date.now()
      const order: string[] = []
      let releaseFirstApp: () => void = () => {
      }
      const firstAppGate: Promise<void> = new Promise<void>((resolve): void => {
        releaseFirstApp = () => resolve()
      })

      enqueueCanvasWrite(new CanvasExportJob(`app-a-${stamp}`, '1:0', 'a'), async () => {
        order.push('a-start')
        await firstAppGate
        order.push('a-end')
      })
      enqueueCanvasWrite(new CanvasExportJob(`app-b-${stamp}`, '1:0', 'b'), async () => {
        order.push('b-start')
      })

      await flush()
      expect(order.join(',')).assertEqual('a-start,b-start')

      releaseFirstApp()
      await flush()
      expect(order.join(',')).assertEqual('a-start,b-start,a-end')
    })
  })
}
