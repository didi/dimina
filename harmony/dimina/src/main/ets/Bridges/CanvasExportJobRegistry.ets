export class CanvasExportJob {
  readonly appId: string
  readonly owner: string
  readonly chars: number
  payload: string | null
  started: boolean = false
  cancelled: boolean = false

  constructor(appId: string, owner: string, payload: string) {
    this.appId = appId
    this.owner = owner
    this.payload = payload
    this.chars = payload.length
  }
}

export class CanvasExportJobRegistry {
  private static readonly MAX_IMAGE_BYTES: number = 32 * 1024 * 1024
  private static readonly MAX_BASE64_CHARS: number =
    Math.floor(CanvasExportJobRegistry.MAX_IMAGE_BYTES * 4 / 3) + 8
  private static readonly MAX_PENDING_COUNT: number = 2
  private static readonly MAX_PENDING_CHARS: number =
    CanvasExportJobRegistry.MAX_PENDING_COUNT * CanvasExportJobRegistry.MAX_BASE64_CHARS
  private static jobs: Map<string, CanvasExportJob[]> = new Map()
  private static owners: Map<string, string> = new Map()

  static reserve(appId: string, owner: string, payload: string): CanvasExportJob | null {
    // owner 由 appIndex + runtimeGeneration 组成。旧 runtime 的 bridge 消息即使迟到，也不能
    // 把 registry 的当前 owner 回滚并取消新 runtime 的任务。
    if (CanvasExportJobRegistry.owners.get(appId) !== owner) return null
    const jobs = CanvasExportJobRegistry.jobs.get(appId) ?? []
    const pendingChars = jobs.reduce((total: number, job: CanvasExportJob) => total + job.chars, 0)
    if (jobs.length >= CanvasExportJobRegistry.MAX_PENDING_COUNT
      || pendingChars + payload.length > CanvasExportJobRegistry.MAX_PENDING_CHARS) {
      return null
    }
    const job = new CanvasExportJob(appId, owner, payload)
    jobs.push(job)
    CanvasExportJobRegistry.jobs.set(appId, jobs)
    return job
  }

  static begin(job: CanvasExportJob): string | null {
    if (job.cancelled || !(CanvasExportJobRegistry.jobs.get(job.appId) ?? []).includes(job)) return null
    job.started = true
    const payload = job.payload
    job.payload = null
    return payload
  }

  static finish(job: CanvasExportJob) {
    job.payload = null
    const remaining = (CanvasExportJobRegistry.jobs.get(job.appId) ?? [])
      .filter((candidate: CanvasExportJob) => candidate !== job)
    if (remaining.length > 0) CanvasExportJobRegistry.jobs.set(job.appId, remaining)
    else CanvasExportJobRegistry.jobs.delete(job.appId)
  }

  static activate(appId: string, owner: string) {
    if (CanvasExportJobRegistry.owners.get(appId) === owner) return
    CanvasExportJobRegistry.owners.set(appId, owner)
    const jobs = CanvasExportJobRegistry.jobs.get(appId) ?? []
    const running: CanvasExportJob[] = []
    jobs.forEach((job: CanvasExportJob) => {
      if (job.started) {
        running.push(job)
      } else {
        job.cancelled = true
        job.payload = null
      }
    })
    if (running.length > 0) CanvasExportJobRegistry.jobs.set(appId, running)
    else CanvasExportJobRegistry.jobs.delete(appId)
  }

  static deactivate(appId: string, owner: string) {
    if (CanvasExportJobRegistry.owners.get(appId) !== owner) return
    CanvasExportJobRegistry.owners.delete(appId)
    const jobs = CanvasExportJobRegistry.jobs.get(appId) ?? []
    const running: CanvasExportJob[] = []
    jobs.forEach((job: CanvasExportJob) => {
      if (job.started) {
        running.push(job)
      } else {
        job.cancelled = true
        job.payload = null
      }
    })
    if (running.length > 0) CanvasExportJobRegistry.jobs.set(appId, running)
    else CanvasExportJobRegistry.jobs.delete(appId)
  }
}
