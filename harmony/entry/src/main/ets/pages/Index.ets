import {
  DMPPage,
  DMPAppConfig,
  DMPApp,
  DMPPhotoPreview,
  DMPAppManager,
  DMPLaunchConfig,
  DMPOpenType,
  DMPColorUtils
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
        this.dataSource.pushData(new MiniProgramModel(appId, name, DMPColorUtils.generateColorFromName(name)))
      }
    })
  }

  openDiminaApp(item: MiniProgramModel) {
    this.curProgram = item;
    const appConfig: DMPAppConfig = new DMPAppConfig(item.name, item.appId)
    appConfig.isDebugMode = true
    this.app = DMPAppManager.sharedInstance().appWithConfig(appConfig)
    this.app.router.init(this.pageInfos)
    this.app.startPackageLoader(getContext(this) as common.UIAbilityContext)
    const launchConfig: DMPLaunchConfig = new DMPLaunchConfig()
    launchConfig.openType = DMPOpenType.NavigateTo
    this.app.launch(launchConfig)
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
