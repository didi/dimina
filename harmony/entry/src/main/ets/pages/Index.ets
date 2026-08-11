import {
  DMPPage,
  DMPAppConfig,
  DMPApp,
  DMPPhotoPreview,
  DMPAppManager,
  DMPLaunchConfig,
  DMPOpenType,
  DMPColorUtils,
  DMPMap
} from '@didi-dimina/dimina';
import { common } from '@kit.AbilityKit';
import { MiniProgramDataSource, MiniProgramModel } from './data/MiniProgramDataSource';
import { util } from '@kit.ArkTS';

const PAGE_BACKGROUND_COLOR: string = '#F4F5F6';

@Entry
@Component
struct Index {
  private pageInfos: NavPathStack = new NavPathStack()
  private app!: DMPApp;
  @StorageProp('bottomRectHeight') safeAreaHeight: number = 0;
  @StorageProp('topRectHeight') safeAreaTop: number = 0;
  private dataSource: MiniProgramDataSource = new MiniProgramDataSource();
  curProgram?: MiniProgramModel;
  // 自动化测试钩子用：aboutToAppear 扫描列表时顺带记下待自动打开的那一项。
  private testAutoOpenItem?: MiniProgramModel;
  private static didAutoOpenForTest: boolean = false;

  aboutToAppear(): void {
    const list = getContext().resourceManager.getRawFileListSync("jsapp")
    list.forEach(folder => {
      const array = getContext().resourceManager.getRawFileContentSync(`jsapp/${folder}/config.json`)
      let textDecoder = util.TextDecoder.create('utf-8', {
        fatal: false,
        ignoreBOM: true
      });
      let config = textDecoder.decodeToString(array, {
        stream: false
      });
      if (config) {
        let configObj: Map<string, string> = JSON.parse(config)
        const appId: string = configObj["appId"] ?? ""
        const name: string = configObj["name"] ?? ""
        const model: MiniProgramModel = new MiniProgramModel(appId, name, DMPColorUtils.generateColorFromName(name))
        this.dataSource.pushData(model)
        if (appId.length > 0 && appId === (AppStorage.get<string>('testAutoOpenAppId') ?? '')) {
          this.testAutoOpenItem = model
        }
      }
    })
  }

  openDiminaApp(item: MiniProgramModel, entryPath?: string, query?: DMPMap) {
    this.curProgram = item;
    const appConfig: DMPAppConfig = new DMPAppConfig(item.name, item.appId)
    appConfig.isDebugMode = true
    this.app = DMPAppManager.sharedInstance().appWithConfig(appConfig)
    this.app.router.init(this.pageInfos)
    this.app.startPackageLoader(getContext(this) as common.UIAbilityContext)
    const launchConfig: DMPLaunchConfig = new DMPLaunchConfig()
    launchConfig.openType = DMPOpenType.NavigateTo
    if (entryPath !== undefined && entryPath.length > 0) {
      launchConfig.appEntryPath = entryPath
    }
    if (query !== undefined) {
      launchConfig.query = query
    }
    this.app.launch(launchConfig)
  }

  /**
   * 自动化测试钩子（仅 demo 宿主，非 SDK 能力）：`aa start --ps DMP_TEST_AUTO_OPEN_APPID <appId>`
   * 指定时，宿主启动后直接打开该小程序，`DMP_TEST_ENTRY_PATH` / `DMP_TEST_ENTRY_QUERY`
   * 可再指定启动页与其 query。对等物是 iOS demo 宿主 ContentView.swift 的同名环境变量钩子，
   * 目的是让端到端用例不必靠点屏幕逐层导航。不传参数时本方法直接返回，启动路径不受影响。
   *
   * 只触发一次：小程序 relaunch 会让本页重新 onAppear，无防重会用测试入口页重启小程序、
   * 打断正在进行的 relaunch。
   */
  private autoOpenAppForTestIfRequested(): void {
    if (Index.didAutoOpenForTest) {
      return
    }
    const item: MiniProgramModel | undefined = this.testAutoOpenItem
    if (item === undefined) {
      return
    }
    Index.didAutoOpenForTest = true
    const entryPath: string = AppStorage.get<string>('testEntryPath') ?? ''
    const rawQuery: string = AppStorage.get<string>('testEntryQuery') ?? ''
    const query: DMPMap = new DMPMap()
    if (rawQuery.length > 0) {
      // 写法是 a=1&b=2；启动页路径本身不接受问号，参数要走 query 字段。
      rawQuery.split('&').forEach((pair: string) => {
        const idx: number = pair.indexOf('=')
        const key: string = idx >= 0 ? pair.substring(0, idx) : pair
        if (key.length > 0) {
          query.set(key, idx >= 0 ? pair.substring(idx + 1) : '')
        }
      })
    }
    this.openDiminaApp(item, entryPath, query)
  }

