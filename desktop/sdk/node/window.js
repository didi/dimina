export class DiminaWindow {
  constructor(host, info) {
    this.host = host
    this.id = info.id
    this.appId = info.appId
    this.name = info.name
    this.ready = info.ready
  }
  focus() { return this.host.focus(this.id) }
  close() { return this.host.closeApp(this.id) }
}
