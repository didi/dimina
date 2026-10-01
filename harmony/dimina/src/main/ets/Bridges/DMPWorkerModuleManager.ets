import { DMPExportModule } from './DMPExportModule';

import { DMPContainerBridgesModuleHttp } from './Network/DMPContainerBridgesModule+Http';
import { DMPContainerBridgesModuleStorage } from './DMPContainerBridgesModule+Storage';
import { DMPContainerBridgesModuleFile } from './DMPContainerBridgesModule+File';
import { DMPContainerBridgesModuleVideoDecoder } from './DMPContainerBridgesModule+VideoDecoder';
import { DMPModuleManager } from './DMPModuleManager';
import { WorkerAppData } from '../Service/DMPSendableObjects';

export class DMPWorkerModuleManager extends DMPModuleManager {
  exportModules: Map<string, DMPExportModule>;
  app: WorkerAppData;
  private fileModule: DMPContainerBridgesModuleFile;
  private videoDecoderModule: DMPContainerBridgesModuleVideoDecoder;

  constructor(app: WorkerAppData) {
    super();
    this.app = app;
    this.exportModules = new Map();
    const module = new DMPExportModule('DMPContainerBridgesModule', 'DMPContainerBridgesModule')
    this.exportModules['DMPContainerBridgesModule'] = module
    this.registerModule(new DMPContainerBridgesModuleHttp(app))
    this.registerModule(new DMPContainerBridgesModuleStorage(app))
    this.fileModule = new DMPContainerBridgesModuleFile(app)
    this.registerModule(this.fileModule)
    this.videoDecoderModule = new DMPContainerBridgesModuleVideoDecoder(app)
    this.registerModule(this.videoDecoderModule)

  }

  dispose(): void {
    this.fileModule.dispose()
    this.videoDecoderModule.dispose()
  }
}