  @State widthSize: number = 250
  @State heightSize: number = 100
  @State rotateAngle: number = 0
  @State flag: boolean = true

  build() {
    Navigation(this.pageInfos) {
      NavDestination() {
        this.content()
      }
      .hideTitleBar(true)
      .expandSafeArea([SafeAreaType.KEYBOARD])
      .padding({ bottom: px2vp(this.safeAreaHeight) })
      .onShown(() => {

      })
      .onHidden(() => {
      })
      .onBackPressed(() => {
        return true;
      })
      .backgroundColor(PAGE_BACKGROUND_COLOR)
    }
    .hideBackButton(true)
    .hideToolBar(true)
    .hideTitleBar(true)
    .navDestination(this.routerFactory)
    .backgroundColor(PAGE_BACKGROUND_COLOR)
    // 自动化测试钩子的触发点：等 Navigation 真正出现、NavPathStack 可用之后再自动打开，
    // 放在 aboutToAppear 里会因为导航栈尚未就绪而丢掉这次跳转。
    .onAppear(() => {
      this.autoOpenAppForTestIfRequested()
    })

  }

  @Builder
  content() {
    Column() {
      Column().height(px2vp(this.safeAreaTop)).width('100%').backgroundColor(PAGE_BACKGROUND_COLOR);
      Column() {
        Text('星河小程序').fontSize(20).fontColor(Color.Black);
      }.width('100%').padding(10);

      Column() {
        Search({ placeholder: '搜索小程序' })
          .backgroundColor(Color.White)
          .borderRadius(6)
          .padding(6)
          .margin(10)
          .onChange((value) => {
            // console.log('victor=' + value)
            this.dataSource.search(value);
          });
      };

      Text('应用列表').fontColor('#666666').fontSize(18).padding({ left: 10, top: 20, bottom: 15 }).width('100%');
      Column() {
        List({ space: 1 }) {
          LazyForEach(this.dataSource, (item: MiniProgramModel) => {
            ListItem() {
              Row() {
                Text(item.name.substring(0, 1))
                  .fontSize(20)
                  .fontColor(Color.White)
                  .width(50)
                  .height(50)
                  .textAlign(TextAlign.Center)
                  .backgroundColor(item.iconColor)
                  .borderRadius(50);
                Text(item.name).fontSize(18).fontColor('#333333').width('100%').padding({ left: 10 });
              }.padding(10).backgroundColor(Color.White);
            }.onClick(() => {
              console.log("open appId:" + item.appId);
              this.openDiminaApp(item);
            });
          }, (item: MiniProgramModel) => item.appId);
        }
        .backgroundColor(PAGE_BACKGROUND_COLOR);
      }.width('100%').flexGrow(1).backgroundColor(PAGE_BACKGROUND_COLOR);
    }.backgroundColor(PAGE_BACKGROUND_COLOR).height('100%')
  }

  @Builder
  routerFactory(name: string, paramMap: Map<string, Object>) {
    if (name == DMPPage.ROUTE_NAME) {
      DMPPage({ uri: name, param: paramMap });
    } else if (name == DMPPhotoPreview.ROUTE_NAME) {
      DMPPhotoPreview({ uri: name, param: paramMap });
    }
  }
}
