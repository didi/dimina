export class DiminaConfig {
  private static _instance: DiminaConfig = new DiminaConfig()
  apiNamespaces: string[] = []

  private constructor() {}

  static get shared(): DiminaConfig {
    return DiminaConfig._instance
  }
}
