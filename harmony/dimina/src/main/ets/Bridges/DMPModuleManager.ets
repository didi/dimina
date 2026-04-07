import { DMPExportModule } from './DMPExportModule';
import { DMPContainerBridgesModule } from './DMPContainerBridgesModule';
import { DMPContainerBridgesModuleExt } from './DMPContainerBridgesModule+Ext';
import { DMPExtModuleHandler } from './DMPExtModuleHandler';
import { DMPLogger } from '../EventTrack/DMPLogger';
import { Tags } from '../EventTrack/Tags';
import { DMPMap } from '../Utils/DMPMap';

export abstract class DMPModuleManager {
  abstract exportModules: Map<string, DMPExportModule>

  registerModule(moduleObject: DMPContainerBridgesModule) {
    this.registerModuleByName(moduleObject, 'DMPContainerBridgesModule')
  }

  registerWebViewModule(moduleObject: DMPContainerBridgesModule) {
    this.registerModuleByName(moduleObject, 'DMWebViewBridgeModule')
  }

  registerCustomModule(moduleObject: DMPContainerBridgesModule,moduleName?:string) {
    const name = moduleName || DMPMap.getClassName(moduleObject);
    this.registerModuleByName(moduleObject, name)
  }

  /**
   * 注册宿主第三方扩展模块。
   * 首次调用时会自动创建 DMPContainerBridgesModuleExt 并绑定到当前 app。
   * 默认不支持（Worker 线程等场景），子类按需覆盖。
   *
   * @param moduleName  宿主模块名（对应 extBridge/extOnBridge 中的 module 参数）
   * @param handler     模块处理函数
   */
  registerExtModule(_moduleName: string, _handler: DMPExtModuleHandler): void {}

  /**
   * 获取当前 ext bridge 模块实例（未注册或不支持时返回 null）。
   * 默认返回 null，子类按需覆盖。
   */
  getExtBridgeModule(): DMPContainerBridgesModuleExt | null {
    return null;
  }

  getModuleObjectByMethodName(methodName: string): DMPContainerBridgesModule | null {
    return this.getModuleObjectByMethodNameAndModuleName(methodName, 'DMPContainerBridgesModule')
  }

  getModuleObjectByMethodNameAndModuleName(methodName: string, moduleName: string): DMPContainerBridgesModule | null {
    if (!methodName || !moduleName) {
      return null
    }
    let result: DMPContainerBridgesModule | null = null
    const module = this.getExportModuleByName(moduleName)
    if (module) {
      const exportMethods = module.exportMethods
      result = exportMethods[methodName]
    }
    return result
  }

  getExportModuleByName(moduleName: string): DMPExportModule | null {
    if (!moduleName) {
      return null
    }
    return this.exportModules[moduleName]
  }

  private registerModuleByName(moduleObject: DMPContainerBridgesModule, moduleName: string) {
    DMPLogger.d(Tags.BRIDGE, "registerMethodsWithModuleName moduleName=" + moduleName)
    const methodList = moduleObject.getExportMethods()
    if (!methodList || !moduleObject) {
      return
    }
    DMPLogger.d(Tags.BRIDGE, "registerMethodsWithModuleName >" + methodList.toString())
    let module = this.getExportModuleByName(moduleName)
    if (!module) {
      module = new DMPExportModule(moduleName, moduleName)
      this.exportModules[moduleName] = module
    }
    if (module) {
      const exportMethods = module.exportMethods
      methodList.forEach((methodName) => {
        exportMethods[methodName] = moduleObject
      })
    }
  }
}






